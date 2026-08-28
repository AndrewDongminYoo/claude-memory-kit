import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import {
  fingerprintDescriptor,
  isTranscriptFingerprint,
} from "./fingerprint.ts";

export class TranscriptVersionChangedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TranscriptVersionChangedError";
  }
}

class ArchiveRollbackError extends Error {
  constructor(original: unknown, rollback: unknown) {
    super(
      `archive rollback failed after ${
        original instanceof Error ? original.message : String(original)
      }: ${rollback instanceof Error ? rollback.message : String(rollback)}`,
    );
    this.name = "ArchiveRollbackError";
  }
}

interface ArchiveOptions {
  transcriptPath: string;
  slug: string;
  projectsDir: string;
  archiveDir: string;
  existingArchivePath?: string;
  expectedFingerprint: string;
  onDestinationReserved?: (destination: string) => void;
  onDestinationReady?: (destination: string) => void;
}

function assertSingleSegmentSlug(slug: string): void {
  if (
    slug.length === 0 ||
    slug === "." ||
    slug === ".." ||
    slug.includes("/") ||
    slug.includes("\\") ||
    path.isAbsolute(slug)
  ) {
    throw new Error("slug must be a single path segment");
  }
}

function assertDirectory(pathname: string, label: string): fs.Stats {
  const stat = fs.lstatSync(pathname);
  if (stat.isSymbolicLink()) {
    throw new Error(`${label} must not be a symbolic link: ${pathname}`);
  }
  if (!stat.isDirectory()) {
    throw new Error(`${label} must be a directory: ${pathname}`);
  }
  return stat;
}

function assertPrivateDirectory(pathname: string, label: string): fs.Stats {
  const stat = assertDirectory(pathname, label);
  if (process.platform !== "win32" && (stat.mode & 0o022) !== 0) {
    throw new Error(
      `${label} must not be writable by group or others: ${pathname}`,
    );
  }
  return stat;
}

function sameIdentity(before: fs.Stats, after: fs.Stats): boolean {
  return before.dev === after.dev && before.ino === after.ino;
}

function assertFile(pathname: string, label: string): fs.Stats {
  const stat = fs.lstatSync(pathname);
  if (stat.isSymbolicLink()) {
    throw new Error(`${label} must not be a symbolic link: ${pathname}`);
  }
  if (!stat.isFile()) {
    throw new Error(`${label} must be a file: ${pathname}`);
  }
  return stat;
}

function sameFile(before: fs.Stats, after: fs.Stats): boolean {
  return (
    sameIdentity(before, after) &&
    before.size === after.size &&
    before.mtimeMs === after.mtimeMs
  );
}

function openValidatedFile(
  pathname: string,
  expected: fs.Stats,
  label: string,
  rejectVersionChange = false,
): number {
  const descriptor = fs.openSync(
    pathname,
    fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW,
  );
  try {
    if (!sameFile(expected, fs.fstatSync(descriptor))) {
      const message = `${label} changed during archiving`;
      throw rejectVersionChange
        ? new TranscriptVersionChangedError(message)
        : new Error(message);
    }
    return descriptor;
  } catch (error) {
    fs.closeSync(descriptor);
    throw error;
  }
}

function descriptorContentsMatch(left: number, right: number): boolean {
  const leftBuffer = Buffer.allocUnsafe(64 * 1024);
  const rightBuffer = Buffer.allocUnsafe(64 * 1024);
  for (;;) {
    const leftBytes = fs.readSync(left, leftBuffer, 0, leftBuffer.length, null);
    const rightBytes = fs.readSync(
      right,
      rightBuffer,
      0,
      rightBuffer.length,
      null,
    );
    if (leftBytes !== rightBytes) {
      return false;
    }
    if (leftBytes === 0) {
      return true;
    }
    if (
      !leftBuffer
        .subarray(0, leftBytes)
        .equals(rightBuffer.subarray(0, rightBytes))
    ) {
      return false;
    }
  }
}

function copyFromDescriptor(source: number, destination: string): string {
  const destinationDescriptor = fs.openSync(destination, "wx", 0o600);
  const buffer = Buffer.allocUnsafe(64 * 1024);
  const hash = createHash("sha256");
  try {
    for (;;) {
      const bytesRead = fs.readSync(source, buffer, 0, buffer.length, null);
      if (bytesRead === 0) {
        break;
      }
      hash.update(buffer.subarray(0, bytesRead));
      let offset = 0;
      while (offset < bytesRead) {
        offset += fs.writeSync(
          destinationDescriptor,
          buffer,
          offset,
          bytesRead - offset,
        );
      }
    }
    fs.fsyncSync(destinationDescriptor);
    return hash.digest("hex");
  } finally {
    fs.closeSync(destinationDescriptor);
  }
}

function syncFile(pathname: string): void {
  const descriptor = fs.openSync(
    pathname,
    fs.constants.O_WRONLY | fs.constants.O_NOFOLLOW,
  );
  try {
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}

function syncDirectory(pathname: string): void {
  if (process.platform === "win32") {
    return;
  }
  const descriptor = fs.openSync(
    pathname,
    fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW,
  );
  try {
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}

function removeSource(source: string, projectSlugDir: string): void {
  fs.unlinkSync(source);
  syncDirectory(projectSlugDir);
}

function assertResolvedDirectChild(
  root: string,
  child: string,
  label: string,
): void {
  const resolvedRoot = fs.realpathSync(root);
  const resolvedChild = fs.realpathSync(child);
  if (path.dirname(resolvedChild) !== resolvedRoot) {
    throw new Error(`${label} resolves outside its configured root: ${child}`);
  }
}

function destinationName(base: string, suffix: number): string {
  if (suffix === 0) {
    return base;
  }
  const ext = path.extname(base);
  const stem = base.slice(0, base.length - ext.length);
  return `${stem}.dup${suffix}${ext}`;
}

function rollbackPublishedDestination(
  destination: string,
  destinationDir: string,
  original: unknown,
): void {
  try {
    fs.unlinkSync(destination);
    syncDirectory(destinationDir);
  } catch (rollbackError) {
    throw new ArchiveRollbackError(original, rollbackError);
  }
}

function reserveAndPublishDestination(
  temporaryPath: string,
  destinationDir: string,
  base: string,
  onDestinationReserved?: (destination: string) => void,
  onDestinationReady?: (destination: string) => void,
): string {
  for (let suffix = 0; ; suffix += 1) {
    const name = destinationName(base, suffix);
    const destination = path.join(destinationDir, name);
    let reserved = false;
    try {
      const reservationDescriptor = fs.openSync(destination, "wx", 0o600);
      reserved = true;
      let reservation: fs.Stats;
      try {
        reservation = fs.fstatSync(reservationDescriptor);
        fs.fsyncSync(reservationDescriptor);
      } finally {
        fs.closeSync(reservationDescriptor);
      }
      onDestinationReserved?.(destination);
      if (
        !sameIdentity(
          reservation,
          assertFile(destination, "archive destination"),
        )
      ) {
        throw new Error("archive destination changed during reservation");
      }
      fs.renameSync(temporaryPath, destination);
      syncFile(destination);
      syncDirectory(destinationDir);
      onDestinationReady?.(destination);
      return destination;
    } catch (error) {
      if (reserved) {
        rollbackPublishedDestination(destination, destinationDir, error);
        throw error;
      }
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        throw error;
      }
    }
  }
}

function assertUnchangedPrivateDirectory(
  pathname: string,
  expected: fs.Stats,
  label: string,
): void {
  if (!sameIdentity(expected, assertPrivateDirectory(pathname, label))) {
    throw new Error(`${label} changed during archiving`);
  }
}

function assertUnchangedSource(source: string, sourceStat: fs.Stats): void {
  if (!sameFile(sourceStat, assertFile(source, "transcript source"))) {
    throw new TranscriptVersionChangedError("source changed during archiving");
  }
}

/**
 * Moves a direct main-session transcript to a collision-safe archive destination.
 * The source remains in place until the complete archive payload exists.
 */
export function archiveTranscript(opts: ArchiveOptions): string {
  const projectsRoot = path.resolve(opts.projectsDir);
  const archiveRoot = path.resolve(opts.archiveDir);
  const source = path.resolve(opts.transcriptPath);
  assertSingleSegmentSlug(opts.slug);
  if (!isTranscriptFingerprint(opts.expectedFingerprint)) {
    throw new Error(
      "archive requires a reviewed fingerprint with a SHA-256 digest",
    );
  }

  const projectSlugDir = path.join(projectsRoot, opts.slug);
  if (path.dirname(source) !== projectSlugDir) {
    throw new Error(
      "transcript must be a direct child of the configured project slug directory",
    );
  }
  assertPrivateDirectory(projectsRoot, "projects directory");
  assertPrivateDirectory(projectSlugDir, "project slug directory");
  const sourceStat = assertFile(source, "transcript source");
  assertResolvedDirectChild(
    projectsRoot,
    projectSlugDir,
    "project slug directory",
  );
  assertResolvedDirectChild(projectSlugDir, source, "transcript source");

  assertPrivateDirectory(path.dirname(archiveRoot), "archive directory parent");
  fs.mkdirSync(archiveRoot, {
    recursive: true,
    mode: 0o700,
  });
  assertPrivateDirectory(archiveRoot, "archive directory");
  syncDirectory(path.dirname(archiveRoot));
  const archiveSlugDir = path.join(archiveRoot, opts.slug);
  fs.mkdirSync(archiveSlugDir, {
    recursive: true,
    mode: 0o700,
  });
  const archiveSlugStat = assertPrivateDirectory(
    archiveSlugDir,
    "archive slug directory",
  );
  syncDirectory(archiveRoot);
  assertResolvedDirectChild(
    archiveRoot,
    archiveSlugDir,
    "archive slug directory",
  );

  const base = path.basename(source);
  if (path.extname(base) !== ".jsonl") {
    throw new Error("transcript source must have a .jsonl extension");
  }
  const sourceDescriptor = openValidatedFile(
    source,
    sourceStat,
    "transcript source",
    true,
  );
  try {
    if (opts.existingArchivePath) {
      const existingDestination = path.resolve(opts.existingArchivePath);
      if (path.dirname(existingDestination) !== archiveSlugDir) {
        throw new Error(
          "existing archive must be a direct child of the archive slug directory",
        );
      }
      const existingStat = assertFile(existingDestination, "existing archive");
      assertResolvedDirectChild(
        archiveSlugDir,
        existingDestination,
        "existing archive",
      );
      const existingDescriptor = openValidatedFile(
        existingDestination,
        existingStat,
        "existing archive",
      );
      try {
        if (
          fingerprintDescriptor(sourceDescriptor) !== opts.expectedFingerprint
        ) {
          throw new TranscriptVersionChangedError(
            "source fingerprint changed since review",
          );
        }
        if (
          sourceStat.size !== existingStat.size ||
          !descriptorContentsMatch(sourceDescriptor, existingDescriptor)
        ) {
          throw new Error(
            "existing archive does not match the transcript source",
          );
        }
        assertUnchangedPrivateDirectory(
          archiveSlugDir,
          archiveSlugStat,
          "archive slug directory",
        );
        assertUnchangedSource(source, sourceStat);
        if (
          !sameFile(
            existingStat,
            assertFile(existingDestination, "existing archive"),
          )
        ) {
          throw new Error("existing archive changed during archiving");
        }
        syncFile(existingDestination);
        syncDirectory(archiveSlugDir);
        assertUnchangedPrivateDirectory(
          archiveSlugDir,
          archiveSlugStat,
          "archive slug directory",
        );
        removeSource(source, projectSlugDir);
        return existingDestination;
      } finally {
        fs.closeSync(existingDescriptor);
      }
    }
    assertUnchangedPrivateDirectory(
      archiveSlugDir,
      archiveSlugStat,
      "archive slug directory",
    );
    const temporaryDir = fs.mkdtempSync(
      path.join(archiveSlugDir, ".cmk-archive-"),
    );
    const temporaryPath = path.join(temporaryDir, base);
    try {
      const copiedFingerprint = copyFromDescriptor(
        sourceDescriptor,
        temporaryPath,
      );
      if (copiedFingerprint !== opts.expectedFingerprint) {
        throw new TranscriptVersionChangedError(
          "source fingerprint changed since review",
        );
      }
      assertUnchangedPrivateDirectory(
        archiveSlugDir,
        archiveSlugStat,
        "archive slug directory",
      );
      const destination = reserveAndPublishDestination(
        temporaryPath,
        archiveSlugDir,
        base,
        opts.onDestinationReserved,
        opts.onDestinationReady,
      );
      let sourceRemoved = false;
      try {
        assertUnchangedPrivateDirectory(
          archiveSlugDir,
          archiveSlugStat,
          "archive slug directory",
        );
        assertUnchangedSource(source, sourceStat);
        fs.unlinkSync(source);
        sourceRemoved = true;
        syncDirectory(projectSlugDir);
        return destination;
      } catch (error) {
        if (!sourceRemoved) {
          rollbackPublishedDestination(destination, archiveSlugDir, error);
        }
        throw error;
      }
    } finally {
      fs.rmSync(temporaryDir, { recursive: true, force: true });
    }
  } finally {
    fs.closeSync(sourceDescriptor);
  }
}

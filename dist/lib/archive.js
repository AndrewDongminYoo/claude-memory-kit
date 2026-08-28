import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { fingerprintDescriptor, isTranscriptFingerprint, } from "./fingerprint.js";
export class TranscriptVersionChangedError extends Error {
    constructor(message) {
        super(message);
        this.name = "TranscriptVersionChangedError";
    }
}
function assertSingleSegmentSlug(slug) {
    if (slug.length === 0 ||
        slug === "." ||
        slug === ".." ||
        slug.includes("/") ||
        slug.includes("\\") ||
        path.isAbsolute(slug)) {
        throw new Error("slug must be a single path segment");
    }
}
function assertDirectory(pathname, label) {
    const stat = fs.lstatSync(pathname);
    if (stat.isSymbolicLink()) {
        throw new Error(`${label} must not be a symbolic link: ${pathname}`);
    }
    if (!stat.isDirectory()) {
        throw new Error(`${label} must be a directory: ${pathname}`);
    }
    return stat;
}
function assertPrivateDirectory(pathname, label) {
    const stat = assertDirectory(pathname, label);
    if (process.platform !== "win32" && (stat.mode & 0o022) !== 0) {
        throw new Error(`${label} must not be writable by group or others: ${pathname}`);
    }
    return stat;
}
function sameIdentity(before, after) {
    return before.dev === after.dev && before.ino === after.ino;
}
function assertFile(pathname, label) {
    const stat = fs.lstatSync(pathname);
    if (stat.isSymbolicLink()) {
        throw new Error(`${label} must not be a symbolic link: ${pathname}`);
    }
    if (!stat.isFile()) {
        throw new Error(`${label} must be a file: ${pathname}`);
    }
    return stat;
}
function sameFile(before, after) {
    return (sameIdentity(before, after) &&
        before.size === after.size &&
        before.mtimeMs === after.mtimeMs);
}
function openValidatedFile(pathname, expected, label, rejectVersionChange = false) {
    const descriptor = fs.openSync(pathname, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try {
        if (!sameFile(expected, fs.fstatSync(descriptor))) {
            const message = `${label} changed during archiving`;
            throw rejectVersionChange
                ? new TranscriptVersionChangedError(message)
                : new Error(message);
        }
        return descriptor;
    }
    catch (error) {
        fs.closeSync(descriptor);
        throw error;
    }
}
function descriptorContentsMatch(left, right) {
    const leftBuffer = Buffer.allocUnsafe(64 * 1024);
    const rightBuffer = Buffer.allocUnsafe(64 * 1024);
    for (;;) {
        const leftBytes = fs.readSync(left, leftBuffer, 0, leftBuffer.length, null);
        const rightBytes = fs.readSync(right, rightBuffer, 0, rightBuffer.length, null);
        if (leftBytes !== rightBytes) {
            return false;
        }
        if (leftBytes === 0) {
            return true;
        }
        if (!leftBuffer
            .subarray(0, leftBytes)
            .equals(rightBuffer.subarray(0, rightBytes))) {
            return false;
        }
    }
}
function copyFromDescriptor(source, destination) {
    const buffer = Buffer.allocUnsafe(64 * 1024);
    const hash = createHash("sha256");
    for (;;) {
        const bytesRead = fs.readSync(source, buffer, 0, buffer.length, null);
        if (bytesRead === 0) {
            break;
        }
        hash.update(buffer.subarray(0, bytesRead));
        let offset = 0;
        while (offset < bytesRead) {
            offset += fs.writeSync(destination, buffer, offset, bytesRead - offset);
        }
    }
    fs.fsyncSync(destination);
    return hash.digest("hex");
}
function syncFile(pathname) {
    const descriptor = fs.openSync(pathname, fs.constants.O_WRONLY | fs.constants.O_NOFOLLOW);
    try {
        fs.fsyncSync(descriptor);
    }
    finally {
        fs.closeSync(descriptor);
    }
}
function syncDirectory(pathname) {
    if (process.platform === "win32") {
        return;
    }
    const descriptor = fs.openSync(pathname, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
    try {
        fs.fsyncSync(descriptor);
    }
    finally {
        fs.closeSync(descriptor);
    }
}
function removeSource(source, projectSlugDir) {
    fs.unlinkSync(source);
    syncDirectory(projectSlugDir);
}
function assertResolvedDirectChild(root, child, label) {
    const resolvedRoot = fs.realpathSync(root);
    const resolvedChild = fs.realpathSync(child);
    if (path.dirname(resolvedChild) !== resolvedRoot) {
        throw new Error(`${label} resolves outside its configured root: ${child}`);
    }
}
function destinationName(base, suffix) {
    if (suffix === 0) {
        return base;
    }
    const ext = path.extname(base);
    const stem = base.slice(0, base.length - ext.length);
    return `${stem}.dup${suffix}${ext}`;
}
function assertPublishedDestination(destination, staging) {
    if (!sameIdentity(staging, assertFile(destination, "archive destination"))) {
        throw new Error("archive destination changed during publishing");
    }
}
function assertStagingPayload(temporaryPath, staging) {
    if (!sameIdentity(staging, assertFile(temporaryPath, "archive staging payload"))) {
        throw new Error("archive staging payload changed during publishing");
    }
}
function publishDestination(temporaryPath, destinationDir, base, staging, onDestinationReserved, onDestinationReady) {
    for (let suffix = 0;; suffix += 1) {
        const name = destinationName(base, suffix);
        const destination = path.join(destinationDir, name);
        assertStagingPayload(temporaryPath, staging);
        try {
            fs.linkSync(temporaryPath, destination);
        }
        catch (error) {
            if (error.code !== "EEXIST") {
                throw error;
            }
            continue;
        }
        onDestinationReserved?.(destination);
        assertPublishedDestination(destination, staging);
        syncDirectory(destinationDir);
        assertPublishedDestination(destination, staging);
        onDestinationReady?.(destination);
        assertPublishedDestination(destination, staging);
        return destination;
    }
}
function assertUnchangedPrivateDirectory(pathname, expected, label) {
    if (!sameIdentity(expected, assertPrivateDirectory(pathname, label))) {
        throw new Error(`${label} changed during archiving`);
    }
}
function assertUnchangedSource(source, sourceStat) {
    if (!sameFile(sourceStat, assertFile(source, "transcript source"))) {
        throw new TranscriptVersionChangedError("source changed during archiving");
    }
}
/**
 * Moves a direct main-session transcript to a collision-safe archive destination.
 * The source remains in place until the complete archive payload exists.
 */
export function archiveTranscript(opts) {
    const projectsRoot = path.resolve(opts.projectsDir);
    const archiveRoot = path.resolve(opts.archiveDir);
    const source = path.resolve(opts.transcriptPath);
    assertSingleSegmentSlug(opts.slug);
    if (!isTranscriptFingerprint(opts.expectedFingerprint)) {
        throw new Error("archive requires a reviewed fingerprint with a SHA-256 digest");
    }
    const projectSlugDir = path.join(projectsRoot, opts.slug);
    if (path.dirname(source) !== projectSlugDir) {
        throw new Error("transcript must be a direct child of the configured project slug directory");
    }
    assertPrivateDirectory(projectsRoot, "projects directory");
    assertPrivateDirectory(projectSlugDir, "project slug directory");
    const sourceStat = assertFile(source, "transcript source");
    assertResolvedDirectChild(projectsRoot, projectSlugDir, "project slug directory");
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
    const archiveSlugStat = assertPrivateDirectory(archiveSlugDir, "archive slug directory");
    syncDirectory(archiveRoot);
    assertResolvedDirectChild(archiveRoot, archiveSlugDir, "archive slug directory");
    const base = path.basename(source);
    if (path.extname(base) !== ".jsonl") {
        throw new Error("transcript source must have a .jsonl extension");
    }
    const sourceDescriptor = openValidatedFile(source, sourceStat, "transcript source", true);
    try {
        if (opts.existingArchivePath) {
            const existingDestination = path.resolve(opts.existingArchivePath);
            if (path.dirname(existingDestination) !== archiveSlugDir) {
                throw new Error("existing archive must be a direct child of the archive slug directory");
            }
            const existingStat = assertFile(existingDestination, "existing archive");
            assertResolvedDirectChild(archiveSlugDir, existingDestination, "existing archive");
            const existingDescriptor = openValidatedFile(existingDestination, existingStat, "existing archive");
            try {
                if (fingerprintDescriptor(sourceDescriptor) !== opts.expectedFingerprint) {
                    throw new TranscriptVersionChangedError("source fingerprint changed since review");
                }
                if (sourceStat.size !== existingStat.size ||
                    !descriptorContentsMatch(sourceDescriptor, existingDescriptor)) {
                    throw new Error("existing archive does not match the transcript source");
                }
                assertUnchangedPrivateDirectory(archiveSlugDir, archiveSlugStat, "archive slug directory");
                assertUnchangedSource(source, sourceStat);
                if (!sameFile(existingStat, assertFile(existingDestination, "existing archive"))) {
                    throw new Error("existing archive changed during archiving");
                }
                syncFile(existingDestination);
                syncDirectory(archiveSlugDir);
                assertUnchangedPrivateDirectory(archiveSlugDir, archiveSlugStat, "archive slug directory");
                removeSource(source, projectSlugDir);
                return existingDestination;
            }
            finally {
                fs.closeSync(existingDescriptor);
            }
        }
        assertUnchangedPrivateDirectory(archiveSlugDir, archiveSlugStat, "archive slug directory");
        const temporaryDir = fs.mkdtempSync(path.join(archiveSlugDir, ".cmk-archive-"));
        const temporaryPath = path.join(temporaryDir, base);
        try {
            const temporaryDescriptor = fs.openSync(temporaryPath, "wx", 0o600);
            try {
                const copiedFingerprint = copyFromDescriptor(sourceDescriptor, temporaryDescriptor);
                if (copiedFingerprint !== opts.expectedFingerprint) {
                    throw new TranscriptVersionChangedError("source fingerprint changed since review");
                }
                const staging = fs.fstatSync(temporaryDescriptor);
                assertUnchangedPrivateDirectory(archiveSlugDir, archiveSlugStat, "archive slug directory");
                const destination = publishDestination(temporaryPath, archiveSlugDir, base, staging, opts.onDestinationReserved, opts.onDestinationReady);
                assertUnchangedPrivateDirectory(archiveSlugDir, archiveSlugStat, "archive slug directory");
                assertUnchangedSource(source, sourceStat);
                fs.unlinkSync(source);
                syncDirectory(projectSlugDir);
                return destination;
            }
            finally {
                fs.closeSync(temporaryDescriptor);
            }
        }
        finally {
            fs.rmSync(temporaryDir, { recursive: true, force: true });
        }
    }
    finally {
        fs.closeSync(sourceDescriptor);
    }
}

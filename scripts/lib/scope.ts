import fs from "node:fs";
import path from "node:path";

export const SCOPE_SLUG_PREFIXES_ENV = "CMK_SCOPE_SLUG_PREFIXES";

/**
 * Parse the explicit project-slug allowlist shared by every transcript CLI.
 * An omitted or empty value is unsafe because it could include another account.
 */
export function parseScopeSlugPrefixes(
  value: string | undefined = process.env[SCOPE_SLUG_PREFIXES_ENV],
): string[] {
  const prefixes = (value ?? "")
    .split(",")
    .map((prefix) => prefix.trim())
    .filter(Boolean);
  if (prefixes.length === 0) {
    throw new Error(
      `${SCOPE_SLUG_PREFIXES_ENV} is required and must not be empty`,
    );
  }
  return [...new Set(prefixes)];
}

export function isSlugInScope(
  slug: string,
  prefixes: readonly string[],
): boolean {
  return prefixes.some((prefix) => slug.startsWith(prefix));
}

export function isSingleSegmentSlug(slug: string): boolean {
  return (
    slug.length > 0 &&
    slug !== "." &&
    slug !== ".." &&
    !slug.includes("/") &&
    !slug.includes("\\") &&
    !path.isAbsolute(slug)
  );
}

export function assertSingleSegmentSlug(slug: string): void {
  if (!isSingleSegmentSlug(slug)) {
    throw new Error(
      `slug ${JSON.stringify(slug)} is not a single project slug`,
    );
  }
}

export function assertSlugInScope(
  slug: string,
  prefixes: readonly string[],
): void {
  assertSingleSegmentSlug(slug);
  if (!isSlugInScope(slug, prefixes)) {
    throw new Error(
      `slug ${JSON.stringify(slug)} is outside ${SCOPE_SLUG_PREFIXES_ENV}`,
    );
  }
}

/** Reject a path that is not a direct projects/<slug>/*.jsonl transcript. */
export function assertDirectTranscriptPath(
  transcriptPath: string,
  slug: string,
  configuredProjectsDir: string,
): void {
  assertSingleSegmentSlug(slug);
  const projectsRoot = path.resolve(configuredProjectsDir);
  const slugDir = path.resolve(projectsRoot, slug);
  const candidate = path.resolve(transcriptPath);
  if (
    path.dirname(slugDir) !== projectsRoot ||
    path.dirname(candidate) !== slugDir ||
    path.extname(candidate) !== ".jsonl"
  ) {
    throw new Error(
      `transcript path ${JSON.stringify(transcriptPath)} is not a direct transcript for slug ${JSON.stringify(slug)}`,
    );
  }
}

function assertCurrentSafeTranscriptPath(
  transcriptPath: string,
  slug: string,
  configuredProjectsDir: string,
  openedStat?: fs.Stats,
  expectedProjectsStat?: fs.Stats,
): fs.Stats {
  assertDirectTranscriptPath(transcriptPath, slug, configuredProjectsDir);
  const projectsRoot = path.resolve(configuredProjectsDir);
  const slugDir = path.resolve(projectsRoot, slug);
  const candidate = path.resolve(transcriptPath);
  const projectsStat = fs.lstatSync(projectsRoot);
  if (projectsStat.isSymbolicLink()) {
    throw new Error("projects directory is a symbolic link");
  }
  if (!projectsStat.isDirectory()) {
    throw new Error("projects directory is not a directory");
  }
  if (
    expectedProjectsStat &&
    (projectsStat.dev !== expectedProjectsStat.dev ||
      projectsStat.ino !== expectedProjectsStat.ino)
  ) {
    throw new Error(
      "projects directory changed after the transcript was opened",
    );
  }
  const slugStat = fs.lstatSync(slugDir);
  const transcriptStat = fs.lstatSync(candidate);
  if (slugStat.isSymbolicLink() || transcriptStat.isSymbolicLink()) {
    throw new Error(
      "transcript path or project slug directory is a symbolic link",
    );
  }
  if (!slugStat.isDirectory() || !transcriptStat.isFile()) {
    throw new Error(
      "transcript path is not a regular file in a project directory",
    );
  }
  if (
    openedStat &&
    (openedStat.dev !== transcriptStat.dev ||
      openedStat.ino !== transcriptStat.ino)
  ) {
    throw new Error("transcript path changed after it was opened");
  }
  const resolvedProjectsRoot = fs.realpathSync(projectsRoot);
  const resolvedSlugDir = fs.realpathSync(slugDir);
  const resolvedCandidate = fs.realpathSync(candidate);
  if (
    path.dirname(resolvedSlugDir) !== resolvedProjectsRoot ||
    path.dirname(resolvedCandidate) !== resolvedSlugDir
  ) {
    throw new Error("transcript path resolves outside its project directory");
  }
  return projectsStat;
}

/** Reject an unsafe transcript path without requiring the file to be readable. */
export function assertSafeTranscriptPath(
  transcriptPath: string,
  slug: string,
  configuredProjectsDir: string,
): void {
  assertCurrentSafeTranscriptPath(transcriptPath, slug, configuredProjectsDir);
}

/** Open a direct transcript without following a replacement symlink. */
export function openSafeTranscriptFile(
  transcriptPath: string,
  slug: string,
  configuredProjectsDir: string,
): number {
  const candidate = path.resolve(transcriptPath);
  let descriptor: number | undefined;
  try {
    const projectsStat = assertCurrentSafeTranscriptPath(
      transcriptPath,
      slug,
      configuredProjectsDir,
    );
    descriptor = fs.openSync(
      candidate,
      fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW,
    );
    assertCurrentSafeTranscriptPath(
      transcriptPath,
      slug,
      configuredProjectsDir,
      fs.fstatSync(descriptor),
      projectsStat,
    );
    return descriptor;
  } catch (error) {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    throw error;
  }
}

/** Reject a direct transcript path when a symbolic link could redirect it. */
export function assertSafeTranscriptFile(
  transcriptPath: string,
  slug: string,
  configuredProjectsDir: string,
): void {
  const descriptor = openSafeTranscriptFile(
    transcriptPath,
    slug,
    configuredProjectsDir,
  );
  fs.closeSync(descriptor);
}

/** Read only from a descriptor that remains bound to the validated transcript. */
export function readSafeTranscriptFile(
  transcriptPath: string,
  slug: string,
  configuredProjectsDir: string,
): string {
  const descriptor = openSafeTranscriptFile(
    transcriptPath,
    slug,
    configuredProjectsDir,
  );
  try {
    return fs.readFileSync(descriptor, "utf8");
  } finally {
    fs.closeSync(descriptor);
  }
}

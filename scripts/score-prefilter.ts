import fs from "node:fs";
import path from "node:path";
import { fingerprintContents } from "./lib/fingerprint.ts";
import { projectsDir, resolveClaudeRoot } from "./lib/paths.ts";
import {
  isUnreadableTranscript,
  parseMaxPerProject,
  scoreTranscript,
  selectForDeepRead,
  SCORE_MIN,
} from "./lib/score.ts";
import {
  assertDirectTranscriptPath,
  assertSlugInScope,
  isTranscriptPathValidationError,
  openSafeTranscriptFile,
  parseScopeSlugPrefixes,
} from "./lib/scope.ts";

/**
 * CLI: score one or more transcript files (paths as args) with the cheap,
 * no-LLM prefilter. Prints one JSON object per file to stdout. Read-only.
 *
 *   tsx scripts/score-prefilter.ts <file.jsonl> [<file.jsonl> ...]
 *
 * `above` means the transcript cleared SCORE_MIN; `selected` means it also
 * survived the per-project cap and is what the deep-read step should read.
 * MAX_PER_PROJECT env overrides the cap (0 disables it).
 */
interface Row {
  path: string;
  slug: string;
  score: number;
  turns?: number;
  unreadable?: boolean;
  missing?: boolean;
  fingerprint?: string;
  error?: string;
  [key: string]: unknown;
}

function transcriptReadErrorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | undefined)?.code;
}

function isUnreadableTranscriptReadError(error: unknown): boolean {
  const code = transcriptReadErrorCode(error);
  return code === "EACCES" || code === "EPERM";
}

function unreadableRow(
  transcriptPath: string,
  slug: string,
  error: unknown,
): Row {
  return {
    path: transcriptPath,
    slug,
    score: 0,
    unreadable: true,
    error: error instanceof Error ? error.message : String(error),
  };
}

function missingRow(transcriptPath: string, slug: string, error: unknown): Row {
  return {
    path: transcriptPath,
    slug,
    score: 0,
    missing: true,
    error: error instanceof Error ? error.message : String(error),
  };
}

function main(): void {
  const scopePrefixes = parseScopeSlugPrefixes();
  const configuredProjectsDir = projectsDir(resolveClaudeRoot());
  const transcriptPaths = [
    ...new Set(
      process.argv
        .slice(2)
        .filter((argument) => !argument.startsWith("--"))
        .map((argument) => path.resolve(argument)),
    ),
  ];
  if (transcriptPaths.length === 0) {
    process.stderr.write("usage: score-prefilter <transcript.jsonl> ...\n");
    process.exit(2);
  }
  const cap = parseMaxPerProject(process.env.MAX_PER_PROJECT);
  const scopedPaths = transcriptPaths.map((transcriptPath) => {
    const slug = path.basename(path.dirname(transcriptPath));
    assertSlugInScope(slug, scopePrefixes);
    assertDirectTranscriptPath(transcriptPath, slug, configuredProjectsDir);
    return { transcriptPath, slug };
  });

  const rows: Row[] = scopedPaths.map(({ transcriptPath, slug }) => {
    let descriptor: number | undefined;
    try {
      descriptor = openSafeTranscriptFile(
        transcriptPath,
        slug,
        configuredProjectsDir,
      );
    } catch (error) {
      if (isTranscriptPathValidationError(error)) {
        if (transcriptReadErrorCode(error) === "ENOENT") {
          return missingRow(transcriptPath, slug, error);
        }
        throw error;
      }
      if (transcriptReadErrorCode(error) === "ENOENT") {
        return missingRow(transcriptPath, slug, error);
      }
      if (isUnreadableTranscriptReadError(error)) {
        return unreadableRow(transcriptPath, slug, error);
      }
      throw error;
    }
    try {
      const contents = fs.readFileSync(descriptor);
      const raw = contents.toString("utf8");
      if (isUnreadableTranscript(raw)) {
        return {
          path: transcriptPath,
          slug,
          score: 0,
          unreadable: true,
          error: "no valid JSONL transcript entries",
        };
      }
      return {
        path: transcriptPath,
        slug,
        fingerprint: fingerprintContents(contents),
        ...scoreTranscript(raw),
      };
    } catch (error) {
      if (transcriptReadErrorCode(error) === "ENOENT") {
        return missingRow(transcriptPath, slug, error);
      }
      if (isUnreadableTranscriptReadError(error)) {
        return unreadableRow(transcriptPath, slug, error);
      }
      throw error;
    } finally {
      if (descriptor !== undefined) {
        fs.closeSync(descriptor);
      }
    }
  });

  const selectedRows = selectForDeepRead(rows, cap);
  const selected = new Set(selectedRows.map((row) => row.path));
  for (const row of rows) {
    process.stdout.write(
      JSON.stringify({
        ...row,
        above: !row.unreadable && row.score >= SCORE_MIN,
        selected: selected.has(row.path),
      }) + "\n",
    );
  }

  // Without a summary the caller has to re-aggregate 500 JSON lines to learn
  // what the batch costs. Stubs get their own count because they dominate a
  // real corpus (375 of 583 on the 2026-08-05 run) and explain a low yield
  // that would otherwise read as a broken filter.
  const above = rows.filter(
    (r) => !r.unreadable && r.score >= SCORE_MIN,
  ).length;
  const stubs = rows.filter((r) => r.turns !== undefined && r.turns < 3).length;
  const projects = new Set(selectedRows.map((row) => row.slug)).size;
  process.stderr.write(
    `${rows.length} scored | ${above} above SCORE_MIN=${SCORE_MIN} | ` +
      `${selected.size} selected across ${projects} project(s) ` +
      `(MAX_PER_PROJECT=${cap}) | ${stubs} stub(s) (<3 turns)\n`,
  );
}

main();

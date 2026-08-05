import fs from "node:fs";
import {
  scoreTranscript,
  selectForDeepRead,
  MAX_PER_PROJECT,
  SCORE_MIN,
} from "./lib/score.ts";

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
  score: number;
  turns?: number;
  error?: string;
  [key: string]: unknown;
}

function main(): void {
  const paths = process.argv.slice(2).filter((a) => !a.startsWith("--"));
  if (paths.length === 0) {
    process.stderr.write("usage: score-prefilter <transcript.jsonl> ...\n");
    process.exit(2);
  }
  const cap = Number(process.env.MAX_PER_PROJECT ?? MAX_PER_PROJECT);
  if (!Number.isFinite(cap)) {
    throw new Error(`invalid MAX_PER_PROJECT: ${process.env.MAX_PER_PROJECT}`);
  }

  const rows: Row[] = paths.map((path) => {
    try {
      return { path, ...scoreTranscript(fs.readFileSync(path, "utf8")) };
    } catch (err) {
      // An unreadable transcript scores 0 and is reported, never fatal — one
      // bad file must not sink a 500-file batch.
      return {
        path,
        score: 0,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  });

  const selected = new Set(selectForDeepRead(rows, cap).map((r) => r.path));
  for (const row of rows) {
    process.stdout.write(
      JSON.stringify({
        ...row,
        above: row.score >= SCORE_MIN,
        selected: selected.has(row.path),
      }) + "\n",
    );
  }

  // Without a summary the caller has to re-aggregate 500 JSON lines to learn
  // what the batch costs. Stubs get their own count because they dominate a
  // real corpus (375 of 583 on the 2026-08-05 run) and explain a low yield
  // that would otherwise read as a broken filter.
  const above = rows.filter((r) => r.score >= SCORE_MIN).length;
  const stubs = rows.filter((r) => r.turns !== undefined && r.turns < 3).length;
  const projects = new Set([...selected].map((p) => p.split("/").at(-2))).size;
  process.stderr.write(
    `${rows.length} scored | ${above} above SCORE_MIN=${SCORE_MIN} | ` +
      `${selected.size} selected across ${projects} project(s) ` +
      `(MAX_PER_PROJECT=${cap}) | ${stubs} stub(s) (<3 turns)\n`,
  );
}

main();

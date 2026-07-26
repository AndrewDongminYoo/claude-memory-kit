import fs from "node:fs";
import { scoreTranscript, SCORE_MIN } from "./lib/score.ts";

/**
 * CLI: score one or more transcript files (paths as args) with the cheap,
 * no-LLM prefilter. Prints one JSON object per file to stdout. Read-only.
 *
 *   tsx scripts/score-prefilter.ts <file.jsonl> [<file.jsonl> ...]
 */
function main(): void {
  const paths = process.argv.slice(2).filter((a) => !a.startsWith("--"));
  if (paths.length === 0) {
    process.stderr.write("usage: score-prefilter <transcript.jsonl> ...\n");
    process.exit(2);
  }
  for (const p of paths) {
    let result;
    try {
      result = scoreTranscript(fs.readFileSync(p, "utf8"));
    } catch (err) {
      process.stdout.write(
        JSON.stringify({
          path: p,
          error: err instanceof Error ? err.message : String(err),
        }) + "\n",
      );
      continue;
    }
    process.stdout.write(
      JSON.stringify({ path: p, above: result.score >= SCORE_MIN, ...result }) +
        "\n",
    );
  }
}

main();

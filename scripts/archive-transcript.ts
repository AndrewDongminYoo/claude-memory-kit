import { resolveClaudeRoot, archiveDir } from "./lib/paths.ts";
import { archiveTranscript } from "./lib/archive.ts";

/**
 * CLI: soft-archive one processed transcript.
 *   tsx scripts/archive-transcript.ts <transcript.jsonl> <slug>
 * Moves the file under ~/.claude/.transcript-archive/<slug>/; never deletes bytes.
 */
function main(): void {
  const [transcriptPath, slug] = process.argv.slice(2);
  if (!transcriptPath || !slug) {
    process.stderr.write(
      "usage: archive-transcript <transcript.jsonl> <slug>\n",
    );
    process.exit(2);
  }
  const dest = archiveTranscript({
    transcriptPath,
    slug,
    archiveDir: archiveDir(resolveClaudeRoot()),
  });
  process.stdout.write(dest + "\n");
}

main();

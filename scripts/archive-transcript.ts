import { resolveClaudeRoot, archiveDir, projectsDir } from "./lib/paths.ts";
import { archiveTranscript } from "./lib/archive.ts";
import { assertSlugInScope, parseScopeSlugPrefixes } from "./lib/scope.ts";

/**
 * CLI: soft-archive one processed transcript.
 *   tsx scripts/archive-transcript.ts <transcript.jsonl> <slug>
 * Moves the file under ~/.claude/.transcript-archive/<slug>/; never deletes bytes.
 */
function main(): void {
  const scopePrefixes = parseScopeSlugPrefixes();
  const [transcriptPath, slug] = process.argv.slice(2);
  if (!transcriptPath || !slug) {
    process.stderr.write(
      "usage: archive-transcript <transcript.jsonl> <slug>\n",
    );
    process.exit(2);
  }
  assertSlugInScope(slug, scopePrefixes);
  const dest = archiveTranscript({
    transcriptPath,
    slug,
    projectsDir: projectsDir(resolveClaudeRoot()),
    archiveDir: archiveDir(resolveClaudeRoot()),
  });
  process.stdout.write(dest + "\n");
}

main();

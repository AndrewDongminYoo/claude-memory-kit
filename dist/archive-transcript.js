import { resolveClaudeRoot, archiveDir, projectsDir } from "./lib/paths.js";
import { archiveTranscript } from "./lib/archive.js";
import { assertSlugInScope, parseScopeSlugPrefixes } from "./lib/scope.js";
/**
 * CLI: soft-archive one processed transcript.
 *   tsx scripts/archive-transcript.ts <transcript.jsonl> <slug>
 * Moves the file under ~/.claude/.transcript-archive/<slug>/; never deletes bytes.
 */
function main() {
    const scopePrefixes = parseScopeSlugPrefixes();
    const [transcriptPath, slug] = process.argv.slice(2);
    if (!transcriptPath || !slug) {
        process.stderr.write("usage: archive-transcript <transcript.jsonl> <slug>\n");
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

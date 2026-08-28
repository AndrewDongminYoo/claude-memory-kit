import { archiveDir, ledgerPath, projectsDir, resolveClaudeRoot, } from "./lib/paths.js";
import { finalizeTranscript } from "./lib/finalize.js";
import { assertDirectTranscriptPath, assertSlugInScope, parseScopeSlugPrefixes, } from "./lib/scope.js";
const outcomes = new Set([
    "memory-written",
    "proposed-rejected",
    "skipped-low-score",
    "unreadable",
]);
function main() {
    const scopePrefixes = parseScopeSlugPrefixes();
    const [transcriptPath, slug, scoreInput, outcomeInput, ...memoryWritten] = process.argv.slice(2);
    const score = Number(scoreInput);
    if (!transcriptPath ||
        !slug ||
        !Number.isFinite(score) ||
        !outcomeInput ||
        !outcomes.has(outcomeInput)) {
        process.stderr.write("usage: finalize-transcript <transcript.jsonl> <slug> <score> <outcome> [memory.md ...]\n");
        process.exit(2);
    }
    assertSlugInScope(slug, scopePrefixes);
    const root = resolveClaudeRoot();
    const configuredProjectsDir = projectsDir(root);
    assertDirectTranscriptPath(transcriptPath, slug, configuredProjectsDir);
    const result = finalizeTranscript({
        transcriptPath,
        slug,
        score,
        outcome: outcomeInput,
        memoryWritten,
        projectsDir: configuredProjectsDir,
        archiveDir: archiveDir(root),
        ledgerFile: ledgerPath(root),
        scopePrefixes,
    });
    process.stdout.write(result.archivePath ? `${result.archivePath}\n` : "\n");
}
main();

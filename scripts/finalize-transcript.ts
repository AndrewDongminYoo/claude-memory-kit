import {
  archiveDir,
  ledgerPath,
  projectsDir,
  resolveClaudeRoot,
} from "./lib/paths.ts";
import { finalizeTranscript } from "./lib/finalize.ts";
import type { Outcome } from "./lib/ledger.ts";
import {
  assertDirectTranscriptPath,
  assertSlugInScope,
  parseScopeSlugPrefixes,
} from "./lib/scope.ts";

const outcomes = new Set<Outcome>([
  "memory-written",
  "proposed-rejected",
  "skipped-low-score",
  "unreadable",
]);

function main(): void {
  const scopePrefixes = parseScopeSlugPrefixes();
  const [transcriptPath, slug, scoreInput, outcomeInput, ...remainingArgs] =
    process.argv.slice(2);
  const score = Number(scoreInput);
  const expectedFingerprint =
    outcomeInput === "unreadable" ? undefined : remainingArgs.shift();
  if (
    !transcriptPath ||
    !slug ||
    !Number.isFinite(score) ||
    !outcomeInput ||
    !outcomes.has(outcomeInput as Outcome) ||
    (outcomeInput !== "unreadable" && !expectedFingerprint)
  ) {
    process.stderr.write(
      "usage: finalize-transcript <transcript.jsonl> <slug> <score> <outcome> [fingerprint] [memory.md ...]\n",
    );
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
    outcome: outcomeInput as Outcome,
    memoryWritten: remainingArgs,
    projectsDir: configuredProjectsDir,
    archiveDir: archiveDir(root),
    ledgerFile: ledgerPath(root),
    scopePrefixes,
    expectedFingerprint,
  });
  process.stdout.write(result.archivePath ? `${result.archivePath}\n` : "\n");
}

main();

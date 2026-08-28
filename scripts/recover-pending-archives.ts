import {
  archiveDir,
  ledgerPath,
  projectsDir,
  resolveClaudeRoot,
} from "./lib/paths.ts";
import { recoverPendingArchives } from "./lib/finalize.ts";
import { parseScopeSlugPrefixes } from "./lib/scope.ts";

function main(): void {
  const scopePrefixes = parseScopeSlugPrefixes();
  const root = resolveClaudeRoot();
  const result = recoverPendingArchives({
    projectsDir: projectsDir(root),
    archiveDir: archiveDir(root),
    ledgerFile: ledgerPath(root),
    scopePrefixes,
  });
  process.stdout.write(JSON.stringify(result) + "\n");
}

main();

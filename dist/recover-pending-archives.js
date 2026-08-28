import { archiveDir, ledgerPath, projectsDir, resolveClaudeRoot, } from "./lib/paths.js";
import { recoverPendingArchives } from "./lib/finalize.js";
import { parseScopeSlugPrefixes } from "./lib/scope.js";
function main() {
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

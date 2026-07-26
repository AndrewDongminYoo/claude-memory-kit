import { resolveClaudeRoot, projectsDir, ledgerPath } from "./lib/paths.ts";
import { minedSessions } from "./lib/ledger.ts";
import { scanCold } from "./lib/scan.ts";

/**
 * CLI: print cold, un-mined transcript candidates as JSON to stdout.
 * COLD_DAYS env overrides the 30-day cutoff. Read-only.
 * Uses internal session timestamps by default (correct on copied / worktree
 * config dirs where mtime is bulk-reset); set CMK_MTIME_ONLY=1 to force mtime.
 */
function main(): void {
  const coldDays = Number(process.env.COLD_DAYS ?? 30);
  if (!Number.isFinite(coldDays) || coldDays < 0) {
    throw new Error(`invalid COLD_DAYS: ${process.env.COLD_DAYS}`);
  }
  const root = resolveClaudeRoot();
  const candidates = scanCold({
    projectsDir: projectsDir(root),
    minedSessions: minedSessions(ledgerPath(root)),
    coldDays,
    now: Date.now(),
    useInternalTimestamps: process.env.CMK_MTIME_ONLY !== "1",
  });
  process.stdout.write(JSON.stringify(candidates, null, 2) + "\n");
  process.stderr.write(
    `${candidates.length} cold un-mined candidate(s) (COLD_DAYS=${coldDays})\n`,
  );
}

main();

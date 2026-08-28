import { resolveClaudeRoot, projectsDir, ledgerPath } from "./lib/paths.js";
import { minedSessions } from "./lib/ledger.js";
import { scanCold } from "./lib/scan.js";
import { parseScopeSlugPrefixes } from "./lib/scope.js";
/**
 * CLI: print cold, un-mined transcript candidates as JSON to stdout.
 * COLD_DAYS env overrides the default cutoff. Read-only.
 * Uses internal session timestamps by default (correct on copied / worktree
 * config dirs where mtime is bulk-reset); set CMK_MTIME_ONLY=1 to force mtime.
 */
/**
 * Default cutoff. Deliberately below the harness transcript-retention window
 * (`cleanupPeriodDays` in settings.json, 30 by default): at 30 a transcript
 * becomes a candidate at the same moment retention deletes it, so the mining
 * window is empty by construction. Measured 2026-08-05 on a 2267-transcript
 * corpus: COLD_DAYS=30 yielded 0 candidates, COLD_DAYS=14 yielded 786.
 */
const DEFAULT_COLD_DAYS = 14;
function main() {
    const scopePrefixes = parseScopeSlugPrefixes();
    const coldDays = Number(process.env.COLD_DAYS ?? DEFAULT_COLD_DAYS);
    if (!Number.isFinite(coldDays) || coldDays < 0) {
        throw new Error(`invalid COLD_DAYS: ${process.env.COLD_DAYS}`);
    }
    const root = resolveClaudeRoot();
    const opts = {
        projectsDir: projectsDir(root),
        minedSessions: minedSessions(ledgerPath(root)),
        coldDays,
        now: Date.now(),
        scopePrefixes,
        useInternalTimestamps: process.env.CMK_MTIME_ONLY !== "1",
    };
    const candidates = scanCold(opts);
    process.stdout.write(JSON.stringify(candidates, null, 2) + "\n");
    process.stderr.write(`${candidates.length} cold un-mined candidate(s) (COLD_DAYS=${coldDays})\n`);
    // Zero candidates is a valid outcome, but it is indistinguishable from a
    // corpus that retention truncates before anything can go cold. Report the
    // observed age span so the operator can tell the two apart instead of
    // reading silence as "nothing to mine".
    if (candidates.length === 0) {
        const all = scanCold({ ...opts, coldDays: 0 });
        if (all.length === 0) {
            process.stderr.write("  corpus: no un-mined transcripts at all\n");
            return;
        }
        const ages = all.map((c) => c.ageDays);
        const oldest = Math.max(...ages);
        process.stderr.write(`  corpus: ${all.length} un-mined transcript(s), oldest ${oldest.toFixed(1)}d, ` +
            `newest ${Math.min(...ages).toFixed(1)}d\n` +
            `  nothing is older than COLD_DAYS. If the oldest age sits at your retention\n` +
            `  limit, transcripts are deleted before they go cold: raise cleanupPeriodDays\n` +
            `  in settings.json, or lower COLD_DAYS.\n`);
    }
}
main();

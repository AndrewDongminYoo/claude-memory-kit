/**
 * Recover a transcript's true session time from its internal per-entry
 * `timestamp` fields, so cold detection survives copied / worktree config dirs
 * where the file mtime was bulk-reset (a checkout/rsync touches every file to
 * one instant, understating the age of genuinely old sessions).
 */
/** Max internal `timestamp` (ms since epoch) across the transcript, or null. */
export function lastInternalTimestampMs(raw) {
    let max = null;
    for (const line of raw.split("\n")) {
        if (!line.trim())
            continue;
        let obj;
        try {
            obj = JSON.parse(line);
        }
        catch {
            continue;
        }
        if (typeof obj !== "object" || obj === null)
            continue;
        const ts = obj.timestamp;
        if (typeof ts === "string") {
            const t = Date.parse(ts);
            if (!Number.isNaN(t) && (max === null || t > max))
                max = t;
        }
    }
    return max;
}
/**
 * Effective "age basis" timestamp (ms) for a transcript: the earliest of the
 * internal session time and the file mtime. Taking the earlier one means a
 * session whose content is 14 days old counts as 14 days old even if its file
 * was touched (copied) 6 days ago. Falls back to mtime when no internal
 * timestamp is present.
 */
export function ageBasisMs(rawOrNull, mtimeMs) {
    if (rawOrNull === null)
        return mtimeMs;
    const internal = lastInternalTimestampMs(rawOrNull);
    if (internal === null)
        return mtimeMs;
    return Math.min(internal, mtimeMs);
}

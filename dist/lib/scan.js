import fs from "node:fs";
import path from "node:path";
import { fingerprintDescriptor } from "./fingerprint.js";
import { isSlugInScope, openSafeTranscriptFile, readSafeTranscriptFile, } from "./scope.js";
import { ageBasisMs } from "./timestamps.js";
const DAY_MS = 86_400_000;
function hasChangedMinedSource(transcriptPath, slug, projectsDir, archivedFingerprint) {
    try {
        const descriptor = openSafeTranscriptFile(transcriptPath, slug, projectsDir);
        try {
            return fingerprintDescriptor(descriptor) !== archivedFingerprint;
        }
        finally {
            fs.closeSync(descriptor);
        }
    }
    catch {
        return false;
    }
}
/**
 * List cold, un-mined transcripts under <projectsDir>/<slug>/*.jsonl.
 *
 * A transcript is a candidate when its age >= coldDays AND its session id is
 * not in minedSessions. With useInternalTimestamps the age uses the earlier of
 * the internal session time and mtime (reads the file); otherwise mtime only.
 */
export function scanCold(opts) {
    const { projectsDir, minedSessions, minedFingerprints, coldDays, now, scopePrefixes, useInternalTimestamps, } = opts;
    if (!fs.existsSync(projectsDir))
        return [];
    const projectsStat = fs.lstatSync(projectsDir);
    if (projectsStat.isSymbolicLink()) {
        throw new Error("projects directory is a symbolic link");
    }
    if (!projectsStat.isDirectory())
        return [];
    const out = [];
    for (const slug of fs.readdirSync(projectsDir)) {
        if (!isSlugInScope(slug, scopePrefixes))
            continue;
        const dir = path.join(projectsDir, slug);
        let dstat;
        try {
            dstat = fs.lstatSync(dir);
        }
        catch {
            continue;
        }
        if (!dstat.isDirectory())
            continue;
        for (const entry of fs.readdirSync(dir)) {
            if (!entry.endsWith(".jsonl"))
                continue;
            const full = path.join(dir, entry);
            let fstat;
            try {
                fstat = fs.lstatSync(full);
            }
            catch {
                continue;
            }
            if (!fstat.isFile())
                continue;
            let basisMs = fstat.mtimeMs;
            let ageSource = "mtime";
            if (useInternalTimestamps) {
                let raw = null;
                try {
                    raw = readSafeTranscriptFile(full, slug, projectsDir);
                }
                catch {
                    raw = null;
                }
                const basis = ageBasisMs(raw, fstat.mtimeMs);
                if (basis !== fstat.mtimeMs)
                    ageSource = "internal";
                basisMs = basis;
            }
            const ageDays = (now - basisMs) / DAY_MS;
            if (ageDays < coldDays)
                continue; // still warm
            const session_id = entry.slice(0, -".jsonl".length);
            const archivedFingerprint = minedFingerprints?.get(session_id);
            if (minedSessions.has(session_id) &&
                (!archivedFingerprint ||
                    !hasChangedMinedSource(full, slug, projectsDir, archivedFingerprint))) {
                continue;
            }
            out.push({
                session_id,
                slug,
                path: full,
                mtimeMs: fstat.mtimeMs,
                size: fstat.size,
                ageDays,
                ageSource,
            });
        }
    }
    // Oldest first — the most-cold, least-likely-to-be-resumed sessions lead.
    return out.sort((a, b) => b.ageDays - a.ageDays);
}

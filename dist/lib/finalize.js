import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { archiveTranscript, synchronizeVerifiedArchive, TranscriptVersionChangedError, } from "./archive.js";
import { fingerprintDescriptor, isTranscriptFingerprint, } from "./fingerprint.js";
import { appendLedger, appendAbortedArchive, appendCompletedArchive, appendPendingArchive, pendingArchives, } from "./ledger.js";
import { assertDirectTranscriptPath, assertSlugInScope, isSingleSegmentSlug, isSlugInScope, openSafeTranscriptFile, } from "./scope.js";
function processedAt(now) {
    return new Date(now ?? Date.now()).toISOString();
}
function sessionIdFor(transcriptPath) {
    const base = path.basename(transcriptPath);
    return base.slice(0, base.length - path.extname(base).length);
}
function ledgerRecord(options, attemptId, archivePath, archiveReady) {
    return {
        session_id: sessionIdFor(options.transcriptPath),
        slug: options.slug,
        processed_at: processedAt(options.now),
        score: options.score,
        outcome: options.outcome,
        memory_written: options.memoryWritten,
        transcript_path: path.resolve(options.transcriptPath),
        archive_path: archivePath,
        archive_ready: archiveReady,
        source_fingerprint: options.expectedFingerprint,
        attempt_id: attemptId,
    };
}
function sameFileVersion(left, right) {
    return (left.dev === right.dev &&
        left.ino === right.ino &&
        left.size === right.size &&
        left.mtimeMs === right.mtimeMs &&
        left.ctimeMs === right.ctimeMs);
}
function assertReviewedFingerprint(options) {
    if (!isTranscriptFingerprint(options.expectedFingerprint)) {
        throw new Error("finalization requires a reviewed fingerprint");
    }
    const descriptor = openSafeTranscriptFile(options.transcriptPath, options.slug, options.projectsDir);
    try {
        const before = fs.fstatSync(descriptor);
        if (fingerprintDescriptor(descriptor) !== options.expectedFingerprint) {
            throw new Error("source fingerprint changed since review");
        }
        if (!sameFileVersion(before, fs.fstatSync(descriptor))) {
            throw new Error("source changed during fingerprint validation");
        }
        return options.expectedFingerprint;
    }
    finally {
        fs.closeSync(descriptor);
    }
}
/** Records unreadable input or finalizes an archivable transcript. */
export function finalizeTranscript(options) {
    assertSlugInScope(options.slug, options.scopePrefixes);
    if (options.outcome === "unreadable") {
        assertReviewedFingerprint(options);
        appendLedger(options.ledgerFile, ledgerRecord(options));
        return {};
    }
    const expectedFingerprint = assertReviewedFingerprint(options);
    const attemptId = randomUUID();
    let pending = ledgerRecord(options, attemptId);
    appendPendingArchive(options.ledgerFile, pending);
    let archivePath;
    try {
        archivePath = archiveTranscript({
            transcriptPath: options.transcriptPath,
            slug: options.slug,
            projectsDir: options.projectsDir,
            archiveDir: options.archiveDir,
            expectedFingerprint,
            onDestinationReserved: (destination) => {
                pending = ledgerRecord(options, attemptId, destination, false);
                appendPendingArchive(options.ledgerFile, pending);
            },
            onDestinationReady: (destination) => {
                pending = ledgerRecord(options, attemptId, destination, true);
                appendPendingArchive(options.ledgerFile, pending);
            },
        });
    }
    catch (error) {
        if (error instanceof TranscriptVersionChangedError) {
            appendAbortedArchive(options.ledgerFile, pending);
        }
        throw error;
    }
    appendCompletedArchive(options.ledgerFile, ledgerRecord(options, attemptId, archivePath, true));
    return { archivePath };
}
function isRecordedArchiveFile(archivePath, slug, archiveDir) {
    if (!archivePath || !isSingleSegmentSlug(slug)) {
        return false;
    }
    const archiveRoot = path.resolve(archiveDir);
    const archiveSlugDir = path.join(archiveRoot, slug);
    const candidate = path.resolve(archivePath);
    if (path.dirname(candidate) !== archiveSlugDir || !fs.existsSync(candidate)) {
        return false;
    }
    try {
        const rootStat = fs.lstatSync(archiveRoot);
        const slugStat = fs.lstatSync(archiveSlugDir);
        const archiveStat = fs.lstatSync(candidate);
        if (rootStat.isSymbolicLink() ||
            !rootStat.isDirectory() ||
            slugStat.isSymbolicLink() ||
            !slugStat.isDirectory() ||
            archiveStat.isSymbolicLink() ||
            !archiveStat.isFile()) {
            return false;
        }
        const resolvedRoot = fs.realpathSync(archiveRoot);
        const resolvedSlugDir = fs.realpathSync(archiveSlugDir);
        return (path.dirname(resolvedSlugDir) === resolvedRoot &&
            path.dirname(fs.realpathSync(candidate)) === resolvedSlugDir);
    }
    catch {
        return false;
    }
}
function recordedArchiveMatchesFingerprint(archivePath, expectedFingerprint) {
    try {
        const expectedStat = fs.lstatSync(archivePath);
        if (expectedStat.isSymbolicLink() || !expectedStat.isFile()) {
            return false;
        }
        const descriptor = fs.openSync(archivePath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
        try {
            const openedStat = fs.fstatSync(descriptor);
            return (openedStat.dev === expectedStat.dev &&
                openedStat.ino === expectedStat.ino &&
                fingerprintDescriptor(descriptor) === expectedFingerprint);
        }
        finally {
            fs.closeSync(descriptor);
        }
    }
    catch {
        return false;
    }
}
function completionRecord(record, archivePath, now, archiveReady) {
    return {
        ...record,
        processed_at: processedAt(now),
        archive_path: archivePath,
        archive_ready: archiveReady,
    };
}
/** Completes pending archives without reading or writing any memory file. */
export function recoverPendingArchives(options) {
    const result = {
        completed: 0,
        skippedOutOfScope: 0,
        unresolved: [],
    };
    for (const record of pendingArchives(options.ledgerFile)) {
        if (!isSlugInScope(record.slug, options.scopePrefixes)) {
            result.skippedOutOfScope += 1;
            continue;
        }
        try {
            assertDirectTranscriptPath(record.transcript_path, record.slug, options.projectsDir);
            const recordedArchivePath = record.archive_path;
            if (!isTranscriptFingerprint(record.source_fingerprint)) {
                result.unresolved.push({
                    sessionId: record.session_id,
                    reason: "pending archive has no reviewed source fingerprint",
                });
                continue;
            }
            const expectedFingerprint = record.source_fingerprint;
            const recordedArchive = isRecordedArchiveFile(recordedArchivePath, record.slug, options.archiveDir);
            if (recordedArchive) {
                const matchesFingerprint = recordedArchiveMatchesFingerprint(recordedArchivePath, expectedFingerprint);
                if (!matchesFingerprint && record.archive_ready === false) {
                    const recordedStat = fs.lstatSync(recordedArchivePath);
                    if (recordedStat.size === 0) {
                        // The durable reservation has no payload yet, so make a new archive.
                    }
                    else {
                        result.unresolved.push({
                            sessionId: record.session_id,
                            reason: "reserved archive does not match the reviewed fingerprint",
                        });
                        continue;
                    }
                }
                else if (!matchesFingerprint) {
                    result.unresolved.push({
                        sessionId: record.session_id,
                        reason: "recorded archive does not match the reviewed fingerprint",
                    });
                    continue;
                }
                else {
                    synchronizeVerifiedArchive(recordedArchivePath, record.slug, options.archiveDir, expectedFingerprint);
                    appendCompletedArchive(options.ledgerFile, completionRecord(record, recordedArchivePath, options.now, true));
                    result.completed += 1;
                    continue;
                }
            }
            if (fs.existsSync(record.transcript_path)) {
                const archivePath = archiveTranscript({
                    transcriptPath: record.transcript_path,
                    slug: record.slug,
                    projectsDir: options.projectsDir,
                    archiveDir: options.archiveDir,
                    expectedFingerprint,
                    onDestinationReserved: (destination) => {
                        appendPendingArchive(options.ledgerFile, completionRecord(record, destination, options.now, false));
                    },
                    onDestinationReady: (destination) => {
                        appendPendingArchive(options.ledgerFile, completionRecord(record, destination, options.now, true));
                    },
                });
                appendCompletedArchive(options.ledgerFile, completionRecord(record, archivePath, options.now, true));
                result.completed += 1;
            }
            else {
                result.unresolved.push({
                    sessionId: record.session_id,
                    reason: "source and recorded archive are both unavailable",
                });
            }
        }
        catch (error) {
            if (error instanceof TranscriptVersionChangedError) {
                if (record.attempt_id) {
                    appendAbortedArchive(options.ledgerFile, record);
                    continue;
                }
                result.unresolved.push({
                    sessionId: record.session_id,
                    reason: "legacy pending archive has no attempt identity",
                });
                continue;
            }
            result.unresolved.push({
                sessionId: record.session_id,
                reason: error instanceof Error ? error.message : String(error),
            });
        }
    }
    return result;
}

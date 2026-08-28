import fs from "node:fs";
import path from "node:path";
import { archiveTranscript } from "./archive.js";
import { fingerprintDescriptor, isTranscriptFingerprint, } from "./fingerprint.js";
import { appendLedger, appendCompletedArchive, appendPendingArchive, pendingArchives, } from "./ledger.js";
import { assertDirectTranscriptPath, assertSafeTranscriptPath, assertSlugInScope, isSingleSegmentSlug, isSlugInScope, openSafeTranscriptFile, } from "./scope.js";
function processedAt(now) {
    return new Date(now ?? Date.now()).toISOString();
}
function sessionIdFor(transcriptPath) {
    const base = path.basename(transcriptPath);
    return base.slice(0, base.length - path.extname(base).length);
}
function ledgerRecord(options, archivePath) {
    return {
        session_id: sessionIdFor(options.transcriptPath),
        slug: options.slug,
        processed_at: processedAt(options.now),
        score: options.score,
        outcome: options.outcome,
        memory_written: options.memoryWritten,
        transcript_path: path.resolve(options.transcriptPath),
        archive_path: archivePath,
        source_fingerprint: options.expectedFingerprint,
    };
}
function assertReviewedFingerprint(options) {
    if (!isTranscriptFingerprint(options.expectedFingerprint)) {
        throw new Error("archivable finalization requires a reviewed fingerprint");
    }
    const descriptor = openSafeTranscriptFile(options.transcriptPath, options.slug, options.projectsDir);
    try {
        if (fingerprintDescriptor(descriptor) !== options.expectedFingerprint) {
            throw new Error("source fingerprint changed since review");
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
    const pending = ledgerRecord(options);
    if (options.outcome === "unreadable") {
        assertSafeTranscriptPath(options.transcriptPath, options.slug, options.projectsDir);
        appendLedger(options.ledgerFile, pending);
        return {};
    }
    const expectedFingerprint = assertReviewedFingerprint(options);
    appendPendingArchive(options.ledgerFile, pending);
    const archivePath = archiveTranscript({
        transcriptPath: options.transcriptPath,
        slug: options.slug,
        projectsDir: options.projectsDir,
        archiveDir: options.archiveDir,
        expectedFingerprint,
        onDestinationReady: (destination) => {
            appendPendingArchive(options.ledgerFile, ledgerRecord(options, destination));
        },
    });
    appendCompletedArchive(options.ledgerFile, ledgerRecord(options, archivePath));
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
function completionRecord(record, archivePath, now) {
    return {
        ...record,
        processed_at: processedAt(now),
        archive_path: archivePath,
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
            if (isRecordedArchiveFile(recordedArchivePath, record.slug, options.archiveDir)) {
                if (!recordedArchiveMatchesFingerprint(recordedArchivePath, expectedFingerprint)) {
                    result.unresolved.push({
                        sessionId: record.session_id,
                        reason: "recorded archive does not match the reviewed fingerprint",
                    });
                    continue;
                }
                if (fs.existsSync(record.transcript_path)) {
                    archiveTranscript({
                        transcriptPath: record.transcript_path,
                        slug: record.slug,
                        projectsDir: options.projectsDir,
                        archiveDir: options.archiveDir,
                        expectedFingerprint,
                        existingArchivePath: recordedArchivePath,
                    });
                }
                appendCompletedArchive(options.ledgerFile, completionRecord(record, recordedArchivePath, options.now));
                result.completed += 1;
            }
            else if (fs.existsSync(record.transcript_path)) {
                const archivePath = archiveTranscript({
                    transcriptPath: record.transcript_path,
                    slug: record.slug,
                    projectsDir: options.projectsDir,
                    archiveDir: options.archiveDir,
                    expectedFingerprint,
                    onDestinationReady: (destination) => {
                        appendPendingArchive(options.ledgerFile, completionRecord(record, destination, options.now));
                    },
                });
                appendCompletedArchive(options.ledgerFile, completionRecord(record, archivePath, options.now));
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
            result.unresolved.push({
                sessionId: record.session_id,
                reason: error instanceof Error ? error.message : String(error),
            });
        }
    }
    return result;
}

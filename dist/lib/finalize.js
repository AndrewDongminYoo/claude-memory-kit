import fs from "node:fs";
import path from "node:path";
import { archiveTranscript } from "./archive.js";
import { appendLedger, appendCompletedArchive, appendPendingArchive, pendingArchives, } from "./ledger.js";
import { assertDirectTranscriptPath, assertSafeTranscriptFile, assertSafeTranscriptPath, assertSlugInScope, isSingleSegmentSlug, isSlugInScope, } from "./scope.js";
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
    };
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
    assertSafeTranscriptFile(options.transcriptPath, options.slug, options.projectsDir);
    appendPendingArchive(options.ledgerFile, pending);
    const archivePath = archiveTranscript({
        transcriptPath: options.transcriptPath,
        slug: options.slug,
        projectsDir: options.projectsDir,
        archiveDir: options.archiveDir,
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
    const stat = fs.lstatSync(candidate);
    if (stat.isSymbolicLink() || !stat.isFile()) {
        return false;
    }
    return (path.dirname(fs.realpathSync(candidate)) === fs.realpathSync(archiveSlugDir));
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
            if (isRecordedArchiveFile(recordedArchivePath, record.slug, options.archiveDir)) {
                if (fs.existsSync(record.transcript_path)) {
                    archiveTranscript({
                        transcriptPath: record.transcript_path,
                        slug: record.slug,
                        projectsDir: options.projectsDir,
                        archiveDir: options.archiveDir,
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

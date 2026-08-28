import fs from "node:fs";
import path from "node:path";
import { isTranscriptFingerprint } from "./fingerprint.js";
function readLedgerEvents(file) {
    if (!fs.existsSync(file))
        return [];
    const contents = fs.readFileSync(file, "utf8");
    const lines = contents.split("\n");
    return lines.flatMap((line, lineIndex) => {
        if (line.trim().length === 0) {
            return [];
        }
        try {
            const record = JSON.parse(line);
            return [{ record }];
        }
        catch (error) {
            if (lineIndex === lines.length - 1 && !contents.endsWith("\n")) {
                return [];
            }
            throw new Error(`invalid ledger event at line ${lineIndex + 1}: ${error instanceof Error ? error.message : String(error)}`);
        }
    });
}
/** Read the append-only ledger; a missing file is an empty ledger. */
export function readLedger(file) {
    return readLedgerEvents(file).map(({ record }) => record);
}
function archiveAttemptKey(record) {
    return (record.attempt_id ??
        `legacy:${JSON.stringify([
            record.transcript_path ?? "",
            record.source_fingerprint ?? "",
        ])}`);
}
/** Set of session ids already processed — the source of truth for "un-mined". */
export function minedSessions(file) {
    const completed = new Set();
    const pending = new Map();
    for (const { record } of readLedgerEvents(file)) {
        if (!record.archive_state) {
            completed.add(record.session_id);
            continue;
        }
        const key = archiveAttemptKey(record);
        if (record.archive_state === "pending") {
            const attempts = pending.get(record.session_id) ?? new Set();
            attempts.add(key);
            pending.set(record.session_id, attempts);
        }
        else if (record.archive_state === "archived") {
            completed.add(record.session_id);
            pending.get(record.session_id)?.delete(key);
        }
        else if (record.archive_state === "aborted" && record.attempt_id) {
            pending.get(record.session_id)?.delete(key);
        }
    }
    return new Set([
        ...completed,
        ...[...pending].flatMap(([sessionId, attempts]) => attempts.size > 0 ? [sessionId] : []),
    ]);
}
function syncDirectory(pathname) {
    if (process.platform === "win32") {
        return;
    }
    const descriptor = fs.openSync(pathname, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY);
    try {
        fs.fsyncSync(descriptor);
    }
    finally {
        fs.closeSync(descriptor);
    }
}
function repairUnterminatedTrailingEvent(file) {
    if (!fs.existsSync(file)) {
        return;
    }
    const contents = fs.readFileSync(file, "utf8");
    if (contents.endsWith("\n")) {
        return;
    }
    const lineStart = contents.lastIndexOf("\n") + 1;
    const trailingEvent = contents.slice(lineStart);
    try {
        if (trailingEvent.trim().length > 0) {
            JSON.parse(trailingEvent);
        }
        fs.appendFileSync(file, "\n");
    }
    catch {
        fs.truncateSync(file, lineStart);
    }
}
function syncCreatedDirectoryEntries(created, finalDirectory) {
    const firstParent = path.dirname(path.resolve(created));
    const finalParent = path.dirname(path.resolve(finalDirectory));
    const parents = [];
    for (let current = finalParent;; current = path.dirname(current)) {
        parents.push(current);
        if (current === firstParent) {
            break;
        }
        if (current === path.dirname(current)) {
            throw new Error("created ledger directory is outside its parent path");
        }
    }
    for (const parent of parents.reverse()) {
        syncDirectory(parent);
    }
}
/** Append one record. Append-only keeps runs resumable and idempotent. */
export function appendLedger(file, rec) {
    const ledgerDirectory = path.dirname(file);
    const created = fs.mkdirSync(ledgerDirectory, {
        recursive: true,
        mode: 0o700,
    });
    if (created) {
        syncCreatedDirectoryEntries(created, ledgerDirectory);
    }
    repairUnterminatedTrailingEvent(file);
    const descriptor = fs.openSync(file, "a", 0o600);
    try {
        fs.writeFileSync(descriptor, JSON.stringify(rec) + "\n");
        fs.fsyncSync(descriptor);
    }
    finally {
        fs.closeSync(descriptor);
    }
    syncDirectory(ledgerDirectory);
}
export function appendPendingArchive(file, rec) {
    if (rec.outcome === "unreadable" ||
        !rec.transcript_path ||
        !isTranscriptFingerprint(rec.source_fingerprint)) {
        throw new Error("pending archive record requires an archivable source");
    }
    appendLedger(file, { ...rec, archive_state: "pending" });
}
export function appendCompletedArchive(file, rec) {
    if (rec.outcome === "unreadable" ||
        !rec.transcript_path ||
        !rec.archive_path ||
        !isTranscriptFingerprint(rec.source_fingerprint)) {
        throw new Error("completed archive record requires source and archive paths");
    }
    appendLedger(file, { ...rec, archive_state: "archived" });
}
/** Close an archive attempt so a changed source can be scored again. */
export function appendAbortedArchive(file, rec) {
    if (rec.outcome === "unreadable" ||
        !rec.transcript_path ||
        !rec.attempt_id ||
        !isTranscriptFingerprint(rec.source_fingerprint)) {
        throw new Error("aborted archive record requires an archivable source");
    }
    appendLedger(file, { ...rec, archive_state: "aborted" });
}
function isPendingArchiveRecord(record) {
    return (record.archive_state === "pending" &&
        record.outcome !== "unreadable" &&
        typeof record.transcript_path === "string");
}
/** Returns the latest unfinished archive event for each attempt. */
export function pendingArchives(file) {
    const pending = new Map();
    for (const { record } of readLedgerEvents(file)) {
        const key = `${record.session_id}:${archiveAttemptKey(record)}`;
        if (isPendingArchiveRecord(record)) {
            pending.set(key, record);
        }
        else if (record.archive_state === "archived") {
            pending.delete(key);
        }
        else if (record.attempt_id && record.archive_state === "aborted") {
            pending.delete(key);
        }
    }
    return [...pending.values()];
}

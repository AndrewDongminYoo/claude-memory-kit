import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isTranscriptFingerprint } from "./fingerprint.js";
function sameFile(left, right) {
    return left.dev === right.dev && left.ino === right.ino;
}
function assertSafeLedgerDirectory(directory) {
    const absoluteDirectory = path.resolve(directory);
    const temporaryDirectory = path.resolve(os.tmpdir());
    const temporaryRelative = path.relative(temporaryDirectory, absoluteDirectory);
    const anchor = temporaryRelative === "" ||
        (!temporaryRelative.startsWith(`..${path.sep}`) &&
            temporaryRelative !== ".." &&
            !path.isAbsolute(temporaryRelative))
        ? temporaryDirectory
        : path.parse(absoluteDirectory).root;
    for (let current = absoluteDirectory;; current = path.dirname(current)) {
        let stat;
        try {
            stat = fs.lstatSync(current);
        }
        catch (error) {
            if (error.code === "ENOENT") {
                if (current === anchor) {
                    return;
                }
                continue;
            }
            throw error;
        }
        if (stat.isSymbolicLink() || !stat.isDirectory()) {
            throw new Error("ledger directory path is not a direct directory");
        }
        if (current === anchor) {
            return;
        }
    }
}
function assertSafeLedgerFile(file, descriptor) {
    const fileStat = fs.lstatSync(file);
    const openedStat = fs.fstatSync(descriptor);
    if (fileStat.isSymbolicLink() ||
        !fileStat.isFile() ||
        !openedStat.isFile() ||
        openedStat.nlink !== 1 ||
        !sameFile(fileStat, openedStat)) {
        throw new Error("ledger file changed after it was opened");
    }
}
function openLedgerForRead(file) {
    const ledgerDirectory = path.dirname(file);
    assertSafeLedgerDirectory(ledgerDirectory);
    try {
        const descriptor = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
        try {
            assertSafeLedgerDirectory(ledgerDirectory);
            assertSafeLedgerFile(file, descriptor);
            return descriptor;
        }
        catch (error) {
            fs.closeSync(descriptor);
            throw error;
        }
    }
    catch (error) {
        if (error.code === "ENOENT") {
            return undefined;
        }
        throw error;
    }
}
function readLedgerEvents(file) {
    const descriptor = openLedgerForRead(file);
    if (descriptor === undefined)
        return [];
    let contents;
    try {
        contents = fs.readFileSync(descriptor, "utf8");
    }
    finally {
        fs.closeSync(descriptor);
    }
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
            if (record.outcome !== "unreadable") {
                completed.add(record.session_id);
            }
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
/** Latest archived source fingerprint for sessions without a pending attempt. */
export function archivedSourceFingerprints(file) {
    const fingerprints = new Map();
    const pending = new Map();
    for (const { record } of readLedgerEvents(file)) {
        const key = archiveAttemptKey(record);
        if (record.archive_state === "pending") {
            const attempts = pending.get(record.session_id) ?? new Set();
            attempts.add(key);
            pending.set(record.session_id, attempts);
        }
        else if (record.archive_state === "archived" &&
            isTranscriptFingerprint(record.source_fingerprint)) {
            fingerprints.set(record.session_id, record.source_fingerprint);
            pending.get(record.session_id)?.delete(key);
        }
        else if (record.archive_state === "aborted" && record.attempt_id) {
            pending.get(record.session_id)?.delete(key);
        }
    }
    for (const [sessionId, attempts] of pending) {
        if (attempts.size > 0)
            fingerprints.delete(sessionId);
    }
    return fingerprints;
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
function repairUnterminatedTrailingEvent(descriptor, contents) {
    if (contents.endsWith("\n")) {
        return;
    }
    const lineStart = contents.lastIndexOf("\n") + 1;
    const trailingEvent = contents.slice(lineStart);
    try {
        if (trailingEvent.trim().length > 0) {
            JSON.parse(trailingEvent);
        }
        fs.writeFileSync(descriptor, "\n");
    }
    catch {
        fs.ftruncateSync(descriptor, lineStart);
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
    assertSafeLedgerDirectory(ledgerDirectory);
    const created = fs.mkdirSync(ledgerDirectory, {
        recursive: true,
        mode: 0o700,
    });
    assertSafeLedgerDirectory(ledgerDirectory);
    if (created) {
        syncCreatedDirectoryEntries(created, ledgerDirectory);
    }
    const descriptor = fs.openSync(file, fs.constants.O_RDWR |
        fs.constants.O_APPEND |
        fs.constants.O_CREAT |
        fs.constants.O_NOFOLLOW, 0o600);
    try {
        assertSafeLedgerDirectory(ledgerDirectory);
        assertSafeLedgerFile(file, descriptor);
        repairUnterminatedTrailingEvent(descriptor, fs.readFileSync(descriptor, "utf8"));
        fs.writeFileSync(descriptor, JSON.stringify(rec) + "\n");
        fs.fsyncSync(descriptor);
    }
    finally {
        fs.closeSync(descriptor);
    }
    assertSafeLedgerDirectory(ledgerDirectory);
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

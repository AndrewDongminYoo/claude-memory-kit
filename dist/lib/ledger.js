import fs from "node:fs";
import path from "node:path";
/** Read the append-only ledger; a missing file is an empty ledger. */
export function readLedger(file) {
    if (!fs.existsSync(file))
        return [];
    const contents = fs.readFileSync(file, "utf8");
    const lines = contents.split("\n");
    return lines.flatMap((line, index) => {
        if (line.trim().length === 0) {
            return [];
        }
        try {
            return [JSON.parse(line)];
        }
        catch (error) {
            if (index === lines.length - 1 && !contents.endsWith("\n")) {
                return [];
            }
            throw new Error(`invalid ledger event at line ${index + 1}: ${error instanceof Error ? error.message : String(error)}`);
        }
    });
}
/** Set of session ids already processed — the source of truth for "un-mined". */
export function minedSessions(file) {
    return new Set(readLedger(file).map((r) => r.session_id));
}
function syncDirectory(pathname) {
    const descriptor = fs.openSync(pathname, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY);
    try {
        fs.fsyncSync(descriptor);
    }
    finally {
        fs.closeSync(descriptor);
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
    if (rec.outcome === "unreadable" || !rec.transcript_path) {
        throw new Error("pending archive record requires an archivable source");
    }
    appendLedger(file, { ...rec, archive_state: "pending" });
}
export function appendCompletedArchive(file, rec) {
    if (rec.outcome === "unreadable" ||
        !rec.transcript_path ||
        !rec.archive_path) {
        throw new Error("completed archive record requires source and archive paths");
    }
    appendLedger(file, { ...rec, archive_state: "archived" });
}
function isPendingArchiveRecord(record) {
    return (record.archive_state === "pending" &&
        record.outcome !== "unreadable" &&
        typeof record.transcript_path === "string");
}
/** Returns the latest unfinished archive event for each session. */
export function pendingArchives(file) {
    const pending = new Map();
    for (const record of readLedger(file)) {
        if (isPendingArchiveRecord(record)) {
            pending.set(record.session_id, record);
        }
        else if (record.archive_state === "archived") {
            pending.delete(record.session_id);
        }
    }
    return [...pending.values()];
}

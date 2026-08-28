import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isTranscriptFingerprint } from "./fingerprint.ts";

/** Outcome of processing one transcript. */
export type Outcome =
  "memory-written" | "proposed-rejected" | "skipped-low-score" | "unreadable";

export type ArchiveState = "pending" | "archived" | "aborted";

export type ArchiveOutcome = Exclude<Outcome, "unreadable">;

export interface LedgerRecord {
  session_id: string;
  slug: string;
  processed_at: string;
  score: number;
  outcome: Outcome;
  memory_written: string[];
  archive_state?: ArchiveState;
  transcript_path?: string;
  archive_path?: string;
  archive_ready?: boolean;
  source_fingerprint?: string;
  attempt_id?: string;
}

export interface PendingArchiveRecord extends LedgerRecord {
  archive_state: "pending";
  transcript_path: string;
  outcome: ArchiveOutcome;
}

export interface CompletedArchiveRecord extends LedgerRecord {
  archive_state: "archived";
  transcript_path: string;
  archive_path: string;
  outcome: ArchiveOutcome;
}

interface LedgerEvent {
  record: LedgerRecord;
}

function sameFile(left: fs.Stats, right: fs.Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function assertSafeLedgerDirectory(directory: string): void {
  const absoluteDirectory = path.resolve(directory);
  const temporaryDirectory = path.resolve(os.tmpdir());
  const temporaryRelative = path.relative(
    temporaryDirectory,
    absoluteDirectory,
  );
  const anchor =
    temporaryRelative === "" ||
    (!temporaryRelative.startsWith(`..${path.sep}`) &&
      temporaryRelative !== ".." &&
      !path.isAbsolute(temporaryRelative))
      ? temporaryDirectory
      : path.parse(absoluteDirectory).root;
  for (let current = absoluteDirectory; ; current = path.dirname(current)) {
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(current);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
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

function assertSafeLedgerFile(file: string, descriptor: number): void {
  const fileStat = fs.lstatSync(file);
  const openedStat = fs.fstatSync(descriptor);
  if (
    fileStat.isSymbolicLink() ||
    !fileStat.isFile() ||
    !openedStat.isFile() ||
    openedStat.nlink !== 1 ||
    !sameFile(fileStat, openedStat)
  ) {
    throw new Error("ledger file changed after it was opened");
  }
}

function openLedgerForRead(file: string): number | undefined {
  const ledgerDirectory = path.dirname(file);
  assertSafeLedgerDirectory(ledgerDirectory);
  try {
    const descriptor = fs.openSync(
      file,
      fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW,
    );
    try {
      assertSafeLedgerDirectory(ledgerDirectory);
      assertSafeLedgerFile(file, descriptor);
      return descriptor;
    } catch (error) {
      fs.closeSync(descriptor);
      throw error;
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

function readLedgerEvents(file: string): LedgerEvent[] {
  const descriptor = openLedgerForRead(file);
  if (descriptor === undefined) return [];
  let contents: string;
  try {
    contents = fs.readFileSync(descriptor, "utf8");
  } finally {
    fs.closeSync(descriptor);
  }
  const lines = contents.split("\n");
  return lines.flatMap((line, lineIndex) => {
    if (line.trim().length === 0) {
      return [];
    }
    try {
      const record = JSON.parse(line) as LedgerRecord;
      return [{ record }];
    } catch (error) {
      if (lineIndex === lines.length - 1 && !contents.endsWith("\n")) {
        return [];
      }
      throw new Error(
        `invalid ledger event at line ${lineIndex + 1}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  });
}

/** Read the append-only ledger; a missing file is an empty ledger. */
export function readLedger(file: string): LedgerRecord[] {
  return readLedgerEvents(file).map(({ record }) => record);
}

function archiveAttemptKey(record: LedgerRecord): string {
  return (
    record.attempt_id ??
    `legacy:${JSON.stringify([
      record.transcript_path ?? "",
      record.source_fingerprint ?? "",
    ])}`
  );
}

/** Set of session ids already processed — the source of truth for "un-mined". */
export function minedSessions(file: string): Set<string> {
  const completed = new Set<string>();
  const pending = new Map<string, Set<string>>();
  for (const { record } of readLedgerEvents(file)) {
    if (!record.archive_state) {
      if (record.outcome !== "unreadable") {
        completed.add(record.session_id);
      }
      continue;
    }
    const key = archiveAttemptKey(record);
    if (record.archive_state === "pending") {
      const attempts = pending.get(record.session_id) ?? new Set<string>();
      attempts.add(key);
      pending.set(record.session_id, attempts);
    } else if (record.archive_state === "archived") {
      completed.add(record.session_id);
      pending.get(record.session_id)?.delete(key);
    } else if (record.archive_state === "aborted" && record.attempt_id) {
      pending.get(record.session_id)?.delete(key);
    }
  }
  return new Set([
    ...completed,
    ...[...pending].flatMap(([sessionId, attempts]) =>
      attempts.size > 0 ? [sessionId] : [],
    ),
  ]);
}

function syncDirectory(pathname: string): void {
  if (process.platform === "win32") {
    return;
  }
  const descriptor = fs.openSync(
    pathname,
    fs.constants.O_RDONLY | fs.constants.O_DIRECTORY,
  );
  try {
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}

function repairUnterminatedTrailingEvent(
  descriptor: number,
  contents: string,
): void {
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
  } catch {
    fs.ftruncateSync(descriptor, lineStart);
  }
}

function syncCreatedDirectoryEntries(
  created: string,
  finalDirectory: string,
): void {
  const firstParent = path.dirname(path.resolve(created));
  const finalParent = path.dirname(path.resolve(finalDirectory));
  const parents: string[] = [];
  for (let current = finalParent; ; current = path.dirname(current)) {
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
export function appendLedger(file: string, rec: LedgerRecord): void {
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
  const descriptor = fs.openSync(
    file,
    fs.constants.O_RDWR |
      fs.constants.O_APPEND |
      fs.constants.O_CREAT |
      fs.constants.O_NOFOLLOW,
    0o600,
  );
  try {
    assertSafeLedgerDirectory(ledgerDirectory);
    assertSafeLedgerFile(file, descriptor);
    repairUnterminatedTrailingEvent(
      descriptor,
      fs.readFileSync(descriptor, "utf8"),
    );
    fs.writeFileSync(descriptor, JSON.stringify(rec) + "\n");
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
  assertSafeLedgerDirectory(ledgerDirectory);
  syncDirectory(ledgerDirectory);
}

export function appendPendingArchive(file: string, rec: LedgerRecord): void {
  if (
    rec.outcome === "unreadable" ||
    !rec.transcript_path ||
    !isTranscriptFingerprint(rec.source_fingerprint)
  ) {
    throw new Error("pending archive record requires an archivable source");
  }
  appendLedger(file, { ...rec, archive_state: "pending" });
}

export function appendCompletedArchive(file: string, rec: LedgerRecord): void {
  if (
    rec.outcome === "unreadable" ||
    !rec.transcript_path ||
    !rec.archive_path ||
    !isTranscriptFingerprint(rec.source_fingerprint)
  ) {
    throw new Error(
      "completed archive record requires source and archive paths",
    );
  }
  appendLedger(file, { ...rec, archive_state: "archived" });
}

/** Close an archive attempt so a changed source can be scored again. */
export function appendAbortedArchive(file: string, rec: LedgerRecord): void {
  if (
    rec.outcome === "unreadable" ||
    !rec.transcript_path ||
    !rec.attempt_id ||
    !isTranscriptFingerprint(rec.source_fingerprint)
  ) {
    throw new Error("aborted archive record requires an archivable source");
  }
  appendLedger(file, { ...rec, archive_state: "aborted" });
}

function isPendingArchiveRecord(
  record: LedgerRecord,
): record is PendingArchiveRecord {
  return (
    record.archive_state === "pending" &&
    record.outcome !== "unreadable" &&
    typeof record.transcript_path === "string"
  );
}

/** Returns the latest unfinished archive event for each attempt. */
export function pendingArchives(file: string): PendingArchiveRecord[] {
  const pending = new Map<string, PendingArchiveRecord>();
  for (const { record } of readLedgerEvents(file)) {
    const key = `${record.session_id}:${archiveAttemptKey(record)}`;
    if (isPendingArchiveRecord(record)) {
      pending.set(key, record);
    } else if (record.archive_state === "archived") {
      pending.delete(key);
    } else if (record.attempt_id && record.archive_state === "aborted") {
      pending.delete(key);
    }
  }
  return [...pending.values()];
}

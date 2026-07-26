import fs from "node:fs";
import path from "node:path";

/** Outcome of processing one transcript. */
export type Outcome =
  "memory-written" | "proposed-rejected" | "skipped-low-score" | "unreadable";

export interface LedgerRecord {
  session_id: string;
  slug: string;
  processed_at: string;
  score: number;
  outcome: Outcome;
  memory_written: string[];
}

/** Read the append-only ledger; a missing file is an empty ledger. */
export function readLedger(file: string): LedgerRecord[] {
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as LedgerRecord);
}

/** Set of session ids already processed — the source of truth for "un-mined". */
export function minedSessions(file: string): Set<string> {
  return new Set(readLedger(file).map((r) => r.session_id));
}

/** Append one record. Append-only keeps runs resumable and idempotent. */
export function appendLedger(file: string, rec: LedgerRecord): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, JSON.stringify(rec) + "\n");
}

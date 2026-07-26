import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  readLedger,
  minedSessions,
  appendLedger,
  type LedgerRecord,
} from "./ledger.ts";

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "cmk-ledger-"));
}

const rec = (over: Partial<LedgerRecord>): LedgerRecord => ({
  session_id: "a",
  slug: "proj",
  processed_at: "2026-07-26T00:00:00Z",
  score: 1,
  outcome: "memory-written",
  memory_written: [],
  ...over,
});

test("missing ledger reads as empty", () => {
  assert.deepEqual(readLedger(path.join(tmpDir(), "nope.jsonl")), []);
  assert.deepEqual([...minedSessions(path.join(tmpDir(), "nope.jsonl"))], []);
});

test("append is append-only and round-trips", () => {
  const f = path.join(tmpDir(), "l.jsonl");
  appendLedger(f, rec({ session_id: "a", memory_written: ["m.md"] }));
  appendLedger(
    f,
    rec({ session_id: "b", outcome: "skipped-low-score", score: 0 }),
  );
  const recs = readLedger(f);
  assert.equal(recs.length, 2);
  assert.equal(recs[0]?.memory_written[0], "m.md");
  assert.deepEqual(minedSessions(f), new Set(["a", "b"]));
});

test("blank lines in the ledger are ignored", () => {
  const f = path.join(tmpDir(), "l.jsonl");
  appendLedger(f, rec({ session_id: "a" }));
  fs.appendFileSync(f, "\n\n");
  assert.equal(readLedger(f).length, 1);
});

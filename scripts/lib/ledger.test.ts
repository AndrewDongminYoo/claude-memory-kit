import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  readLedger,
  minedSessions,
  appendLedger,
  appendCompletedArchive,
  appendPendingArchive,
  pendingArchives,
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
  source_fingerprint: "0".repeat(64),
  ...over,
});

function withWindowsDirectoryFsyncUnavailable(action: () => void): void {
  const platformDescriptor = Object.getOwnPropertyDescriptor(
    process,
    "platform",
  );
  assert.ok(platformDescriptor);
  const originalOpen = fs.openSync;
  Object.defineProperty(process, "platform", {
    ...platformDescriptor,
    value: "win32",
  });
  fs.openSync = ((pathname, flags, mode) => {
    if (typeof flags === "number" && (flags & fs.constants.O_DIRECTORY) !== 0) {
      const error = new Error("directory fsync is unavailable on Windows");
      (error as NodeJS.ErrnoException).code = "EPERM";
      throw error;
    }
    return originalOpen(pathname, flags, mode);
  }) as typeof fs.openSync;

  try {
    action();
  } finally {
    fs.openSync = originalOpen;
    Object.defineProperty(process, "platform", platformDescriptor);
  }
}

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

test("syncs new ledger directories and the new ledger file before returning", () => {
  const f = path.join(tmpDir(), "new-ledger", "l.jsonl");
  const originalFsync = fs.fsyncSync;
  let calls = 0;
  fs.fsyncSync = ((descriptor: number) => {
    calls += 1;
    originalFsync(descriptor);
  }) as typeof fs.fsyncSync;

  try {
    appendLedger(f, rec({ session_id: "durable" }));
  } finally {
    fs.fsyncSync = originalFsync;
  }

  assert.equal(calls, 3);
});

test("appends on Windows when directory fsync is unavailable", () => {
  const f = path.join(tmpDir(), "new-ledger", "l.jsonl");

  withWindowsDirectoryFsyncUnavailable(() => {
    appendLedger(f, rec({ session_id: "windows" }));
  });

  assert.deepEqual(
    readLedger(f).map((record) => record.session_id),
    ["windows"],
  );
});

test("blank lines in the ledger are ignored", () => {
  const f = path.join(tmpDir(), "l.jsonl");
  appendLedger(f, rec({ session_id: "a" }));
  fs.appendFileSync(f, "\n\n");
  assert.equal(readLedger(f).length, 1);
});

test("ignores only a truncated trailing ledger event", () => {
  const f = path.join(tmpDir(), "l.jsonl");
  appendLedger(f, rec({ session_id: "complete" }));
  fs.appendFileSync(f, '{"session_id":"torn"');

  assert.deepEqual(
    readLedger(f).map((record) => record.session_id),
    ["complete"],
  );
  assert.deepEqual([...minedSessions(f)], ["complete"]);
});

test("truncates a torn trailing ledger event before appending", () => {
  const f = path.join(tmpDir(), "l.jsonl");
  appendLedger(f, rec({ session_id: "complete" }));
  fs.appendFileSync(f, '{"session_id":"torn"');

  appendLedger(f, rec({ session_id: "after-recovery" }));

  assert.deepEqual(
    readLedger(f).map((record) => record.session_id),
    ["complete", "after-recovery"],
  );
});

test("separates a complete trailing event without a newline before appending", () => {
  const f = path.join(tmpDir(), "l.jsonl");
  fs.writeFileSync(f, JSON.stringify(rec({ session_id: "complete" })));

  appendLedger(f, rec({ session_id: "after-recovery" }));

  assert.deepEqual(
    readLedger(f).map((record) => record.session_id),
    ["complete", "after-recovery"],
  );
});

test("rejects a malformed final ledger event that ends with a newline", () => {
  const f = path.join(tmpDir(), "l.jsonl");
  appendLedger(f, rec({ session_id: "complete" }));
  fs.appendFileSync(f, '{"session_id":"corrupt"\n');

  assert.throws(() => readLedger(f), /invalid ledger event/);
});

test("rejects an invalid non-trailing ledger event", () => {
  const f = path.join(tmpDir(), "l.jsonl");
  fs.writeFileSync(
    f,
    '{"session_id":"torn"\n' + JSON.stringify(rec({})) + "\n",
  );

  assert.throws(() => readLedger(f), /invalid ledger event/);
});

test("pendingArchives excludes a session after its archived event", () => {
  const f = path.join(tmpDir(), "l.jsonl");
  appendPendingArchive(
    f,
    rec({
      session_id: "pending",
      archive_state: "pending",
      transcript_path: "/fixture/projects/proj/pending.jsonl",
    }),
  );
  appendPendingArchive(
    f,
    rec({
      session_id: "completed",
      archive_state: "pending",
      transcript_path: "/fixture/projects/proj/completed.jsonl",
    }),
  );
  appendCompletedArchive(
    f,
    rec({
      session_id: "completed",
      archive_state: "archived",
      transcript_path: "/fixture/projects/proj/completed.jsonl",
      archive_path: "/fixture/archive/proj/completed.jsonl",
    }),
  );

  assert.deepEqual(
    pendingArchives(f).map((record) => record.session_id),
    ["pending"],
  );
});

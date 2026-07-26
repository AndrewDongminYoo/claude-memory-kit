import { test } from "node:test";
import assert from "node:assert/strict";
import { lastInternalTimestampMs, ageBasisMs } from "./timestamps.ts";

const T1 = "2026-07-10T00:00:00.000Z";
const T2 = "2026-07-12T00:00:00.000Z";

test("lastInternalTimestampMs returns the max internal timestamp", () => {
  const raw =
    JSON.stringify({ type: "user", timestamp: T1 }) +
    "\n" +
    JSON.stringify({ type: "assistant", timestamp: T2 }) +
    "\n";
  assert.equal(lastInternalTimestampMs(raw), Date.parse(T2));
});

test("lastInternalTimestampMs is null when no timestamps present", () => {
  assert.equal(lastInternalTimestampMs('{"type":"user"}\n{ bad json\n'), null);
});

test("ageBasisMs takes the earlier of internal session time and mtime", () => {
  const internal = Date.parse(T1); // older
  const mtime = Date.parse(T2); // newer (file touched later, e.g. copy)
  const raw = JSON.stringify({ timestamp: T1 }) + "\n";
  // earlier => older => the true session age basis
  assert.equal(ageBasisMs(raw, mtime), internal);
});

test("ageBasisMs falls back to mtime when no internal timestamp", () => {
  const mtime = Date.parse(T2);
  assert.equal(ageBasisMs('{"type":"user"}\n', mtime), mtime);
  assert.equal(ageBasisMs(null, mtime), mtime);
});

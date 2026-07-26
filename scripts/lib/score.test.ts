import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseTranscript,
  scoreTranscript,
  scoreEntries,
  SCORE_MIN,
  type TranscriptEntry,
} from "./score.ts";

/** Build a jsonl transcript from [role, textOrBlocks] pairs. */
function jsonl(turns: Array<[string, string | object[]]>): string {
  return (
    turns
      .map(([role, content]) =>
        JSON.stringify({ type: role, message: { role, content } }),
      )
      .join("\n") + "\n"
  );
}

test("parseTranscript reads string and array content, counts tool_use, skips bad lines", () => {
  const raw =
    jsonl([
      ["user", "hello"],
      [
        "assistant",
        [
          { type: "text", text: "hi" },
          { type: "tool_use", name: "Bash" },
        ],
      ],
    ]) + "{ not json\n";
  const entries = parseTranscript(raw);
  assert.equal(entries.length, 2);
  assert.equal(entries[0]?.text, "hello");
  assert.equal(entries[1]?.toolUses, 1);
  assert.match(entries[1]?.text ?? "", /hi/);
});

// A clearly memory-worthy session: operator corrections, a post-mortem, a commit, honesty marker.
const WORTHY = jsonl([
  [
    "user",
    "이 방식이 아니라 대신 캐시를 무효화해야 합니다. 그렇게 하지 마세요.",
  ],
  [
    "assistant",
    [
      {
        type: "text",
        text: "You're right. The root cause was a stale cache; the fix is to bust it on install. [PARTIAL] verified on one path.",
      },
      { type: "tool_use", name: "Bash" },
    ],
  ],
  ["user", "actually revert that and commit the smaller diff instead"],
  [
    "assistant",
    [
      {
        type: "text",
        text: "Committed abc1234. Turns out the lesson is to gate on the lockfile.",
      },
      { type: "tool_use", name: "Bash" },
    ],
  ],
  ["user", "좋습니다"],
]);

// Clear noise: a trivial one-shot lookup, no durable knowledge.
const NOISE = jsonl([
  ["user", "what's the capital of France?"],
  ["assistant", "Paris."],
]);

test("memory-worthy session outranks noise and clears SCORE_MIN", () => {
  const worthy = scoreTranscript(WORTHY);
  const noise = scoreTranscript(NOISE);
  assert.ok(
    worthy.score > noise.score,
    `worthy ${worthy.score} !> noise ${noise.score}`,
  );
  assert.ok(
    worthy.score >= SCORE_MIN,
    `worthy ${worthy.score} < SCORE_MIN ${SCORE_MIN}`,
  );
  assert.ok(
    noise.score < SCORE_MIN,
    `noise ${noise.score} >= SCORE_MIN ${SCORE_MIN}`,
  );
});

test("worthy session's strongest signal is operator corrections", () => {
  const { signals } = scoreTranscript(WORTHY);
  assert.ok(
    signals.correction >= 2,
    `expected >=2 corrections, got ${signals.correction}`,
  );
});

test("trivial/near-empty session scores 0", () => {
  const entries: TranscriptEntry[] = [
    { role: "user", text: "hi", toolUses: 0 },
  ];
  assert.equal(scoreEntries(entries).score, 0);
});

test("error-heavy session with no resolution is penalized", () => {
  const errs = jsonl([
    ["user", "run it"],
    ["assistant", "error error failed exception traceback error failed"],
    ["user", "still?"],
    ["assistant", "error failed exception again"],
  ]);
  const s = scoreTranscript(errs);
  assert.ok(
    s.signals.unresolvedPenalty < 0,
    "expected an unresolved-error penalty",
  );
});

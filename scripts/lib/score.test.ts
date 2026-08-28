import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseTranscript,
  scoreTranscript,
  scoreEntries,
  selectForDeepRead,
  isUnreadableTranscript,
  parseMaxPerProject,
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

test("detects a transcript with no valid JSONL entries as unreadable", () => {
  assert.equal(isUnreadableTranscript("{ invalid\n"), true);
  assert.equal(isUnreadableTranscript("\n"), true);
  assert.equal(isUnreadableTranscript('{"type":"user"}\n'), false);
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
    { role: "user", text: "hi", toolUses: 0, writes: [] },
  ];
  assert.equal(scoreEntries(entries).score, 0);
});

test("parseTranscript captures Write/Edit targets for self-curation detection", () => {
  const raw = JSON.stringify({
    type: "assistant",
    message: {
      role: "assistant",
      content: [
        { type: "text", text: "writing memory" },
        {
          type: "tool_use",
          name: "Write",
          input: { file_path: "/Users/x/.claude/projects/p/memory/foo.md" },
        },
      ],
    },
  });
  const entries = parseTranscript(raw + "\n");
  assert.deepEqual(entries[0]?.writes, [
    "/Users/x/.claude/projects/p/memory/foo.md",
  ]);
});

test("a self-curated session (wrote to memory/) is dampened below an equivalent un-curated one", () => {
  const base: TranscriptEntry[] = [
    {
      role: "user",
      text: "이건 아니라 대신 이렇게. 하지 마세요.",
      toolUses: 0,
      writes: [],
    },
    {
      role: "assistant",
      text: "root cause found, the fix is X, committed abc1234. [PARTIAL]",
      toolUses: 2,
      writes: [],
    },
    {
      role: "user",
      text: "actually revert, instead do Y",
      toolUses: 0,
      writes: [],
    },
  ];
  const curated: TranscriptEntry[] = base.map((e, i) =>
    i === 1 ? { ...e, writes: ["/home/.claude/projects/p/memory/note.md"] } : e,
  );
  const plain = scoreEntries(base).score;
  const dampened = scoreEntries(curated).score;
  assert.equal(scoreEntries(curated).signals.selfCurated, 1);
  assert.equal(scoreEntries(base).signals.selfCurated, 0);
  assert.ok(dampened < plain, `curated ${dampened} should be < plain ${plain}`);
  assert.ok(Math.abs(dampened - plain * 0.4) < 0.01, "dampen factor is 0.4");
});

test("selectForDeepRead drops below-threshold rows and caps each project", () => {
  const rows = [
    { path: "/p/alpha/1.jsonl", slug: "alpha", score: 90 },
    { path: "/p/alpha/2.jsonl", slug: "alpha", score: 80 },
    { path: "/p/alpha/3.jsonl", slug: "alpha", score: 70 },
    { path: "/p/beta/1.jsonl", slug: "beta", score: 60 },
    {
      path: "/p/beta/2.jsonl",
      slug: "beta",
      score: SCORE_MIN - 1,
    },
  ];
  assert.deepEqual(
    selectForDeepRead(rows, 2).map((r) => r.path),
    ["/p/alpha/1.jsonl", "/p/alpha/2.jsonl", "/p/beta/1.jsonl"],
    "highest score first, 2 per project, nothing below SCORE_MIN",
  );
  assert.equal(
    selectForDeepRead(rows, 0).length,
    4,
    "cap 0 disables the cap but keeps the threshold",
  );
});

test("caps Windows-style rows per explicit slug", () => {
  const rows = [
    { path: "C:\\projects\\alpha\\one.jsonl", slug: "alpha", score: 90 },
    { path: "C:\\projects\\alpha\\two.jsonl", slug: "alpha", score: 80 },
    { path: "C:\\projects\\beta\\one.jsonl", slug: "beta", score: 70 },
  ];

  assert.deepEqual(
    selectForDeepRead(rows, 1).map((row) => row.slug),
    ["alpha", "beta"],
  );
});

test("keeps one highest-scoring row for duplicate input paths", () => {
  const rows = [
    { path: "/p/alpha/one.jsonl", slug: "alpha", score: 70 },
    { path: "/p/alpha/one.jsonl", slug: "alpha", score: 90 },
    { path: "/p/beta/one.jsonl", slug: "beta", score: 80 },
  ];

  assert.deepEqual(
    selectForDeepRead(rows).map((row) => row.score),
    [90, 80],
  );
});

test("rejects a fractional or negative MAX_PER_PROJECT", () => {
  assert.throws(() => parseMaxPerProject("1.5"), /invalid MAX_PER_PROJECT/);
  assert.throws(() => parseMaxPerProject("-1"), /invalid MAX_PER_PROJECT/);
  assert.equal(parseMaxPerProject("0"), 0);
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

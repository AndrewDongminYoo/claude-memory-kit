import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fingerprintContents } from "./fingerprint.ts";
import { scanCold } from "./scan.ts";

const DAY_MS = 86_400_000;
const NOW = 1_800_000_000_000; // fixed reference so tests are deterministic
const TEST_SCOPE = ["p", "project", "personal-"];

/** Build a projects/ tree with transcripts aged (now - ageDays). */
function fixture(
  files: Array<[slug: string, id: string, ageDays: number]>,
): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cmk-proj-"));
  for (const [slug, id, ageDays] of files) {
    const dir = path.join(root, slug);
    fs.mkdirSync(dir, { recursive: true });
    const f = path.join(dir, `${id}.jsonl`);
    fs.writeFileSync(f, "{}\n");
    const t = new Date(NOW - ageDays * DAY_MS);
    fs.utimesSync(f, t, t);
  }
  return root;
}

test("selects only cold, un-mined transcripts (30d cutoff)", () => {
  const dir = fixture([
    ["proj-a", "old1", 40],
    ["proj-a", "recent", 5],
    ["proj-b", "old2", 31],
  ]);
  const c = scanCold({
    projectsDir: dir,
    minedSessions: new Set(),
    coldDays: 30,
    now: NOW,
    scopePrefixes: TEST_SCOPE,
  });
  assert.deepEqual(c.map((x) => x.session_id).sort(), ["old1", "old2"]);
});

test("cutoff is inclusive at exactly coldDays and excludes younger", () => {
  const dir = fixture([
    ["p", "exactly30", 30],
    ["p", "just-under", 29],
  ]);
  const c = scanCold({
    projectsDir: dir,
    minedSessions: new Set(),
    coldDays: 30,
    now: NOW,
    scopePrefixes: TEST_SCOPE,
  });
  assert.deepEqual(
    c.map((x) => x.session_id),
    ["exactly30"],
  );
});

test("already-mined sessions are excluded", () => {
  const dir = fixture([
    ["p", "old1", 40],
    ["p", "old2", 40],
  ]);
  const c = scanCold({
    projectsDir: dir,
    minedSessions: new Set(["old1"]),
    coldDays: 30,
    now: NOW,
    scopePrefixes: TEST_SCOPE,
  });
  assert.deepEqual(
    c.map((x) => x.session_id),
    ["old2"],
  );
});

test("rescores a retained source when its archived fingerprint changed", () => {
  const dir = fixture([["p", "old1", 40]]);
  const transcript = path.join(dir, "p", "old1.jsonl");
  fs.writeFileSync(transcript, "RESUMED\n");
  const oldFingerprint = fingerprintContents(Buffer.from("{}\n"));

  const candidates = scanCold({
    projectsDir: dir,
    minedSessions: new Set(["old1"]),
    minedFingerprints: new Map([["old1", oldFingerprint]]),
    coldDays: 30,
    now: NOW,
    scopePrefixes: TEST_SCOPE,
  });

  assert.deepEqual(
    candidates.map((candidate) => candidate.session_id),
    ["old1"],
  );
});

test("oldest-first ordering", () => {
  const dir = fixture([
    ["p", "a", 35],
    ["p", "b", 90],
    ["p", "c", 31],
  ]);
  const c = scanCold({
    projectsDir: dir,
    minedSessions: new Set(),
    coldDays: 30,
    now: NOW,
    scopePrefixes: TEST_SCOPE,
  });
  assert.deepEqual(
    c.map((x) => x.session_id),
    ["b", "a", "c"],
  );
});

test("nested sub-agent/workflow child transcripts are NOT mined (main-session only)", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cmk-proj-"));
  const slug = path.join(root, "proj");
  fs.mkdirSync(
    path.join(slug, "session-uuid", "subagents", "workflows", "wf_1"),
    {
      recursive: true,
    },
  );
  const old = new Date(NOW - 40 * DAY_MS);
  // main-session transcript (one level) — a candidate
  const main = path.join(slug, "session-uuid.jsonl");
  fs.writeFileSync(main, "{}\n");
  fs.utimesSync(main, old, old);
  // nested sub-agent + workflow transcripts — must be ignored
  const sub = path.join(slug, "session-uuid", "subagents", "agent-x.jsonl");
  fs.writeFileSync(sub, "{}\n");
  fs.utimesSync(sub, old, old);
  const wf = path.join(
    slug,
    "session-uuid",
    "subagents",
    "workflows",
    "wf_1",
    "a.jsonl",
  );
  fs.writeFileSync(wf, "{}\n");
  fs.utimesSync(wf, old, old);

  const c = scanCold({
    projectsDir: root,
    minedSessions: new Set(),
    coldDays: 30,
    now: NOW,
    scopePrefixes: TEST_SCOPE,
  });
  assert.deepEqual(
    c.map((x) => x.session_id),
    ["session-uuid"],
  );
});

test("does not scan symlinked project directories or transcript files", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cmk-proj-"));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "cmk-outside-"));
  const outsideProject = path.join(outside, "external-project");
  const outsideTranscript = path.join(outside, "external.jsonl");
  const projectDir = path.join(root, "project");
  fs.mkdirSync(outsideProject, { recursive: true });
  fs.mkdirSync(projectDir, { recursive: true });
  fs.writeFileSync(path.join(outsideProject, "external.jsonl"), "{}\n");
  fs.writeFileSync(outsideTranscript, "{}\n");
  fs.symlinkSync(outsideProject, path.join(root, "linked-project"));
  fs.symlinkSync(outsideTranscript, path.join(projectDir, "linked.jsonl"));
  const old = new Date(NOW - 40 * DAY_MS);
  fs.utimesSync(outsideTranscript, old, old);
  fs.utimesSync(path.join(outsideProject, "external.jsonl"), old, old);

  assert.deepEqual(
    scanCold({
      projectsDir: root,
      minedSessions: new Set(),
      coldDays: 30,
      now: NOW,
      scopePrefixes: TEST_SCOPE,
    }),
    [],
  );
});

test("rejects a symlinked projects root", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cmk-proj-"));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "cmk-outside-"));
  const projectDir = path.join(outside, "personal-project");
  const transcript = path.join(projectDir, "session.jsonl");
  fs.mkdirSync(projectDir, { recursive: true });
  fs.writeFileSync(transcript, "{}\n");
  const old = new Date(NOW - 40 * DAY_MS);
  fs.utimesSync(transcript, old, old);
  const linkedProjectsDir = path.join(root, "projects");
  fs.symlinkSync(outside, linkedProjectsDir);

  assert.throws(
    () =>
      scanCold({
        projectsDir: linkedProjectsDir,
        minedSessions: new Set(),
        coldDays: 30,
        now: NOW,
        scopePrefixes: TEST_SCOPE,
      }),
    /projects directory is a symbolic link/,
  );
});

test("useInternalTimestamps catches an old session whose mtime was reset (worktree)", () => {
  // Simulate a copied worktree: recent mtime (warm) but old internal session time.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cmk-proj-"));
  const dir = path.join(root, "proj");
  fs.mkdirSync(dir, { recursive: true });
  const f = path.join(dir, "old-session.jsonl");
  const internalIso = new Date(NOW - 40 * DAY_MS).toISOString();
  fs.writeFileSync(
    f,
    JSON.stringify({ type: "user", timestamp: internalIso }) + "\n",
  );
  const recent = new Date(NOW - 1 * DAY_MS); // mtime reset to 1 day ago
  fs.utimesSync(f, recent, recent);

  // mtime-only: looks warm (1 day) -> not cold
  assert.deepEqual(
    scanCold({
      projectsDir: root,
      minedSessions: new Set(),
      coldDays: 30,
      now: NOW,
      scopePrefixes: TEST_SCOPE,
    }).map((c) => c.session_id),
    [],
  );
  // internal timestamps: true age 40 days -> cold, and flagged as internal-sourced
  const c = scanCold({
    projectsDir: root,
    minedSessions: new Set(),
    coldDays: 30,
    now: NOW,
    scopePrefixes: TEST_SCOPE,
    useInternalTimestamps: true,
  });
  assert.equal(c.length, 1);
  assert.equal(c[0]?.session_id, "old-session");
  assert.equal(c[0]?.ageSource, "internal");
  assert.ok((c[0]?.ageDays ?? 0) >= 39);
});

test("does not use an internal timestamp after the transcript path changes", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cmk-proj-"));
  const projectDir = path.join(root, "personal-project");
  const transcript = path.join(projectDir, "session.jsonl");
  const outside = path.join(root, "outside.jsonl");
  fs.mkdirSync(projectDir, { recursive: true });
  fs.writeFileSync(
    transcript,
    JSON.stringify({
      type: "user",
      timestamp: new Date(NOW - 40 * DAY_MS).toISOString(),
    }) + "\n",
  );
  fs.writeFileSync(outside, "{}\n");
  const recent = new Date(NOW - 1 * DAY_MS);
  fs.utimesSync(transcript, recent, recent);

  const originalOpenSync = fs.openSync;
  fs.openSync = ((pathname: fs.PathLike, flags: string | number) => {
    const descriptor = originalOpenSync(pathname, flags);
    if (pathname === transcript) {
      fs.rmSync(transcript);
      fs.symlinkSync(outside, transcript);
    }
    return descriptor;
  }) as typeof fs.openSync;
  try {
    assert.deepEqual(
      scanCold({
        projectsDir: root,
        minedSessions: new Set(),
        coldDays: 30,
        now: NOW,
        scopePrefixes: TEST_SCOPE,
        useInternalTimestamps: true,
      }),
      [],
    );
  } finally {
    fs.openSync = originalOpenSync;
  }
});

test("missing projects dir is empty, not an error", () => {
  assert.deepEqual(
    scanCold({
      projectsDir: "/no/such/dir",
      minedSessions: new Set(),
      coldDays: 30,
      now: NOW,
      scopePrefixes: TEST_SCOPE,
    }),
    [],
  );
});

test("skips out-of-scope transcript files before reading their contents", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cmk-proj-"));
  const personalDir = path.join(root, "personal-project");
  const workDir = path.join(root, "work-project");
  const old = new Date(NOW - 40 * DAY_MS);
  fs.mkdirSync(personalDir, { recursive: true });
  fs.mkdirSync(workDir, { recursive: true });
  const personalTranscript = path.join(personalDir, "personal.jsonl");
  const workTranscript = path.join(workDir, "work.jsonl");
  fs.writeFileSync(personalTranscript, "{}\n");
  fs.writeFileSync(workTranscript, "{}\n");
  fs.utimesSync(personalTranscript, old, old);
  fs.utimesSync(workTranscript, old, old);

  const originalReadFileSync = fs.readFileSync;
  let readOutsideScope = false;
  fs.readFileSync = ((pathname: fs.PathOrFileDescriptor, options?: unknown) => {
    if (pathname === workTranscript) readOutsideScope = true;
    return originalReadFileSync(pathname, options as never);
  }) as typeof fs.readFileSync;
  try {
    const candidates = scanCold({
      projectsDir: root,
      minedSessions: new Set(),
      coldDays: 30,
      now: NOW,
      useInternalTimestamps: true,
      scopePrefixes: ["personal-"],
    });
    assert.deepEqual(
      candidates.map((candidate) => candidate.slug),
      ["personal-project"],
    );
  } finally {
    fs.readFileSync = originalReadFileSync;
  }
  assert.equal(readOutsideScope, false);
});

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fingerprintContents } from "./fingerprint.ts";
import { appendPendingArchive, readLedger } from "./ledger.ts";
import { finalizeTranscript, recoverPendingArchives } from "./finalize.ts";

const PAYLOAD_FINGERPRINT = fingerprintContents(Buffer.from("PAYLOAD\n"));

function setup(): {
  root: string;
  source: string;
  projectsDir: string;
  archiveDir: string;
  ledgerFile: string;
  expectedFingerprint: string;
} {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cmk-finalize-"));
  const projectsDir = path.join(root, "projects");
  const projectDir = path.join(projectsDir, "proj");
  const source = path.join(projectDir, "session.jsonl");
  const archiveDir = path.join(root, ".transcript-archive");
  const ledgerFile = path.join(
    root,
    ".claude-memory-kit",
    "mining-ledger.jsonl",
  );
  fs.mkdirSync(projectDir, { recursive: true });
  fs.writeFileSync(source, "PAYLOAD\n");
  return {
    root,
    source,
    projectsDir,
    archiveDir,
    ledgerFile,
    expectedFingerprint: PAYLOAD_FINGERPRINT,
  };
}

test("records pending before archiving and archived after completion", () => {
  const fixture = setup();

  const result = finalizeTranscript({
    transcriptPath: fixture.source,
    slug: "proj",
    score: 14,
    outcome: "memory-written",
    memoryWritten: ["memory/lessons.md"],
    ...fixture,
    scopePrefixes: ["proj"],
    now: 1_800_000_000_000,
  });

  assert.equal(
    result.archivePath,
    path.join(fixture.archiveDir, "proj", "session.jsonl"),
  );
  assert.deepEqual(
    readLedger(fixture.ledgerFile).map((record) => record.archive_state),
    ["pending", "pending", "archived"],
  );
  assert.equal(fs.existsSync(fixture.source), false);
});

test("records the destination in pending state before completion", () => {
  const fixture = setup();

  finalizeTranscript({
    transcriptPath: fixture.source,
    slug: "proj",
    score: 14,
    outcome: "memory-written",
    memoryWritten: [],
    ...fixture,
    scopePrefixes: ["proj"],
  });

  const records = readLedger(fixture.ledgerFile);
  assert.equal(records[1]?.archive_state, "pending");
  assert.equal(
    records[1]?.archive_path,
    path.join(fixture.archiveDir, "proj", "session.jsonl"),
  );
});

test("rejects archive finalization when the reviewed fingerprint changed", () => {
  const fixture = setup();

  assert.throws(
    () =>
      finalizeTranscript({
        transcriptPath: fixture.source,
        slug: "proj",
        score: 14,
        outcome: "memory-written",
        memoryWritten: [],
        ...fixture,
        expectedFingerprint: "0".repeat(64),
        scopePrefixes: ["proj"],
      }),
    /fingerprint/,
  );
  assert.equal(fs.existsSync(fixture.source), true);
  assert.equal(fs.existsSync(fixture.ledgerFile), false);
});

test("recovery completes a pending archive without creating another memory record", () => {
  const fixture = setup();
  appendPendingArchive(fixture.ledgerFile, {
    session_id: "session",
    slug: "proj",
    processed_at: "2026-08-27T00:00:00.000Z",
    score: 14,
    outcome: "memory-written",
    memory_written: ["memory/lessons.md"],
    archive_state: "pending",
    transcript_path: fixture.source,
    source_fingerprint: PAYLOAD_FINGERPRINT,
  });

  const result = recoverPendingArchives({
    projectsDir: fixture.projectsDir,
    archiveDir: fixture.archiveDir,
    ledgerFile: fixture.ledgerFile,
    scopePrefixes: ["proj"],
    now: 1_800_000_000_000,
  });

  assert.equal(result.completed, 1);
  const records = readLedger(fixture.ledgerFile);
  assert.deepEqual(
    records.map((record) => record.archive_state),
    ["pending", "pending", "archived"],
  );
  assert.equal(
    records[1]?.archive_path,
    path.join(fixture.archiveDir, "proj", "session.jsonl"),
  );
  assert.deepEqual(records[1]?.memory_written, ["memory/lessons.md"]);
});

test("recovery keeps a source whose pending fingerprint no longer matches", () => {
  const fixture = setup();
  appendPendingArchive(fixture.ledgerFile, {
    session_id: "session",
    slug: "proj",
    processed_at: "2026-08-27T00:00:00.000Z",
    score: 14,
    outcome: "memory-written",
    memory_written: [],
    archive_state: "pending",
    transcript_path: fixture.source,
    source_fingerprint: "0".repeat(64),
  });

  const result = recoverPendingArchives({
    projectsDir: fixture.projectsDir,
    archiveDir: fixture.archiveDir,
    ledgerFile: fixture.ledgerFile,
    scopePrefixes: ["proj"],
  });

  assert.equal(result.completed, 0);
  assert.match(result.unresolved[0]?.reason ?? "", /fingerprint/);
  assert.equal(fs.existsSync(fixture.source), true);
});

test("a second recovery run leaves a completed archive unchanged", () => {
  const fixture = setup();
  appendPendingArchive(fixture.ledgerFile, {
    session_id: "session",
    slug: "proj",
    processed_at: "2026-08-27T00:00:00.000Z",
    score: 14,
    outcome: "memory-written",
    memory_written: [],
    archive_state: "pending",
    transcript_path: fixture.source,
    source_fingerprint: PAYLOAD_FINGERPRINT,
  });
  recoverPendingArchives({
    projectsDir: fixture.projectsDir,
    archiveDir: fixture.archiveDir,
    ledgerFile: fixture.ledgerFile,
    scopePrefixes: ["proj"],
  });
  const before = readLedger(fixture.ledgerFile);

  const result = recoverPendingArchives({
    projectsDir: fixture.projectsDir,
    archiveDir: fixture.archiveDir,
    ledgerFile: fixture.ledgerFile,
    scopePrefixes: ["proj"],
  });

  assert.equal(result.completed, 0);
  assert.deepEqual(readLedger(fixture.ledgerFile), before);
});

test("recovery skips a pending archive outside the explicit scope", () => {
  const fixture = setup();
  const workDir = path.join(fixture.projectsDir, "work-project");
  const workSource = path.join(workDir, "session.jsonl");
  fs.mkdirSync(workDir, { recursive: true });
  fs.writeFileSync(workSource, "PAYLOAD\n");
  appendPendingArchive(fixture.ledgerFile, {
    session_id: "session",
    slug: "work-project",
    processed_at: "2026-08-27T00:00:00.000Z",
    score: 14,
    outcome: "memory-written",
    memory_written: [],
    archive_state: "pending",
    transcript_path: workSource,
    source_fingerprint: PAYLOAD_FINGERPRINT,
  });

  const result = recoverPendingArchives({
    projectsDir: fixture.projectsDir,
    archiveDir: fixture.archiveDir,
    ledgerFile: fixture.ledgerFile,
    scopePrefixes: ["proj"],
  });

  assert.deepEqual(result, {
    completed: 0,
    skippedOutOfScope: 1,
    unresolved: [],
  });
  assert.equal(fs.existsSync(workSource), true);
  assert.equal(readLedger(fixture.ledgerFile).length, 1);
});

test("recovery completes a pending record when its recorded archive exists", () => {
  const fixture = setup();
  const archivePath = path.join(fixture.archiveDir, "proj", "session.jsonl");
  fs.mkdirSync(path.dirname(archivePath), { recursive: true });
  fs.writeFileSync(archivePath, "PAYLOAD\n");
  fs.rmSync(fixture.source);
  appendPendingArchive(fixture.ledgerFile, {
    session_id: "session",
    slug: "proj",
    processed_at: "2026-08-27T00:00:00.000Z",
    score: 14,
    outcome: "proposed-rejected",
    memory_written: [],
    archive_state: "pending",
    transcript_path: fixture.source,
    archive_path: archivePath,
    source_fingerprint: PAYLOAD_FINGERPRINT,
  });

  const result = recoverPendingArchives({
    projectsDir: fixture.projectsDir,
    archiveDir: fixture.archiveDir,
    ledgerFile: fixture.ledgerFile,
    scopePrefixes: ["proj"],
  });

  assert.equal(result.completed, 1);
  assert.equal(
    readLedger(fixture.ledgerFile).at(-1)?.archive_state,
    "archived",
  );
});

test("recovery rejects a recorded archive below a symlinked archive root", () => {
  const fixture = setup();
  const archivePath = path.join(fixture.archiveDir, "proj", "session.jsonl");
  const outsideRoot = path.join(fixture.root, "outside-archive");
  fs.mkdirSync(path.dirname(archivePath), { recursive: true });
  fs.writeFileSync(archivePath, "PAYLOAD\n");
  fs.rmSync(fixture.source);
  fs.renameSync(fixture.archiveDir, outsideRoot);
  fs.symlinkSync(outsideRoot, fixture.archiveDir);
  appendPendingArchive(fixture.ledgerFile, {
    session_id: "session",
    slug: "proj",
    processed_at: "2026-08-27T00:00:00.000Z",
    score: 14,
    outcome: "proposed-rejected",
    memory_written: [],
    archive_state: "pending",
    transcript_path: fixture.source,
    archive_path: archivePath,
    source_fingerprint: PAYLOAD_FINGERPRINT,
  });

  const result = recoverPendingArchives({
    projectsDir: fixture.projectsDir,
    archiveDir: fixture.archiveDir,
    ledgerFile: fixture.ledgerFile,
    scopePrefixes: ["proj"],
  });

  assert.equal(result.completed, 0);
  assert.equal(result.unresolved.length, 1);
  assert.equal(readLedger(fixture.ledgerFile).at(-1)?.archive_state, "pending");
});

test("recovery keeps a duplicate source when the archive root is symlinked", () => {
  const fixture = setup();
  const archivePath = path.join(fixture.archiveDir, "proj", "session.jsonl");
  const outsideRoot = path.join(fixture.root, "outside-archive");
  fs.mkdirSync(path.dirname(archivePath), { recursive: true });
  fs.writeFileSync(archivePath, "PAYLOAD\n");
  fs.renameSync(fixture.archiveDir, outsideRoot);
  fs.symlinkSync(outsideRoot, fixture.archiveDir);
  appendPendingArchive(fixture.ledgerFile, {
    session_id: "session",
    slug: "proj",
    processed_at: "2026-08-27T00:00:00.000Z",
    score: 14,
    outcome: "proposed-rejected",
    memory_written: [],
    archive_state: "pending",
    transcript_path: fixture.source,
    archive_path: archivePath,
    source_fingerprint: PAYLOAD_FINGERPRINT,
  });

  const result = recoverPendingArchives({
    projectsDir: fixture.projectsDir,
    archiveDir: fixture.archiveDir,
    ledgerFile: fixture.ledgerFile,
    scopePrefixes: ["proj"],
  });

  assert.equal(result.completed, 0);
  assert.equal(result.unresolved.length, 1);
  assert.equal(fs.existsSync(fixture.source), true);
  assert.equal(readLedger(fixture.ledgerFile).at(-1)?.archive_state, "pending");
});

test("recovery rejects a recorded archive below a symlinked archive slug", () => {
  const fixture = setup();
  const archiveSlugDir = path.join(fixture.archiveDir, "proj");
  const archivePath = path.join(archiveSlugDir, "session.jsonl");
  const outsideSlugDir = path.join(fixture.root, "outside-slug");
  fs.mkdirSync(outsideSlugDir, { recursive: true });
  fs.writeFileSync(path.join(outsideSlugDir, "session.jsonl"), "PAYLOAD\n");
  fs.mkdirSync(fixture.archiveDir, { recursive: true });
  fs.symlinkSync(outsideSlugDir, archiveSlugDir);
  fs.rmSync(fixture.source);
  appendPendingArchive(fixture.ledgerFile, {
    session_id: "session",
    slug: "proj",
    processed_at: "2026-08-27T00:00:00.000Z",
    score: 14,
    outcome: "proposed-rejected",
    memory_written: [],
    archive_state: "pending",
    transcript_path: fixture.source,
    archive_path: archivePath,
    source_fingerprint: PAYLOAD_FINGERPRINT,
  });

  const result = recoverPendingArchives({
    projectsDir: fixture.projectsDir,
    archiveDir: fixture.archiveDir,
    ledgerFile: fixture.ledgerFile,
    scopePrefixes: ["proj"],
  });

  assert.equal(result.completed, 0);
  assert.equal(result.unresolved.length, 1);
  assert.equal(readLedger(fixture.ledgerFile).at(-1)?.archive_state, "pending");
});

test("recovery reuses a recorded archive before removing a duplicate source", () => {
  const fixture = setup();
  const archivePath = path.join(fixture.archiveDir, "proj", "session.jsonl");
  fs.mkdirSync(path.dirname(archivePath), { recursive: true });
  fs.writeFileSync(archivePath, "PAYLOAD\n");
  appendPendingArchive(fixture.ledgerFile, {
    session_id: "session",
    slug: "proj",
    processed_at: "2026-08-27T00:00:00.000Z",
    score: 14,
    outcome: "proposed-rejected",
    memory_written: [],
    archive_state: "pending",
    transcript_path: fixture.source,
    archive_path: archivePath,
    source_fingerprint: PAYLOAD_FINGERPRINT,
  });

  const result = recoverPendingArchives({
    projectsDir: fixture.projectsDir,
    archiveDir: fixture.archiveDir,
    ledgerFile: fixture.ledgerFile,
    scopePrefixes: ["proj"],
  });

  assert.equal(result.completed, 1);
  assert.equal(fs.existsSync(fixture.source), false);
  assert.equal(fs.existsSync(`${archivePath}.dup1`), false);
  assert.equal(
    readLedger(fixture.ledgerFile).at(-1)?.archive_path,
    archivePath,
  );
});

test("recovery keeps the source when its recorded archive does not match", () => {
  const fixture = setup();
  const archivePath = path.join(fixture.archiveDir, "proj", "session.jsonl");
  fs.mkdirSync(path.dirname(archivePath), { recursive: true });
  fs.writeFileSync(archivePath, "DIFFERENT\n");
  appendPendingArchive(fixture.ledgerFile, {
    session_id: "session",
    slug: "proj",
    processed_at: "2026-08-27T00:00:00.000Z",
    score: 14,
    outcome: "proposed-rejected",
    memory_written: [],
    archive_state: "pending",
    transcript_path: fixture.source,
    archive_path: archivePath,
    source_fingerprint: PAYLOAD_FINGERPRINT,
  });

  const result = recoverPendingArchives({
    projectsDir: fixture.projectsDir,
    archiveDir: fixture.archiveDir,
    ledgerFile: fixture.ledgerFile,
    scopePrefixes: ["proj"],
  });

  assert.equal(result.completed, 0);
  assert.match(result.unresolved[0]?.reason ?? "", /does not match/);
  assert.equal(fs.readFileSync(fixture.source, "utf8"), "PAYLOAD\n");
  assert.equal(fs.readFileSync(archivePath, "utf8"), "DIFFERENT\n");
});

test("records an unreadable transcript without archiving it", () => {
  const fixture = setup();

  const result = finalizeTranscript({
    transcriptPath: fixture.source,
    slug: "proj",
    score: 0,
    outcome: "unreadable",
    memoryWritten: [],
    ...fixture,
    scopePrefixes: ["proj"],
  });

  assert.equal(result.archivePath, undefined);
  assert.equal(fs.existsSync(fixture.source), true);
  assert.equal(fs.existsSync(fixture.archiveDir), false);
  assert.deepEqual(
    readLedger(fixture.ledgerFile).map((record) => ({
      outcome: record.outcome,
      archiveState: record.archive_state,
    })),
    [{ outcome: "unreadable", archiveState: undefined }],
  );
});

test("records an unreadable transcript when it cannot be opened for reading", () => {
  const fixture = setup();
  const originalOpenSync = fs.openSync;
  fs.openSync = ((pathname, flags, mode) => {
    if (pathname === fixture.source) {
      const error = new Error("permission denied");
      (error as NodeJS.ErrnoException).code = "EACCES";
      throw error;
    }
    return originalOpenSync(pathname, flags, mode);
  }) as typeof fs.openSync;

  try {
    const result = finalizeTranscript({
      transcriptPath: fixture.source,
      slug: "proj",
      score: 0,
      outcome: "unreadable",
      memoryWritten: [],
      ...fixture,
      scopePrefixes: ["proj"],
    });

    assert.equal(result.archivePath, undefined);
    assert.equal(fs.existsSync(fixture.source), true);
    assert.deepEqual(
      readLedger(fixture.ledgerFile).map((record) => record.outcome),
      ["unreadable"],
    );
  } finally {
    fs.openSync = originalOpenSync;
  }
});

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fingerprintContents } from "./fingerprint.ts";
import {
  appendPendingArchive,
  minedSessions,
  pendingArchives,
  readLedger,
} from "./ledger.ts";
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
    ["pending", "pending", "pending", "archived"],
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
  assert.equal(records[1]?.archive_ready, false);
  assert.equal(records[2]?.archive_ready, true);
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

test("releases a source for rescoring when it changes during archiving", () => {
  const fixture = setup();
  const originalRenameSync = fs.renameSync;
  let sourceChanged = false;
  fs.renameSync = ((oldPath, newPath) => {
    const result = originalRenameSync(oldPath, newPath);
    if (!sourceChanged) {
      sourceChanged = true;
      fs.appendFileSync(fixture.source, "RESUMED\n");
    }
    return result;
  }) as typeof fs.renameSync;

  try {
    assert.throws(
      () =>
        finalizeTranscript({
          transcriptPath: fixture.source,
          slug: "proj",
          score: 14,
          outcome: "memory-written",
          memoryWritten: ["memory/lessons.md"],
          ...fixture,
          scopePrefixes: ["proj"],
        }),
      /source changed during archiving/,
    );
  } finally {
    fs.renameSync = originalRenameSync;
  }

  assert.equal(fs.existsSync(fixture.source), true);
  assert.deepEqual(
    readLedger(fixture.ledgerFile).map((record) => record.archive_state),
    ["pending", "pending", "pending", "aborted"],
  );
  assert.deepEqual([...minedSessions(fixture.ledgerFile)], []);
});

test(
  "records a published destination when post-publish rollback fails",
  { skip: process.platform === "win32" },
  () => {
    const fixture = setup();
    const destination = path.join(fixture.archiveDir, "proj", "session.jsonl");
    const originalOpenSync = fs.openSync;
    const originalCloseSync = fs.closeSync;
    const originalFsyncSync = fs.fsyncSync;
    const originalUnlinkSync = fs.unlinkSync;
    const descriptors = new Map<
      number,
      { pathname: string; flags: string | number }
    >();
    fs.openSync = ((pathname, flags, mode) => {
      const descriptor = originalOpenSync(pathname, flags, mode);
      descriptors.set(descriptor, {
        pathname: path.resolve(pathname.toString()),
        flags,
      });
      return descriptor;
    }) as typeof fs.openSync;
    fs.closeSync = ((descriptor: number) => {
      descriptors.delete(descriptor);
      return originalCloseSync(descriptor);
    }) as typeof fs.closeSync;
    fs.fsyncSync = ((descriptor: number) => {
      const opened = descriptors.get(descriptor);
      if (
        opened?.pathname === destination &&
        typeof opened.flags === "number" &&
        (opened.flags & fs.constants.O_WRONLY) !== 0
      ) {
        throw new Error("post-publish sync failed");
      }
      return originalFsyncSync(descriptor);
    }) as typeof fs.fsyncSync;
    fs.unlinkSync = ((pathname) => {
      if (path.resolve(pathname.toString()) === destination) {
        throw new Error("rollback unlink failed");
      }
      return originalUnlinkSync(pathname);
    }) as typeof fs.unlinkSync;

    try {
      assert.throws(
        () =>
          finalizeTranscript({
            transcriptPath: fixture.source,
            slug: "proj",
            score: 14,
            outcome: "memory-written",
            memoryWritten: [],
            ...fixture,
            scopePrefixes: ["proj"],
          }),
        /archive rollback failed after post-publish sync failed/,
      );
    } finally {
      fs.openSync = originalOpenSync;
      fs.closeSync = originalCloseSync;
      fs.fsyncSync = originalFsyncSync;
      fs.unlinkSync = originalUnlinkSync;
    }

    assert.equal(fs.existsSync(fixture.source), true);
    assert.equal(fs.existsSync(destination), true);
    assert.deepEqual(
      readLedger(fixture.ledgerFile).map((record) => record.archive_state),
      ["pending", "pending"],
    );
    assert.equal(
      pendingArchives(fixture.ledgerFile)[0]?.archive_path,
      destination,
    );
  },
);

test(
  "keeps a pending attempt when source-change rollback cannot sync",
  { skip: process.platform === "win32" },
  () => {
    const fixture = setup();
    const archiveSlugDir = path.join(fixture.archiveDir, "proj");
    const originalRenameSync = fs.renameSync;
    const originalOpenSync = fs.openSync;
    const originalCloseSync = fs.closeSync;
    const originalFsyncSync = fs.fsyncSync;
    const directoryDescriptors = new Map<number, string>();
    let sourceChanged = false;
    let archiveSlugSyncsAfterLink = 0;
    fs.renameSync = ((oldPath, newPath) => {
      const result = originalRenameSync(oldPath, newPath);
      if (!sourceChanged) {
        sourceChanged = true;
        fs.appendFileSync(fixture.source, "RESUMED\n");
      }
      return result;
    }) as typeof fs.renameSync;
    fs.openSync = ((pathname, flags, mode) => {
      const descriptor = originalOpenSync(pathname, flags, mode);
      if (
        typeof flags === "number" &&
        (flags & fs.constants.O_DIRECTORY) !== 0
      ) {
        directoryDescriptors.set(descriptor, path.resolve(pathname.toString()));
      }
      return descriptor;
    }) as typeof fs.openSync;
    fs.closeSync = ((descriptor: number) => {
      directoryDescriptors.delete(descriptor);
      return originalCloseSync(descriptor);
    }) as typeof fs.closeSync;
    fs.fsyncSync = ((descriptor: number) => {
      if (directoryDescriptors.get(descriptor) === archiveSlugDir) {
        archiveSlugSyncsAfterLink += 1;
        if (sourceChanged && archiveSlugSyncsAfterLink === 2) {
          throw new Error("rollback sync failed");
        }
      }
      return originalFsyncSync(descriptor);
    }) as typeof fs.fsyncSync;

    try {
      assert.throws(
        () =>
          finalizeTranscript({
            transcriptPath: fixture.source,
            slug: "proj",
            score: 14,
            outcome: "memory-written",
            memoryWritten: [],
            ...fixture,
            scopePrefixes: ["proj"],
          }),
        /archive rollback failed/,
      );
    } finally {
      fs.renameSync = originalRenameSync;
      fs.openSync = originalOpenSync;
      fs.closeSync = originalCloseSync;
      fs.fsyncSync = originalFsyncSync;
    }

    assert.equal(fs.existsSync(fixture.source), true);
    assert.deepEqual(
      readLedger(fixture.ledgerFile).map((record) => record.archive_state),
      ["pending", "pending", "pending"],
    );
    assert.deepEqual([...minedSessions(fixture.ledgerFile)], ["session"]);
  },
);

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
    ["pending", "pending", "pending", "archived"],
  );
  assert.equal(
    records[1]?.archive_path,
    path.join(fixture.archiveDir, "proj", "session.jsonl"),
  );
  assert.deepEqual(records[1]?.memory_written, ["memory/lessons.md"]);
});

test("recovery replaces an empty reserved destination", () => {
  const fixture = setup();
  const reservedPath = path.join(fixture.archiveDir, "proj", "session.jsonl");
  fs.mkdirSync(path.dirname(reservedPath), { recursive: true });
  fs.writeFileSync(reservedPath, "");
  appendPendingArchive(fixture.ledgerFile, {
    session_id: "session",
    slug: "proj",
    processed_at: "2026-08-27T00:00:00.000Z",
    score: 14,
    outcome: "memory-written",
    memory_written: [],
    archive_state: "pending",
    transcript_path: fixture.source,
    archive_path: reservedPath,
    archive_ready: false,
    source_fingerprint: PAYLOAD_FINGERPRINT,
    attempt_id: "reserved-attempt",
  });

  const result = recoverPendingArchives({
    projectsDir: fixture.projectsDir,
    archiveDir: fixture.archiveDir,
    ledgerFile: fixture.ledgerFile,
    scopePrefixes: ["proj"],
  });

  assert.equal(result.completed, 1);
  assert.equal(fs.existsSync(fixture.source), false);
  assert.equal(
    readLedger(fixture.ledgerFile).at(-1)?.archive_path,
    path.join(fixture.archiveDir, "proj", "session.dup1.jsonl"),
  );
});

test("recovery completes a payload published before its ready event", () => {
  const fixture = setup();
  const reservedPath = path.join(fixture.archiveDir, "proj", "session.jsonl");
  fs.mkdirSync(path.dirname(reservedPath), { recursive: true });
  fs.writeFileSync(reservedPath, "PAYLOAD\n");
  appendPendingArchive(fixture.ledgerFile, {
    session_id: "session",
    slug: "proj",
    processed_at: "2026-08-27T00:00:00.000Z",
    score: 14,
    outcome: "memory-written",
    memory_written: [],
    archive_state: "pending",
    transcript_path: fixture.source,
    archive_path: reservedPath,
    archive_ready: false,
    source_fingerprint: PAYLOAD_FINGERPRINT,
    attempt_id: "published-before-ready",
  });

  const result = recoverPendingArchives({
    projectsDir: fixture.projectsDir,
    archiveDir: fixture.archiveDir,
    ledgerFile: fixture.ledgerFile,
    scopePrefixes: ["proj"],
  });

  assert.equal(result.completed, 1);
  assert.equal(fs.existsSync(fixture.source), false);
  assert.equal(
    readLedger(fixture.ledgerFile).at(-1)?.archive_path,
    reservedPath,
  );
});

test("recovery releases a source whose pending fingerprint no longer matches", () => {
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
    attempt_id: "current-attempt",
  });

  const result = recoverPendingArchives({
    projectsDir: fixture.projectsDir,
    archiveDir: fixture.archiveDir,
    ledgerFile: fixture.ledgerFile,
    scopePrefixes: ["proj"],
  });

  assert.equal(result.completed, 0);
  assert.deepEqual(result.unresolved, []);
  assert.equal(fs.existsSync(fixture.source), true);
  assert.equal(readLedger(fixture.ledgerFile).at(-1)?.archive_state, "aborted");
  assert.deepEqual([...minedSessions(fixture.ledgerFile)], []);
});

test("recovery retains a legacy pending record when its source changed", () => {
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
  assert.match(result.unresolved[0]?.reason ?? "", /attempt identity/);
  assert.deepEqual(
    readLedger(fixture.ledgerFile).map((record) => record.archive_state),
    ["pending"],
  );
  assert.deepEqual([...minedSessions(fixture.ledgerFile)], ["session"]);
});

test("recovery retains a destination-bound pending attempt when its source changed", () => {
  const fixture = setup();
  const archivePath = path.join(fixture.archiveDir, "proj", "session.jsonl");
  fs.mkdirSync(path.dirname(archivePath), { recursive: true });
  fs.writeFileSync(archivePath, "PAYLOAD\n");
  appendPendingArchive(fixture.ledgerFile, {
    session_id: "session",
    slug: "proj",
    processed_at: "2026-08-27T00:00:00.000Z",
    score: 14,
    outcome: "memory-written",
    memory_written: [],
    archive_state: "pending",
    transcript_path: fixture.source,
    archive_path: archivePath,
    source_fingerprint: PAYLOAD_FINGERPRINT,
    attempt_id: "destination-bound",
  });
  fs.appendFileSync(fixture.source, "RESUMED\n");

  const result = recoverPendingArchives({
    projectsDir: fixture.projectsDir,
    archiveDir: fixture.archiveDir,
    ledgerFile: fixture.ledgerFile,
    scopePrefixes: ["proj"],
  });

  assert.equal(result.completed, 0);
  assert.match(result.unresolved[0]?.reason ?? "", /fingerprint/);
  assert.deepEqual(
    readLedger(fixture.ledgerFile).map((record) => record.archive_state),
    ["pending"],
  );
  assert.equal(
    pendingArchives(fixture.ledgerFile)[0]?.archive_path,
    archivePath,
  );
  assert.deepEqual([...minedSessions(fixture.ledgerFile)], ["session"]);
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
  assert.equal(
    readLedger(fixture.ledgerFile).at(-1)?.source_fingerprint,
    fixture.expectedFingerprint,
  );
  assert.deepEqual([...minedSessions(fixture.ledgerFile)], []);
});

test("rejects an unreadable outcome when the reviewed bytes changed", () => {
  const fixture = setup();
  fs.writeFileSync(fixture.source, "REPAIRED\n");

  assert.throws(
    () =>
      finalizeTranscript({
        transcriptPath: fixture.source,
        slug: "proj",
        score: 0,
        outcome: "unreadable",
        memoryWritten: [],
        ...fixture,
        scopePrefixes: ["proj"],
      }),
    /fingerprint changed since review/,
  );
  assert.equal(fs.readFileSync(fixture.source, "utf8"), "REPAIRED\n");
  assert.equal(fs.existsSync(fixture.ledgerFile), false);
});

test("rejects an unreadable outcome when its source changes during hashing", () => {
  const fixture = setup();
  const originalReadSync = fs.readSync;
  let sourceChanged = false;
  fs.readSync = ((descriptor, buffer, offset, length, position) => {
    const bytesRead = originalReadSync(
      descriptor,
      buffer,
      offset,
      length,
      position,
    );
    if (!sourceChanged) {
      sourceChanged = true;
      fs.writeFileSync(fixture.source, "CHANGED\n");
    }
    return bytesRead;
  }) as typeof fs.readSync;

  try {
    assert.throws(
      () =>
        finalizeTranscript({
          transcriptPath: fixture.source,
          slug: "proj",
          score: 0,
          outcome: "unreadable",
          memoryWritten: [],
          ...fixture,
          scopePrefixes: ["proj"],
        }),
      /source changed during fingerprint validation/,
    );
    assert.equal(fs.existsSync(fixture.ledgerFile), false);
  } finally {
    fs.readSync = originalReadSync;
  }
});

test("rejects an unreadable transcript when it cannot be opened for reading", () => {
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
    assert.throws(
      () =>
        finalizeTranscript({
          transcriptPath: fixture.source,
          slug: "proj",
          score: 0,
          outcome: "unreadable",
          memoryWritten: [],
          ...fixture,
          scopePrefixes: ["proj"],
        }),
      /permission denied/,
    );
    assert.equal(fs.existsSync(fixture.source), true);
    assert.equal(fs.existsSync(fixture.ledgerFile), false);
  } finally {
    fs.openSync = originalOpenSync;
  }
});

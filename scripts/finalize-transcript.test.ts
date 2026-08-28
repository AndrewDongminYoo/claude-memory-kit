import { test } from "node:test";
import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const finalizeTranscript = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "finalize-transcript.ts",
);

test("requires a reviewed fingerprint for archivable finalization", () => {
  const configRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "cmk-finalize-cli-"),
  );
  const source = path.join(
    configRoot,
    "projects",
    "personal-project",
    "session.jsonl",
  );
  fs.mkdirSync(path.dirname(source), { recursive: true });
  fs.writeFileSync(source, "PAYLOAD\n");

  const result = childProcess.spawnSync(
    process.execPath,
    [
      "--import",
      "tsx",
      finalizeTranscript,
      source,
      "personal-project",
      "0",
      "skipped-low-score",
    ],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        CLAUDE_CONFIG_DIR: configRoot,
        CMK_SCOPE_SLUG_PREFIXES: "personal-",
      },
    },
  );

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /fingerprint/);
  assert.equal(fs.existsSync(source), true);
});

test("uses the supplied reviewed fingerprint for archivable finalization", () => {
  const configRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "cmk-finalize-cli-"),
  );
  const source = path.join(
    configRoot,
    "projects",
    "personal-project",
    "session.jsonl",
  );
  const contents = "PAYLOAD\n";
  fs.mkdirSync(path.dirname(source), { recursive: true });
  fs.writeFileSync(source, contents);

  const result = childProcess.spawnSync(
    process.execPath,
    [
      "--import",
      "tsx",
      finalizeTranscript,
      source,
      "personal-project",
      "0",
      "skipped-low-score",
      createHash("sha256").update(contents).digest("hex"),
    ],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        CLAUDE_CONFIG_DIR: configRoot,
        CMK_SCOPE_SLUG_PREFIXES: "personal-",
      },
    },
  );

  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.existsSync(source), false);
});

test("rejects an out-of-scope transcript before writing a ledger record", () => {
  const configRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "cmk-finalize-cli-"),
  );
  const source = path.join(
    configRoot,
    "projects",
    "work-project",
    "session.jsonl",
  );
  fs.mkdirSync(path.dirname(source), { recursive: true });
  fs.writeFileSync(source, "PAYLOAD\n");

  const result = childProcess.spawnSync(
    process.execPath,
    [
      "--import",
      "tsx",
      finalizeTranscript,
      source,
      "work-project",
      "0",
      "unreadable",
    ],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        CLAUDE_CONFIG_DIR: configRoot,
        CMK_SCOPE_SLUG_PREFIXES: "personal-",
      },
    },
  );

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /outside CMK_SCOPE_SLUG_PREFIXES/);
  assert.equal(fs.existsSync(source), true);
  assert.equal(
    fs.existsSync(
      path.join(configRoot, ".claude-memory-kit", "mining-ledger.jsonl"),
    ),
    false,
  );
});

test("rejects a transcript path that does not belong to its declared slug", () => {
  const configRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "cmk-finalize-cli-"),
  );
  const source = path.join(
    configRoot,
    "projects",
    "work-project",
    "session.jsonl",
  );
  fs.mkdirSync(path.dirname(source), { recursive: true });
  fs.writeFileSync(source, "PAYLOAD\n");

  const result = childProcess.spawnSync(
    process.execPath,
    [
      "--import",
      "tsx",
      finalizeTranscript,
      source,
      "personal-project",
      "0",
      "unreadable",
    ],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        CLAUDE_CONFIG_DIR: configRoot,
        CMK_SCOPE_SLUG_PREFIXES: "personal-",
      },
    },
  );

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /not a direct transcript/);
  assert.equal(fs.existsSync(source), true);
  assert.equal(
    fs.existsSync(
      path.join(configRoot, ".claude-memory-kit", "mining-ledger.jsonl"),
    ),
    false,
  );
});

test("rejects a scoped-looking slug with path segments before ledger writes", () => {
  const configRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "cmk-finalize-cli-"),
  );
  const source = path.join(
    configRoot,
    "projects",
    "work-project",
    "session.jsonl",
  );
  fs.mkdirSync(path.dirname(source), { recursive: true });
  fs.writeFileSync(source, "PAYLOAD\n");

  const result = childProcess.spawnSync(
    process.execPath,
    [
      "--import",
      "tsx",
      finalizeTranscript,
      source,
      "personal-/../work-project",
      "0",
      "unreadable",
    ],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        CLAUDE_CONFIG_DIR: configRoot,
        CMK_SCOPE_SLUG_PREFIXES: "personal-",
      },
    },
  );

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /not a single project slug/);
  assert.equal(fs.existsSync(source), true);
  assert.equal(
    fs.existsSync(
      path.join(configRoot, ".claude-memory-kit", "mining-ledger.jsonl"),
    ),
    false,
  );
});

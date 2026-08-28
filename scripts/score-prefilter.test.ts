import { test } from "node:test";
import assert from "node:assert/strict";
import childProcess from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scorePrefilter = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "score-prefilter.ts",
);

function runScorePrefilter(
  files: string[],
  env: NodeJS.ProcessEnv = process.env,
  preloadPaths: string[] = [],
) {
  return childProcess.spawnSync(
    process.execPath,
    [
      "--import",
      "tsx",
      ...preloadPaths.flatMap((preloadPath) => ["--import", preloadPath]),
      scorePrefilter,
      ...files,
    ],
    {
      encoding: "utf8",
      env: {
        ...env,
        CMK_SCOPE_SLUG_PREFIXES:
          env.CMK_SCOPE_SLUG_PREFIXES ?? "cmk-score-cli-",
      },
    },
  );
}

function runScorePrefilterWithFdLimit(
  files: string[],
  env: NodeJS.ProcessEnv = process.env,
) {
  return childProcess.spawnSync(
    "/bin/bash",
    [
      "--noprofile",
      "--norc",
      "-c",
      'ulimit -n 64; exec "$@"',
      "score-prefilter",
      process.execPath,
      "--import",
      "tsx",
      scorePrefilter,
      ...files,
    ],
    {
      encoding: "utf8",
      env: {
        ...env,
        CMK_SCOPE_SLUG_PREFIXES:
          env.CMK_SCOPE_SLUG_PREFIXES ?? "cmk-score-cli-",
      },
    },
  );
}

test("reports malformed JSONL as unreadable and never selects it", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cmk-score-cli-"));
  const transcript = path.join(
    root,
    "projects",
    "cmk-score-cli-project",
    "invalid.jsonl",
  );
  fs.mkdirSync(path.dirname(transcript), { recursive: true });
  fs.writeFileSync(transcript, "{ invalid\n");

  const result = runScorePrefilter([transcript], {
    ...process.env,
    CLAUDE_CONFIG_DIR: root,
  });

  assert.equal(result.status, 0, result.stderr);
  const row = JSON.parse(result.stdout) as Record<string, unknown>;
  assert.equal(row.unreadable, true);
  assert.equal(row.selected, false);
});

test("reports a removed in-scope transcript as missing and scores the batch", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cmk-score-cli-"));
  const transcript = path.join(
    root,
    "projects",
    "cmk-score-cli-project",
    "removed.jsonl",
  );
  fs.mkdirSync(path.dirname(transcript), { recursive: true });

  const result = runScorePrefilter([transcript], {
    ...process.env,
    CLAUDE_CONFIG_DIR: root,
  });

  assert.equal(result.status, 0, result.stderr);
  const row = JSON.parse(result.stdout) as Record<string, unknown>;
  assert.equal(row.missing, true);
  assert.equal(row.unreadable, undefined);
  assert.equal(row.selected, false);
  assert.match(String(row.error), /ENOENT/);
});

test("reports access-denied transcripts as unreadable instead of missing", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cmk-score-cli-"));
  const transcript = path.join(
    root,
    "projects",
    "cmk-score-cli-project",
    "restricted.jsonl",
  );
  const preloadPath = path.join(root, "mock-open.mjs");
  fs.mkdirSync(path.dirname(transcript), { recursive: true });
  fs.writeFileSync(transcript, "PAYLOAD\n");
  fs.writeFileSync(
    preloadPath,
    [
      'import fs from "node:fs";',
      "const originalOpenSync = fs.openSync;",
      "fs.openSync = (pathname, flags, mode) => {",
      "  if (String(pathname) === process.env.CMK_TEST_OPEN_PATH) {",
      "    const error = new Error(`mock ${process.env.CMK_TEST_OPEN_ERROR}`);",
      "    error.code = process.env.CMK_TEST_OPEN_ERROR;",
      "    throw error;",
      "  }",
      "  return originalOpenSync(pathname, flags, mode);",
      "};",
    ].join("\n"),
  );

  for (const code of ["EACCES", "EPERM"]) {
    const result = runScorePrefilter(
      [transcript],
      {
        ...process.env,
        CLAUDE_CONFIG_DIR: root,
        CMK_TEST_OPEN_PATH: transcript,
        CMK_TEST_OPEN_ERROR: code,
      },
      [preloadPath],
    );

    assert.equal(result.status, 0, result.stderr);
    const row = JSON.parse(result.stdout) as Record<string, unknown>;
    assert.equal(row.unreadable, true);
    assert.equal(row.missing, undefined);
    assert.equal(row.selected, false);
    assert.match(String(row.error), new RegExp(code));
  }
});

test("rejects a fractional MAX_PER_PROJECT before reading transcripts", () => {
  const configRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "cmk-score-config-"),
  );
  const result = runScorePrefilter(["/not/read.jsonl"], {
    ...process.env,
    CLAUDE_CONFIG_DIR: configRoot,
    MAX_PER_PROJECT: "1.5",
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /invalid MAX_PER_PROJECT/);
});

test(
  "scores a large batch without retaining all transcript descriptors",
  { skip: process.platform === "win32" },
  () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "cmk-score-cli-"));
    const projectDir = path.join(root, "projects", "cmk-score-cli-project");
    fs.mkdirSync(projectDir, { recursive: true });
    const transcripts = Array.from({ length: 128 }, (_, index) => {
      const transcript = path.join(projectDir, `session-${index}.jsonl`);
      fs.writeFileSync(
        transcript,
        JSON.stringify({
          type: "user",
          message: { role: "user", content: `session ${index}` },
        }) + "\n",
      );
      return transcript;
    });

    const result = runScorePrefilterWithFdLimit(transcripts, {
      ...process.env,
      CLAUDE_CONFIG_DIR: root,
    });

    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim().split("\n").length, transcripts.length);
  },
);

test("deduplicates normalized transcript aliases before selection", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cmk-score-cli-"));
  const transcript = path.join(
    root,
    "projects",
    "cmk-score-cli-project",
    "worthy.jsonl",
  );
  fs.mkdirSync(path.dirname(transcript), { recursive: true });
  fs.writeFileSync(
    transcript,
    [
      {
        type: "user",
        message: { role: "user", content: "actually use the smaller fix" },
      },
      {
        type: "assistant",
        message: { role: "assistant", content: "root cause found and fixed" },
      },
      {
        type: "user",
        message: { role: "user", content: "revert the prior approach" },
      },
      {
        type: "assistant",
        message: { role: "assistant", content: "committed the decision" },
      },
    ]
      .map((entry) => JSON.stringify(entry))
      .join("\n") + "\n",
  );

  const alias = `${path.dirname(transcript)}/../${path.basename(
    path.dirname(transcript),
  )}/${path.basename(transcript)}`;
  assert.notEqual(alias, transcript);

  const result = runScorePrefilter([transcript, alias], {
    ...process.env,
    CLAUDE_CONFIG_DIR: root,
    MAX_PER_PROJECT: "1",
  });

  assert.equal(result.status, 0, result.stderr);
  const rows = result.stdout
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.selected, true);
});

test("rejects an out-of-scope transcript before scoring it", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cmk-score-cli-"));
  const transcript = path.join(root, "outside.jsonl");
  fs.writeFileSync(transcript, "{ invalid\n");

  const result = runScorePrefilter([transcript], {
    ...process.env,
    CLAUDE_CONFIG_DIR: root,
    CMK_SCOPE_SLUG_PREFIXES: "personal-",
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /outside CMK_SCOPE_SLUG_PREFIXES/);
  assert.equal(fs.readFileSync(transcript, "utf8"), "{ invalid\n");
});

test("rejects an allowed-looking path outside the configured projects directory", () => {
  const configRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "cmk-score-config-"),
  );
  const outsideRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "cmk-score-outside-"),
  );
  const transcript = path.join(outsideRoot, "personal-project", "secret.jsonl");
  fs.mkdirSync(path.dirname(transcript), { recursive: true });
  fs.writeFileSync(transcript, "{ invalid\n");

  const result = runScorePrefilter([transcript], {
    ...process.env,
    CLAUDE_CONFIG_DIR: configRoot,
    CMK_SCOPE_SLUG_PREFIXES: "personal-",
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /not a direct transcript/);
  assert.equal(fs.readFileSync(transcript, "utf8"), "{ invalid\n");
});

test("rejects a symlinked transcript before scoring its target", () => {
  const configRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "cmk-score-config-"),
  );
  const outsideRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "cmk-score-outside-"),
  );
  const projectDir = path.join(configRoot, "projects", "personal-project");
  const target = path.join(outsideRoot, "secret.jsonl");
  const transcript = path.join(projectDir, "session.jsonl");
  fs.mkdirSync(projectDir, { recursive: true });
  fs.writeFileSync(target, "{ invalid\n");
  fs.symlinkSync(target, transcript);

  const result = runScorePrefilter([transcript], {
    ...process.env,
    CLAUDE_CONFIG_DIR: configRoot,
    CMK_SCOPE_SLUG_PREFIXES: "personal-",
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /symbolic link/);
  assert.equal(fs.readFileSync(target, "utf8"), "{ invalid\n");
});

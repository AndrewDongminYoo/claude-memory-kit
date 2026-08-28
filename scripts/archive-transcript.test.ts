import { test } from "node:test";
import assert from "node:assert/strict";
import childProcess from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const archiveTranscript = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "archive-transcript.ts",
);

test("rejects an out-of-scope transcript before archiving it", () => {
  const configRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cmk-archive-cli-"));
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
    ["--import", "tsx", archiveTranscript, source, "work-project"],
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
    fs.existsSync(path.join(configRoot, ".transcript-archive")),
    false,
  );
});

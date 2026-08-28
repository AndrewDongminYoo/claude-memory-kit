import { test } from "node:test";
import assert from "node:assert/strict";
import childProcess from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const recoverPendingArchives = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "recover-pending-archives.ts",
);

test("fails closed without scope even when no archives are pending", () => {
  const configRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cmk-recover-cli-"));
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    CLAUDE_CONFIG_DIR: configRoot,
  };
  delete env.CMK_SCOPE_SLUG_PREFIXES;

  const result = childProcess.spawnSync(
    process.execPath,
    ["--import", "tsx", recoverPendingArchives],
    { encoding: "utf8", env },
  );

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /CMK_SCOPE_SLUG_PREFIXES is required/);
});

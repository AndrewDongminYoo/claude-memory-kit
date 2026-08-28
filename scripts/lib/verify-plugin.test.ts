import { test } from "node:test";
import assert from "node:assert/strict";
import childProcess from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { verifyPluginCopy } from "./verify-plugin.ts";

const pluginRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);

test("runs compiled scan and score commands from a copy without node_modules", () => {
  const result = verifyPluginCopy(pluginRoot);

  assert.equal(result.runtimeChecks, 9);
  const claude = childProcess.spawnSync("claude", ["--version"], {
    encoding: "utf8",
  });
  assert.equal(
    result.metadataChecks,
    (claude.error as NodeJS.ErrnoException | undefined)?.code === "ENOENT"
      ? 0
      : 1,
  );
});

test("rejects a temporary fixture base inside the Claude configuration root", () => {
  const claudeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cmk-config-"));

  assert.throws(
    () =>
      verifyPluginCopy(pluginRoot, {
        claudeRoot,
        temporaryBase: claudeRoot,
      }),
    /temporary fixture base must not be inside the Claude configuration root/,
  );
});

test("rejects a temporary fixture base symlinked into the Claude configuration root", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cmk-config-"));
  const claudeRoot = path.join(root, "claude-config");
  const temporaryBase = path.join(root, "temporary-link");
  fs.mkdirSync(claudeRoot);
  fs.symlinkSync(claudeRoot, temporaryBase);

  assert.throws(
    () =>
      verifyPluginCopy(pluginRoot, {
        claudeRoot,
        temporaryBase,
      }),
    /temporary fixture base must not be inside the Claude configuration root/,
  );
});

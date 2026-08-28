import { test } from "node:test";
import assert from "node:assert/strict";
import childProcess from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);

function readJson(relativePath: string): Record<string, unknown> {
  return JSON.parse(
    fs.readFileSync(path.join(repoRoot, relativePath), "utf8"),
  ) as Record<string, unknown>;
}

function readText(relativePath: string): string {
  return fs.readFileSync(path.join(repoRoot, relativePath), "utf8");
}

test("plugin metadata declares only the implemented skill", () => {
  const manifest = readJson(".claude-plugin/plugin.json");
  const marketplace = readJson(".claude-plugin/marketplace.json");
  const packageJson = readJson("package.json");
  const skillNames = fs
    .readdirSync(path.join(repoRoot, "skills"), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();

  assert.deepEqual(skillNames, ["mine-stale-transcripts"]);
  assert.equal(typeof manifest.author, "object");
  assert.doesNotMatch(
    JSON.stringify(manifest),
    /merge split-path|promote repeated|per-project config/i,
  );
  assert.equal(typeof marketplace.description, "string");
  assert.equal(
    (packageJson.scripts as Record<string, unknown> | undefined)?.build,
    "tsc -p tsconfig.build.json",
  );
});

test("built entry points parse with Node.js", () => {
  for (const entryPoint of [
    "finalize-transcript.js",
    "recover-pending-archives.js",
    "scan-cold.js",
    "score-prefilter.js",
    "verify-plugin.js",
  ]) {
    const outputPath = path.join(repoRoot, "dist", entryPoint);
    assert.equal(fs.existsSync(outputPath), true, `${entryPoint} should exist`);
    const result = childProcess.spawnSync(
      process.execPath,
      ["--check", outputPath],
      {
        encoding: "utf8",
      },
    );
    assert.equal(result.status, 0, result.stderr);
  }
});

test("does not publish an archive-only entry point that bypasses finalization", () => {
  for (const pathFromRoot of [
    "scripts/archive-transcript.ts",
    "dist/archive-transcript.js",
  ]) {
    assert.equal(fs.existsSync(path.join(repoRoot, pathFromRoot)), false);
  }
});

test("published instructions use the implemented Node.js runtime contract", () => {
  const readme = readText("README.md");
  const skill = readText("skills/mine-stale-transcripts/SKILL.md");

  assert.doesNotMatch(
    readme,
    /merge split-path memory|promote repeated rules/i,
  );
  assert.match(readme, /Node\.js 22\.23\.2 or later/);
  assert.match(readme, /`CMK_SCOPE_SLUG_PREFIXES`/);
  assert.match(skill, /node "\$\{CLAUDE_PLUGIN_ROOT\}\/dist\/scan-cold\.js"/);
  assert.match(skill, /CMK_SCOPE_SLUG_PREFIXES=/);
  assert.match(
    skill,
    /node "\$\{CLAUDE_PLUGIN_ROOT\}\/dist\/finalize-transcript\.js"/,
  );
  assert.doesNotMatch(skill, /tsx "\$\{CLAUDE_PLUGIN_ROOT\}\/scripts\//);
});

test("CI builds and verifies the distributable plugin", () => {
  const workflow = readText(".github/workflows/ci.yml");

  assert.match(workflow, /- name: Build distribution\s+run: pnpm build/);
  assert.ok(
    workflow.indexOf("- name: Build distribution") <
      workflow.indexOf("- name: Test"),
    "CI must build the distribution before tests parse the built entry points",
  );
  assert.match(
    workflow,
    /- name: Check committed distribution\s+run: git diff --exit-code -- dist/,
  );
  assert.ok(
    workflow.indexOf("- name: Build distribution") <
      workflow.indexOf("- name: Check committed distribution") &&
      workflow.indexOf("- name: Check committed distribution") <
        workflow.indexOf("- name: Test") &&
      workflow.indexOf("- name: Test") <
        workflow.indexOf("- name: Verify plugin distribution"),
    "CI must reject stale committed distribution files before testing",
  );
  assert.match(
    workflow,
    /- name: Verify plugin distribution\s+run: pnpm verify:plugin/,
  );
});

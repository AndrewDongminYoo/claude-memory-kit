import childProcess from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const REQUIRED_DISTRIBUTION_PATHS = [
  ".claude-plugin",
  "skills",
  "dist",
  "README.md",
];

interface CommandResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

export interface VerifyPluginOptions {
  claudeRoot?: string;
  temporaryBase?: string;
}

export interface VerifyPluginResult {
  runtimeChecks: number;
  metadataChecks: number;
}

function isWithin(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate);
  return (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) &&
      relative !== ".." &&
      !path.isAbsolute(relative))
  );
}

function configuredClaudeRoot(): string {
  const configured = process.env.CLAUDE_CONFIG_DIR?.trim();
  return path.resolve(configured || path.join(os.homedir(), ".claude"));
}

function canonicalPathIfPresent(pathname: string): string {
  return fs.existsSync(pathname) ? fs.realpathSync(pathname) : pathname;
}

function temporaryBase(options: VerifyPluginOptions): string {
  const base = path.resolve(options.temporaryBase ?? os.tmpdir());
  const claudeRoot = path.resolve(options.claudeRoot ?? configuredClaudeRoot());
  const resolvedBase = fs.realpathSync(base);
  const resolvedClaudeRoot = canonicalPathIfPresent(claudeRoot);
  if (
    isWithin(claudeRoot, base) ||
    isWithin(claudeRoot, resolvedBase) ||
    isWithin(resolvedClaudeRoot, base) ||
    isWithin(resolvedClaudeRoot, resolvedBase)
  ) {
    throw new Error(
      "temporary fixture base must not be inside the Claude configuration root",
    );
  }
  return resolvedBase;
}

function copyDistribution(pluginRoot: string, copyRoot: string): void {
  for (const relativePath of REQUIRED_DISTRIBUTION_PATHS) {
    const source = path.join(pluginRoot, relativePath);
    if (!fs.existsSync(source)) {
      throw new Error(`missing distribution path: ${relativePath}`);
    }
    fs.cpSync(source, path.join(copyRoot, relativePath), {
      recursive: true,
      errorOnExist: true,
      force: false,
    });
  }
  const license = path.join(pluginRoot, "LICENSE");
  if (fs.existsSync(license)) {
    fs.cpSync(license, path.join(copyRoot, "LICENSE"), {
      errorOnExist: true,
      force: false,
    });
  }
}

function hasNodeModules(directory: string): boolean {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (entry.name === "node_modules") {
      return true;
    }
    if (
      entry.isDirectory() &&
      hasNodeModules(path.join(directory, entry.name))
    ) {
      return true;
    }
  }
  return false;
}

function runNode(
  cwd: string,
  configRoot: string,
  script: string,
  args: string[],
  env: NodeJS.ProcessEnv = process.env,
): CommandResult {
  const result = childProcess.spawnSync(process.execPath, [script, ...args], {
    cwd,
    encoding: "utf8",
    env: { ...env, CLAUDE_CONFIG_DIR: configRoot },
  });
  if (result.error) {
    throw result.error;
  }
  return result;
}

function requireSuccess(result: CommandResult, label: string): void {
  if (result.status !== 0) {
    throw new Error(`${label} failed: ${result.stderr}`);
  }
}

function validateMetadata(copyRoot: string, configRoot: string): number {
  const result = childProcess.spawnSync(
    "claude",
    ["plugin", "validate", "--strict", "."],
    {
      cwd: copyRoot,
      encoding: "utf8",
      env: { ...process.env, CLAUDE_CONFIG_DIR: configRoot },
    },
  );
  if ((result.error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") {
    return 0;
  }
  if (result.error) {
    throw result.error;
  }
  requireSuccess(result, "Claude Code plugin validation");
  return 1;
}

/** Verifies Node.js-only runtime behavior from a temporary plugin copy. */
export function verifyPluginCopy(
  pluginRoot: string,
  options: VerifyPluginOptions = {},
): VerifyPluginResult {
  const temporaryRoot = fs.mkdtempSync(
    path.join(temporaryBase(options), "cmk-plugin-"),
  );
  const copyRoot = path.join(temporaryRoot, "plugin");
  const configRoot = path.join(temporaryRoot, "claude-config");
  const verificationEnv: NodeJS.ProcessEnv = {
    ...process.env,
    CMK_SCOPE_SLUG_PREFIXES: "verification-",
  };
  try {
    fs.mkdirSync(copyRoot, { recursive: true });
    fs.mkdirSync(path.join(configRoot, "projects", "verification-project"), {
      recursive: true,
    });
    copyDistribution(pluginRoot, copyRoot);
    if (hasNodeModules(copyRoot)) {
      throw new Error("distribution copy must not contain node_modules");
    }

    const missingScope = runNode(
      copyRoot,
      configRoot,
      "dist/scan-cold.js",
      [],
      { ...process.env, CMK_SCOPE_SLUG_PREFIXES: "" },
    );
    if (
      missingScope.status === 0 ||
      !missingScope.stderr.includes("CMK_SCOPE_SLUG_PREFIXES is required")
    ) {
      throw new Error("compiled scan-cold did not fail closed without scope");
    }

    const symlinkConfigRoot = path.join(temporaryRoot, "symlink-config");
    const outsideProjectsDir = path.join(temporaryRoot, "outside-projects");
    fs.mkdirSync(symlinkConfigRoot);
    fs.mkdirSync(outsideProjectsDir);
    fs.symlinkSync(
      outsideProjectsDir,
      path.join(symlinkConfigRoot, "projects"),
    );
    const symlinkProjectsScan = runNode(
      copyRoot,
      symlinkConfigRoot,
      "dist/scan-cold.js",
      [],
      verificationEnv,
    );
    if (
      symlinkProjectsScan.status === 0 ||
      !symlinkProjectsScan.stderr.includes(
        "projects directory is a symbolic link",
      )
    ) {
      throw new Error(
        "compiled scan-cold did not reject a symlinked projects root",
      );
    }
    const symlinkProjectsScore = runNode(
      copyRoot,
      symlinkConfigRoot,
      "dist/score-prefilter.js",
      [
        path.join(
          symlinkConfigRoot,
          "projects",
          "verification-project",
          "session.jsonl",
        ),
      ],
      verificationEnv,
    );
    if (
      symlinkProjectsScore.status === 0 ||
      !symlinkProjectsScore.stderr.includes(
        "projects directory is a symbolic link",
      )
    ) {
      throw new Error(
        "compiled score-prefilter did not reject a symlinked projects root",
      );
    }

    const invalidColdDays = runNode(
      copyRoot,
      configRoot,
      "dist/scan-cold.js",
      [],
      { ...verificationEnv, COLD_DAYS: "not-a-number" },
    );
    if (
      invalidColdDays.status === 0 ||
      !invalidColdDays.stderr.includes("invalid COLD_DAYS")
    ) {
      throw new Error("compiled scan-cold did not reject invalid COLD_DAYS");
    }

    const transcript = path.join(
      configRoot,
      "projects",
      "verification-project",
      "session.jsonl",
    );
    fs.writeFileSync(
      transcript,
      JSON.stringify({
        type: "user",
        timestamp: new Date(Date.now() - 30 * 86_400_000).toISOString(),
        message: { role: "user", content: "verification fixture" },
      }) + "\n",
    );
    const sourceBeforeScan = fs.readFileSync(transcript, "utf8");
    const coldScan = runNode(copyRoot, configRoot, "dist/scan-cold.js", [], {
      ...process.env,
      ...verificationEnv,
      COLD_DAYS: "14",
    });
    requireSuccess(coldScan, "compiled scan-cold");
    const candidates = JSON.parse(coldScan.stdout) as Array<{
      session_id?: unknown;
    }>;
    if (candidates.length !== 1 || candidates[0]?.session_id !== "session") {
      throw new Error("compiled scan-cold did not list the fixture transcript");
    }
    if (fs.readFileSync(transcript, "utf8") !== sourceBeforeScan) {
      throw new Error("compiled scan-cold changed the fixture transcript");
    }
    const outsideTranscript = path.join(temporaryRoot, "outside.jsonl");
    const symlinkedTranscript = path.join(
      configRoot,
      "projects",
      "verification-project",
      "linked.jsonl",
    );
    fs.writeFileSync(outsideTranscript, "{ invalid\n");
    fs.symlinkSync(outsideTranscript, symlinkedTranscript);
    const symlinkedScore = runNode(
      copyRoot,
      configRoot,
      "dist/score-prefilter.js",
      [symlinkedTranscript],
      verificationEnv,
    );
    if (
      symlinkedScore.status === 0 ||
      !symlinkedScore.stderr.includes("symbolic link")
    ) {
      throw new Error("compiled score-prefilter did not reject a symlink");
    }
    requireSuccess(
      runNode(
        copyRoot,
        configRoot,
        "dist/score-prefilter.js",
        [transcript],
        verificationEnv,
      ),
      "compiled score-prefilter",
    );
    const finalized = runNode(
      copyRoot,
      configRoot,
      "dist/finalize-transcript.js",
      [transcript, "verification-project", "0", "proposed-rejected"],
      verificationEnv,
    );
    requireSuccess(finalized, "compiled finalize-transcript");
    const archivePath = finalized.stdout.trim();
    if (
      !archivePath ||
      !fs.existsSync(archivePath) ||
      fs.existsSync(transcript)
    ) {
      throw new Error(
        "compiled finalize-transcript did not archive the fixture",
      );
    }
    requireSuccess(
      runNode(
        copyRoot,
        configRoot,
        "dist/recover-pending-archives.js",
        [],
        verificationEnv,
      ),
      "compiled recover-pending-archives",
    );
    return {
      runtimeChecks: 9,
      metadataChecks: validateMetadata(copyRoot, configRoot),
    };
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Resolve the Claude config directory without ever hardcoding a home path.
 * Honors $CLAUDE_CONFIG_DIR, else $HOME/.claude; verifies it is a directory.
 */
export function resolveClaudeRoot(
  env: NodeJS.ProcessEnv = process.env,
): string {
  const root =
    env.CLAUDE_CONFIG_DIR?.trim() || path.join(os.homedir(), ".claude");
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
    throw new Error(`Claude config dir not found or not a directory: ${root}`);
  }
  return root;
}

export const projectsDir = (root: string): string =>
  path.join(root, "projects");

/** Ledger + archive live under gitignored paths (not tracked in the ~/.claude repo). */
export const ledgerPath = (root: string): string =>
  path.join(root, ".claude-memory-kit", "mining-ledger.jsonl");

export const archiveDir = (root: string): string =>
  path.join(root, ".transcript-archive");

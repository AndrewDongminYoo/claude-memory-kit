import fs from "node:fs";
import path from "node:path";
import { ageBasisMs } from "./timestamps.ts";

const DAY_MS = 86_400_000;

export interface Candidate {
  session_id: string;
  slug: string;
  path: string;
  mtimeMs: number;
  size: number;
  ageDays: number;
  ageSource: "internal" | "mtime";
}

export interface ScanOptions {
  projectsDir: string;
  minedSessions: Set<string>;
  coldDays: number;
  now: number;
  /**
   * When true, derive age from the transcript's internal session timestamp
   * (falling back to mtime) instead of mtime alone. Required for copied /
   * worktree config dirs where mtime was bulk-reset; costs one file read each.
   */
  useInternalTimestamps?: boolean;
}

/**
 * List cold, un-mined transcripts under <projectsDir>/<slug>/*.jsonl.
 *
 * A transcript is a candidate when its age >= coldDays AND its session id is
 * not in minedSessions. With useInternalTimestamps the age uses the earlier of
 * the internal session time and mtime (reads the file); otherwise mtime only.
 */
export function scanCold(opts: ScanOptions): Candidate[] {
  const { projectsDir, minedSessions, coldDays, now, useInternalTimestamps } =
    opts;
  if (!fs.existsSync(projectsDir)) return [];

  const out: Candidate[] = [];
  for (const slug of fs.readdirSync(projectsDir)) {
    const dir = path.join(projectsDir, slug);
    let dstat: fs.Stats;
    try {
      dstat = fs.statSync(dir);
    } catch {
      continue;
    }
    if (!dstat.isDirectory()) continue;

    for (const entry of fs.readdirSync(dir)) {
      if (!entry.endsWith(".jsonl")) continue;
      const full = path.join(dir, entry);
      let fstat: fs.Stats;
      try {
        fstat = fs.statSync(full);
      } catch {
        continue;
      }
      if (!fstat.isFile()) continue;

      let basisMs = fstat.mtimeMs;
      let ageSource: Candidate["ageSource"] = "mtime";
      if (useInternalTimestamps) {
        let raw: string | null = null;
        try {
          raw = fs.readFileSync(full, "utf8");
        } catch {
          raw = null;
        }
        const basis = ageBasisMs(raw, fstat.mtimeMs);
        if (basis !== fstat.mtimeMs) ageSource = "internal";
        basisMs = basis;
      }

      const ageDays = (now - basisMs) / DAY_MS;
      if (ageDays < coldDays) continue; // still warm
      const session_id = entry.slice(0, -".jsonl".length);
      if (minedSessions.has(session_id)) continue; // already mined

      out.push({
        session_id,
        slug,
        path: full,
        mtimeMs: fstat.mtimeMs,
        size: fstat.size,
        ageDays,
        ageSource,
      });
    }
  }
  // Oldest first — the most-cold, least-likely-to-be-resumed sessions lead.
  return out.sort((a, b) => b.ageDays - a.ageDays);
}

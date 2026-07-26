import fs from "node:fs";
import path from "node:path";

const DAY_MS = 86_400_000;

export interface Candidate {
  session_id: string;
  slug: string;
  path: string;
  mtimeMs: number;
  size: number;
  ageDays: number;
}

export interface ScanOptions {
  projectsDir: string;
  minedSessions: Set<string>;
  coldDays: number;
  now: number;
}

/**
 * List cold, un-mined transcripts under <projectsDir>/<slug>/*.jsonl.
 *
 * A transcript is a candidate when its age >= coldDays AND its session id is
 * not in minedSessions. Deterministic given (projectsDir contents, mined, now).
 * Never reads file contents and never mutates anything.
 */
export function scanCold(opts: ScanOptions): Candidate[] {
  const { projectsDir, minedSessions, coldDays, now } = opts;
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

      const ageDays = (now - fstat.mtimeMs) / DAY_MS;
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
      });
    }
  }
  // Oldest first — the most-cold, least-likely-to-be-resumed sessions lead.
  return out.sort((a, b) => b.ageDays - a.ageDays);
}

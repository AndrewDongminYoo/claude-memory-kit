import fs from "node:fs";
import path from "node:path";

/**
 * Soft-archive a processed transcript: MOVE it under the archive, preserving
 * its slug so it can be restored to origin. Never deletes bytes (a move keeps
 * them), never overwrites (collisions get a numeric suffix).
 *
 * @returns the destination path the transcript now lives at.
 */
export function archiveTranscript(opts: {
  transcriptPath: string;
  slug: string;
  archiveDir: string;
}): string {
  const { transcriptPath, slug, archiveDir } = opts;
  const destDir = path.join(archiveDir, slug);
  fs.mkdirSync(destDir, { recursive: true });

  const base = path.basename(transcriptPath);
  const ext = path.extname(base);
  const stem = base.slice(0, base.length - ext.length);

  let dest = path.join(destDir, base);
  let n = 1;
  while (fs.existsSync(dest)) {
    dest = path.join(destDir, `${stem}.dup${n}${ext}`);
    n += 1;
  }

  try {
    fs.renameSync(transcriptPath, dest);
  } catch (err) {
    // Cross-device move (archive on a different volume): copy then unlink.
    if ((err as NodeJS.ErrnoException).code === "EXDEV") {
      fs.copyFileSync(transcriptPath, dest);
      fs.rmSync(transcriptPath);
    } else {
      throw err;
    }
  }
  return dest;
}

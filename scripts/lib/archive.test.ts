import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { archiveTranscript } from "./archive.ts";

function setup(): { root: string; src: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cmk-arch-"));
  const projectsSlug = path.join(root, "projects", "proj");
  fs.mkdirSync(projectsSlug, { recursive: true });
  const src = path.join(projectsSlug, "session.jsonl");
  fs.writeFileSync(src, "PAYLOAD\n");
  return { root, src };
}

test("moves the transcript into archive/<slug>, preserving content, removing source", () => {
  const { root, src } = setup();
  const archiveDir = path.join(root, ".transcript-archive");
  const dest = archiveTranscript({
    transcriptPath: src,
    slug: "proj",
    archiveDir,
  });

  assert.equal(fs.existsSync(src), false, "source should be gone (moved)");
  assert.equal(fs.readFileSync(dest, "utf8"), "PAYLOAD\n", "content preserved");
  assert.equal(dest, path.join(archiveDir, "proj", "session.jsonl"));
});

test("collision gets a numeric suffix, never overwrites", () => {
  const { root, src } = setup();
  const archiveDir = path.join(root, ".transcript-archive");
  fs.mkdirSync(path.join(archiveDir, "proj"), { recursive: true });
  fs.writeFileSync(
    path.join(archiveDir, "proj", "session.jsonl"),
    "EXISTING\n",
  );

  const dest = archiveTranscript({
    transcriptPath: src,
    slug: "proj",
    archiveDir,
  });
  assert.equal(dest, path.join(archiveDir, "proj", "session.dup1.jsonl"));
  assert.equal(
    fs.readFileSync(path.join(archiveDir, "proj", "session.jsonl"), "utf8"),
    "EXISTING\n",
  );
  assert.equal(fs.readFileSync(dest, "utf8"), "PAYLOAD\n");
});

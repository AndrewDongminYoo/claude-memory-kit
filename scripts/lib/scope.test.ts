import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  assertSlugInScope,
  isSlugInScope,
  parseScopeSlugPrefixes,
  readSafeTranscriptFile,
} from "./scope.ts";

test("requires at least one explicit scope prefix", () => {
  assert.throws(
    () => parseScopeSlugPrefixes(undefined),
    /CMK_SCOPE_SLUG_PREFIXES is required/,
  );
  assert.throws(
    () => parseScopeSlugPrefixes(" , "),
    /CMK_SCOPE_SLUG_PREFIXES is required/,
  );
});

test("matches a slug only when it starts with an approved prefix", () => {
  const prefixes = parseScopeSlugPrefixes("personal-, personal-tools-");

  assert.equal(isSlugInScope("personal-project", prefixes), true);
  assert.equal(isSlugInScope("personal-tools-plugin", prefixes), true);
  assert.equal(isSlugInScope("work-project", prefixes), false);
  assert.throws(
    () => assertSlugInScope("work-project", prefixes),
    /outside CMK_SCOPE_SLUG_PREFIXES/,
  );
});

test("does not read after the transcript path changes to a symlink", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cmk-scope-"));
  const projectsDir = path.join(root, "projects");
  const projectDir = path.join(projectsDir, "personal-project");
  const transcript = path.join(projectDir, "session.jsonl");
  const outside = path.join(root, "outside.jsonl");
  fs.mkdirSync(projectDir, { recursive: true });
  fs.writeFileSync(transcript, "IN-SCOPE\n");
  fs.writeFileSync(outside, "OUTSIDE\n");

  const originalOpenSync = fs.openSync;
  fs.openSync = ((pathname: fs.PathLike, flags: string | number) => {
    const descriptor = originalOpenSync(pathname, flags);
    if (pathname === transcript) {
      fs.rmSync(transcript);
      fs.symlinkSync(outside, transcript);
    }
    return descriptor;
  }) as typeof fs.openSync;
  try {
    assert.throws(
      () => readSafeTranscriptFile(transcript, "personal-project", projectsDir),
      /symbolic link/,
    );
  } finally {
    fs.openSync = originalOpenSync;
  }
});

test("rejects a symlinked projects root before opening a transcript", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cmk-scope-"));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "cmk-outside-"));
  const projectDir = path.join(outside, "personal-project");
  const transcript = path.join(projectDir, "session.jsonl");
  fs.mkdirSync(projectDir, { recursive: true });
  fs.writeFileSync(transcript, "OUTSIDE\n");
  const linkedProjectsDir = path.join(root, "projects");
  fs.symlinkSync(outside, linkedProjectsDir);

  assert.throws(
    () =>
      readSafeTranscriptFile(
        path.join(linkedProjectsDir, "personal-project", "session.jsonl"),
        "personal-project",
        linkedProjectsDir,
      ),
    /projects directory is a symbolic link/,
  );
});

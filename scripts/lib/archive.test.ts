import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fingerprintContents } from "./fingerprint.ts";
import { archiveTranscript as archiveTranscriptUnchecked } from "./archive.ts";

type ArchiveFixtureOptions = Omit<
  Parameters<typeof archiveTranscriptUnchecked>[0],
  "expectedFingerprint"
> & {
  expectedFingerprint?: string;
};

function archiveTranscript(options: ArchiveFixtureOptions): string {
  const expectedFingerprint =
    options.expectedFingerprint ??
    fingerprintContents(fs.readFileSync(options.transcriptPath));
  return archiveTranscriptUnchecked({ ...options, expectedFingerprint });
}

function setup(): { root: string; src: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cmk-arch-"));
  const projectsSlug = path.join(root, "projects", "proj");
  fs.mkdirSync(projectsSlug, { recursive: true });
  const src = path.join(projectsSlug, "session.jsonl");
  fs.writeFileSync(src, "PAYLOAD\n");
  return { root, src };
}

function withWindowsDirectoryFsyncUnavailable(action: () => void): void {
  const platformDescriptor = Object.getOwnPropertyDescriptor(
    process,
    "platform",
  );
  assert.ok(platformDescriptor);
  const originalOpen = fs.openSync;
  Object.defineProperty(process, "platform", {
    ...platformDescriptor,
    value: "win32",
  });
  fs.openSync = ((pathname, flags, mode) => {
    if (typeof flags === "number" && (flags & fs.constants.O_DIRECTORY) !== 0) {
      const error = new Error("directory fsync is unavailable on Windows");
      (error as NodeJS.ErrnoException).code = "EPERM";
      throw error;
    }
    return originalOpen(pathname, flags, mode);
  }) as typeof fs.openSync;

  try {
    action();
  } finally {
    fs.openSync = originalOpen;
    Object.defineProperty(process, "platform", platformDescriptor);
  }
}

test("requires a reviewed fingerprint before removing a source", () => {
  const { root, src } = setup();
  const unsafeOptions = {
    transcriptPath: src,
    slug: "proj",
    projectsDir: path.join(root, "projects"),
    archiveDir: path.join(root, ".transcript-archive"),
  };

  assert.throws(
    () =>
      archiveTranscriptUnchecked(
        unsafeOptions as Parameters<typeof archiveTranscriptUnchecked>[0],
      ),
    /reviewed fingerprint/,
  );
  assert.equal(fs.existsSync(src), true);
});

test("moves the transcript into archive/<slug>, preserving content, removing source", () => {
  const { root, src } = setup();
  const archiveDir = path.join(root, ".transcript-archive");
  const dest = archiveTranscript({
    transcriptPath: src,
    slug: "proj",
    projectsDir: path.join(root, "projects"),
    archiveDir,
  });

  assert.equal(fs.existsSync(src), false, "source should be gone (moved)");
  assert.equal(fs.readFileSync(dest, "utf8"), "PAYLOAD\n", "content preserved");
  assert.equal(dest, path.join(archiveDir, "proj", "session.jsonl"));
});

test("archives on Windows when directory fsync is unavailable", () => {
  const { root, src } = setup();
  const archiveDir = path.join(root, ".transcript-archive");
  let dest = "";

  withWindowsDirectoryFsyncUnavailable(() => {
    dest = archiveTranscript({
      transcriptPath: src,
      slug: "proj",
      projectsDir: path.join(root, "projects"),
      archiveDir,
    });
  });

  assert.equal(fs.existsSync(src), false, "source should be archived");
  assert.equal(fs.readFileSync(dest, "utf8"), "PAYLOAD\n");
});

test("uses a writable archive descriptor for Windows file sync", () => {
  const { root, src } = setup();
  const archiveDir = path.join(root, ".transcript-archive");
  const originalOpenSync = fs.openSync;
  const originalFsyncSync = fs.fsyncSync;
  const flagsByDescriptor = new Map<number, string | number>();
  const pathsByDescriptor = new Map<number, string>();

  fs.openSync = ((pathname, flags, mode) => {
    const descriptor = originalOpenSync(pathname, flags, mode);
    flagsByDescriptor.set(descriptor, flags);
    pathsByDescriptor.set(descriptor, path.resolve(pathname.toString()));
    return descriptor;
  }) as typeof fs.openSync;
  fs.fsyncSync = ((descriptor: number) => {
    const flags = flagsByDescriptor.get(descriptor);
    if (
      typeof flags === "number" &&
      pathsByDescriptor.get(descriptor) ===
        path.join(archiveDir, "proj", "session.jsonl") &&
      (flags & fs.constants.O_WRONLY) === 0 &&
      (flags & fs.constants.O_RDWR) === 0
    ) {
      throw new Error("Windows file sync requires a writable descriptor");
    }
    return originalFsyncSync(descriptor);
  }) as typeof fs.fsyncSync;

  try {
    const destination = archiveTranscript({
      transcriptPath: src,
      slug: "proj",
      projectsDir: path.join(root, "projects"),
      archiveDir,
    });

    assert.equal(fs.existsSync(src), false, "source should be archived");
    assert.equal(fs.readFileSync(destination, "utf8"), "PAYLOAD\n");
  } finally {
    fs.openSync = originalOpenSync;
    fs.fsyncSync = originalFsyncSync;
  }
});

test("tolerates an archive slug directory created concurrently", () => {
  const { root, src } = setup();
  const archiveDir = path.join(root, ".transcript-archive");
  const archiveSlugDir = path.join(archiveDir, "proj");
  const originalMkdirSync = fs.mkdirSync;
  let createdConcurrently = false;

  fs.mkdirSync = ((pathname, options) => {
    if (pathname === archiveSlugDir && !createdConcurrently) {
      createdConcurrently = true;
      originalMkdirSync(archiveSlugDir, { recursive: true, mode: 0o700 });
    }
    return originalMkdirSync(pathname, options);
  }) as typeof fs.mkdirSync;

  try {
    const destination = archiveTranscript({
      transcriptPath: src,
      slug: "proj",
      projectsDir: path.join(root, "projects"),
      archiveDir,
    });

    assert.equal(fs.readFileSync(destination, "utf8"), "PAYLOAD\n");
  } finally {
    fs.mkdirSync = originalMkdirSync;
  }
});

test(
  "syncs newly created archive directory entries before source removal",
  { skip: process.platform === "win32" },
  () => {
    const { root, src } = setup();
    const archiveDir = path.join(root, ".transcript-archive");
    const archiveSlugDir = path.join(archiveDir, "proj");
    const expectedParents = new Set([path.dirname(archiveDir), archiveDir]);
    const directoryDescriptors = new Map<number, string>();
    const syncedDirectories = new Set<string>();
    const originalOpenSync = fs.openSync;
    const originalFsyncSync = fs.fsyncSync;
    const originalMkdirSync = fs.mkdirSync;
    const originalUnlinkSync = fs.unlinkSync;
    let slugCreatedConcurrently = false;

    fs.openSync = ((pathname, flags, mode) => {
      const descriptor = originalOpenSync(pathname, flags, mode);
      if (
        typeof flags === "number" &&
        (flags & fs.constants.O_DIRECTORY) !== 0
      ) {
        directoryDescriptors.set(descriptor, path.resolve(pathname.toString()));
      }
      return descriptor;
    }) as typeof fs.openSync;
    fs.fsyncSync = ((descriptor: number) => {
      const directory = directoryDescriptors.get(descriptor);
      if (directory) syncedDirectories.add(directory);
      return originalFsyncSync(descriptor);
    }) as typeof fs.fsyncSync;
    fs.mkdirSync = ((pathname, options) => {
      if (pathname === archiveSlugDir && !slugCreatedConcurrently) {
        slugCreatedConcurrently = true;
        originalMkdirSync(pathname, { recursive: true, mode: 0o700 });
      }
      return originalMkdirSync(pathname, options);
    }) as typeof fs.mkdirSync;
    fs.unlinkSync = ((pathname) => {
      if (pathname === src) {
        for (const parent of expectedParents) {
          assert.equal(
            syncedDirectories.has(parent),
            true,
            `${parent} must be synced before removing the source`,
          );
        }
      }
      return originalUnlinkSync(pathname);
    }) as typeof fs.unlinkSync;

    try {
      archiveTranscript({
        transcriptPath: src,
        slug: "proj",
        projectsDir: path.join(root, "projects"),
        archiveDir,
      });
    } finally {
      fs.openSync = originalOpenSync;
      fs.fsyncSync = originalFsyncSync;
      fs.mkdirSync = originalMkdirSync;
      fs.unlinkSync = originalUnlinkSync;
    }
  },
);

test(
  "syncs the source directory after source removal",
  { skip: process.platform === "win32" },
  () => {
    const { root, src } = setup();
    const projectSlugDir = path.dirname(src);
    const archiveDir = path.join(root, ".transcript-archive");
    const directoryDescriptors = new Map<number, string>();
    const originalOpenSync = fs.openSync;
    const originalFsyncSync = fs.fsyncSync;
    const originalUnlinkSync = fs.unlinkSync;
    let sourceUnlinked = false;
    let sourceDirectorySynced = false;

    fs.openSync = ((pathname, flags, mode) => {
      const descriptor = originalOpenSync(pathname, flags, mode);
      if (
        typeof flags === "number" &&
        (flags & fs.constants.O_DIRECTORY) !== 0
      ) {
        directoryDescriptors.set(descriptor, path.resolve(pathname.toString()));
      }
      return descriptor;
    }) as typeof fs.openSync;
    fs.fsyncSync = ((descriptor: number) => {
      if (directoryDescriptors.get(descriptor) === projectSlugDir) {
        assert.equal(sourceUnlinked, true);
        sourceDirectorySynced = true;
      }
      return originalFsyncSync(descriptor);
    }) as typeof fs.fsyncSync;
    fs.unlinkSync = ((pathname) => {
      const result = originalUnlinkSync(pathname);
      if (pathname === src) sourceUnlinked = true;
      return result;
    }) as typeof fs.unlinkSync;

    try {
      archiveTranscript({
        transcriptPath: src,
        slug: "proj",
        projectsDir: path.join(root, "projects"),
        archiveDir,
      });

      assert.equal(sourceDirectorySynced, true);
    } finally {
      fs.openSync = originalOpenSync;
      fs.fsyncSync = originalFsyncSync;
      fs.unlinkSync = originalUnlinkSync;
    }
  },
);

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
    projectsDir: path.join(root, "projects"),
    archiveDir,
  });
  assert.equal(dest, path.join(archiveDir, "proj", "session.dup1.jsonl"));
  assert.equal(
    fs.readFileSync(path.join(archiveDir, "proj", "session.jsonl"), "utf8"),
    "EXISTING\n",
  );
  assert.equal(fs.readFileSync(dest, "utf8"), "PAYLOAD\n");
});

test("reserves only the collision-safe destination in the ledger callback", () => {
  const { root, src } = setup();
  const archiveDir = path.join(root, ".transcript-archive");
  const existing = path.join(archiveDir, "proj", "session.jsonl");
  fs.mkdirSync(path.dirname(existing), { recursive: true });
  fs.writeFileSync(existing, "EXISTING\n");
  const reserved: string[] = [];

  archiveTranscript({
    transcriptPath: src,
    slug: "proj",
    projectsDir: path.join(root, "projects"),
    archiveDir,
    onDestinationReserved: (destination) => reserved.push(destination),
  });

  assert.deepEqual(reserved, [
    path.join(archiveDir, "proj", "session.dup1.jsonl"),
  ]);
  assert.equal(fs.readFileSync(existing, "utf8"), "EXISTING\n");
});

test("reserves an empty archive destination before publishing its payload", () => {
  const { root, src } = setup();
  let reserved = false;
  let ready = false;

  archiveTranscript({
    transcriptPath: src,
    slug: "proj",
    projectsDir: path.join(root, "projects"),
    archiveDir: path.join(root, ".transcript-archive"),
    onDestinationReserved: (destination) => {
      reserved = true;
      assert.equal(fs.readFileSync(destination, "utf8"), "");
      assert.equal(fs.existsSync(src), true);
    },
    onDestinationReady: (destination) => {
      ready = true;
      assert.equal(fs.readFileSync(destination, "utf8"), "PAYLOAD\n");
      assert.equal(fs.existsSync(src), true);
    },
  });

  assert.equal(reserved, true);
  assert.equal(ready, true);
  assert.equal(fs.existsSync(src), false);
});

test("keeps the source when final archive sync fails", () => {
  const { root, src } = setup();
  const originalFsync = fs.fsyncSync;
  let calls = 0;
  fs.fsyncSync = ((descriptor: number) => {
    calls += 1;
    if (calls === 2) {
      throw new Error("final archive sync failed");
    }
    originalFsync(descriptor);
  }) as typeof fs.fsyncSync;

  try {
    assert.throws(
      () =>
        archiveTranscript({
          transcriptPath: src,
          slug: "proj",
          projectsDir: path.join(root, "projects"),
          archiveDir: path.join(root, ".transcript-archive"),
        }),
      /final archive sync failed/,
    );
  } finally {
    fs.fsyncSync = originalFsync;
  }

  assert.equal(fs.existsSync(src), true, "source must remain in place");
});

test("removes a published destination when post-publish sync fails", () => {
  const { root, src } = setup();
  const archiveDir = path.join(root, ".transcript-archive");
  const destination = path.join(archiveDir, "proj", "session.jsonl");
  const originalOpenSync = fs.openSync;
  const originalFsyncSync = fs.fsyncSync;
  const descriptors = new Map<
    number,
    { pathname: string; flags: string | number }
  >();
  fs.openSync = ((pathname, flags, mode) => {
    const descriptor = originalOpenSync(pathname, flags, mode);
    descriptors.set(descriptor, {
      pathname: path.resolve(pathname.toString()),
      flags,
    });
    return descriptor;
  }) as typeof fs.openSync;
  fs.fsyncSync = ((descriptor: number) => {
    const opened = descriptors.get(descriptor);
    if (
      opened?.pathname === destination &&
      typeof opened.flags === "number" &&
      (opened.flags & fs.constants.O_WRONLY) !== 0
    ) {
      throw new Error("post-publish sync failed");
    }
    return originalFsyncSync(descriptor);
  }) as typeof fs.fsyncSync;

  try {
    assert.throws(
      () =>
        archiveTranscript({
          transcriptPath: src,
          slug: "proj",
          projectsDir: path.join(root, "projects"),
          archiveDir,
        }),
      /post-publish sync failed/,
    );
  } finally {
    fs.openSync = originalOpenSync;
    fs.fsyncSync = originalFsyncSync;
  }

  assert.equal(fs.existsSync(src), true);
  assert.equal(fs.existsSync(destination), false);
});

test("keeps the source when its reviewed fingerprint does not match", () => {
  const { root, src } = setup();

  assert.throws(
    () =>
      archiveTranscript({
        transcriptPath: src,
        slug: "proj",
        projectsDir: path.join(root, "projects"),
        archiveDir: path.join(root, ".transcript-archive"),
        expectedFingerprint: "0".repeat(64),
      }),
    /fingerprint/,
  );
  assert.equal(fs.existsSync(src), true);
});

test("does not remove a source path replaced during archiving", () => {
  const { root, src } = setup();
  const replacement = `${src}.original`;
  const outside = path.join(root, "outside.jsonl");
  fs.writeFileSync(outside, "OUTSIDE\n");

  assert.throws(
    () =>
      archiveTranscript({
        transcriptPath: src,
        slug: "proj",
        projectsDir: path.join(root, "projects"),
        archiveDir: path.join(root, ".transcript-archive"),
        onDestinationReserved: () => {
          fs.renameSync(src, replacement);
          fs.symlinkSync(outside, src);
        },
      }),
    /symbolic link|source changed during archiving/,
  );
  assert.equal(fs.readFileSync(outside, "utf8"), "OUTSIDE\n");
  assert.equal(fs.readFileSync(replacement, "utf8"), "PAYLOAD\n");
  assert.equal(fs.lstatSync(src).isSymbolicLink(), true);
});

test("rejects a slug that is not one path segment", () => {
  const { root, src } = setup();

  assert.throws(
    () =>
      archiveTranscript({
        transcriptPath: src,
        slug: "../outside",
        projectsDir: path.join(root, "projects"),
        archiveDir: path.join(root, ".transcript-archive"),
      }),
    /slug must be a single path segment/,
  );
  assert.equal(fs.existsSync(src), true, "invalid slug must keep the source");
});

test("rejects a source outside the configured projects directory", () => {
  const { root } = setup();
  const outsideFile = path.join(root, "outside.jsonl");
  fs.writeFileSync(outsideFile, "OUTSIDE\n");

  assert.throws(
    () =>
      archiveTranscript({
        transcriptPath: outsideFile,
        slug: "proj",
        projectsDir: path.join(root, "projects"),
        archiveDir: path.join(root, ".transcript-archive"),
      }),
    /direct child of the configured project slug directory/,
  );
  assert.equal(
    fs.existsSync(outsideFile),
    true,
    "outside source must remain in place",
  );
});

test("rejects a symlinked transcript source", () => {
  const { root } = setup();
  const projectDir = path.join(root, "projects", "proj");
  const target = path.join(projectDir, "target.jsonl");
  const sourceLink = path.join(projectDir, "linked.jsonl");
  fs.writeFileSync(target, "TARGET\n");
  fs.symlinkSync(target, sourceLink);

  assert.throws(
    () =>
      archiveTranscript({
        transcriptPath: sourceLink,
        slug: "proj",
        projectsDir: path.join(root, "projects"),
        archiveDir: path.join(root, ".transcript-archive"),
      }),
    /symbolic link/,
  );
  assert.equal(fs.existsSync(sourceLink), true, "symlink must remain in place");
});

test("rejects a symlinked archive slug directory", () => {
  const { root, src } = setup();
  const archiveRoot = path.join(root, ".transcript-archive");
  const outsideDir = path.join(root, "outside");
  fs.mkdirSync(archiveRoot, { recursive: true });
  fs.mkdirSync(outsideDir, { recursive: true });
  fs.symlinkSync(outsideDir, path.join(archiveRoot, "proj"));

  assert.throws(
    () =>
      archiveTranscript({
        transcriptPath: src,
        slug: "proj",
        projectsDir: path.join(root, "projects"),
        archiveDir: archiveRoot,
      }),
    /symbolic link/,
  );
  assert.equal(fs.existsSync(src), true, "source must remain in place");
});

test("rejects a group-writable archive directory", () => {
  const { root, src } = setup();
  const archiveRoot = path.join(root, ".transcript-archive");
  fs.mkdirSync(archiveRoot);
  fs.chmodSync(archiveRoot, 0o777);

  assert.throws(
    () =>
      archiveTranscript({
        transcriptPath: src,
        slug: "proj",
        projectsDir: path.join(root, "projects"),
        archiveDir: archiveRoot,
      }),
    /must not be writable by group or others/,
  );
  assert.equal(fs.existsSync(src), true, "source must remain in place");
});

test("rejects an archive directory below a group-writable parent", () => {
  const { root, src } = setup();
  const parent = path.join(root, "shared");
  fs.mkdirSync(parent);
  fs.chmodSync(parent, 0o777);

  assert.throws(
    () =>
      archiveTranscript({
        transcriptPath: src,
        slug: "proj",
        projectsDir: path.join(root, "projects"),
        archiveDir: path.join(parent, ".transcript-archive"),
      }),
    /archive directory parent must not be writable by group or others/,
  );
  assert.equal(fs.existsSync(src), true, "source must remain in place");
});

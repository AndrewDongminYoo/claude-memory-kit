# Minimum Safe Release Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:executing-plans` to implement this plan task-by-task.

**Goal:** Ship one safe, manual transcript-mining skill that runs from a marketplace cache without a global `tsx` dependency.

**Architecture:** Compile the deterministic TypeScript helpers into tracked `dist/` JavaScript and run them with an explicit Node.js runtime requirement. Require an explicit project-slug scope before any transcript operation. Keep candidate discovery read-only. Add a stateful finalization boundary that records a pending archive, moves only a validated main-session transcript without clobbering an existing archive, and records completion. A recovery command completes an interrupted finalization without re-mining a transcript.

**Tech Stack:** Node.js 22.23.2+, TypeScript 5.9, `node:test`, pnpm, Claude Code plugin metadata.

**Spec:** `docs/specs/2026-08-27-minimum-safe-release-design.md`

## Global Constraints

- Implement only `mine-stale-transcripts`.
- Keep `scan-cold` and `score-prefilter` read-only.
- Do not add a hook, MCP server, database, background worker, or cross-project recall.
- Do not hard-delete a transcript or archive.
- Do not require a global `tsx` executable or plugin-local `node_modules` at runtime.
- Use test-driven development for every production behavior change.
- Use only temporary `CLAUDE_CONFIG_DIR` fixtures for automated tests and smoke checks.
- Do not read, write, move, or archive an operator's real `~/.claude` files during this implementation.
- Require non-empty `CMK_SCOPE_SLUG_PREFIXES` for every transcript CLI and filter scanner slugs before transcript reads.
- Do not commit or publish unless the operator requests it.

---

### Task 1: Make the plugin metadata and runtime contract distributable

**Files:**

- Modify: `.claude-plugin/plugin.json`
- Modify: `.claude-plugin/marketplace.json`
- Modify: `package.json`
- Modify: `tsconfig.json`
- Create: `tsconfig.build.json`
- Modify: `.gitignore`
- Test: `scripts/lib/plugin-metadata.test.ts`

**Interfaces:**

- Produces: `pnpm build` writes distributable JavaScript under `dist/`.
- Produces: `pnpm verify:plugin` runs the build-output smoke test.

- [x] **Step 1: Write failing metadata and build-output tests.**

```typescript
test("plugin metadata declares only mine-stale-transcripts", () => {
  assert.deepEqual(readPluginSkillNames(), ["mine-stale-transcripts"]);
});

test("built entry points parse with node", () => {
  assert.equal(runNode(["--check", "dist/scan-cold.js"]).status, 0);
});
```

- [x] **Step 2: Run the new test file.**

Run: `node --import tsx --test scripts/lib/plugin-metadata.test.ts`

Expected: FAIL because `dist/` and the metadata helper do not exist.

- [x] **Step 3: Add the production build configuration.**

```json
{
  "extends": "./tsconfig.json",
  "compilerOptions": {
    "allowImportingTsExtensions": false,
    "noEmit": false,
    "outDir": "dist",
    "rootDir": "scripts",
    "rewriteRelativeImportExtensions": true
  }
}
```

Add `build`, `verify:plugin`, `packageManager`, and the Node.js engine requirement to `package.json`.
Track generated `dist/` output because marketplace installation copies tracked plugin files.
Replace the manifest author string with the current Claude Code author object shape.
Remove deferred-skill claims and add the marketplace description.

- [x] **Step 4: Run the metadata and build-output tests.**

Run: `pnpm build && node --import tsx --test scripts/lib/plugin-metadata.test.ts`

Expected: PASS.

- [x] **Step 5: Run the build-output smoke test.**

Run: `pnpm build && pnpm verify:plugin`

Expected: PASS.

### Task 2: Make archive paths contained and collision-safe

**Files:**

- Modify: `scripts/lib/archive.ts`
- Modify: `scripts/lib/archive.test.ts`
- Modify: `scripts/archive-transcript.ts`

**Interfaces:**

- Consumes: `projectsDir(root)` and `archiveDir(root)`.
- Produces: `archiveTranscript({ projectsDir, archiveDir, transcriptPath, slug })`.
- Produces: a destination that is a direct child of `archiveDir/<slug>/`.

- [x] **Step 1: Write failing archive tests.**

```typescript
test("rejects a slug that escapes archiveDir", () => {
  assert.throws(() => archiveTranscript({ slug: "../outside", ...fixture }));
});

test("rejects a source outside projectsDir", () => {
  assert.throws(() =>
    archiveTranscript({ transcriptPath: outsideFile, ...fixture }),
  );
});

test("preserves an existing destination when a concurrent collision occurs", () => {
  assert.equal(readExistingDestination(), "ORIGINAL\\n");
});
```

- [x] **Step 2: Run the archive tests.**

Run: `node --import tsx --test scripts/lib/archive.test.ts`

Expected: FAIL for path traversal and source containment.

- [x] **Step 3: Implement validated no-clobber archiving.**

Resolve and compare every source and destination path against its configured root.
Use `lstat` to reject symlinked slug directories and transcript sources.
Copy the source to an exclusive temporary file in the archive directory.
Publish the final destination through exclusive creation and retry a numeric suffix on collision.
Remove the source only after the complete destination exists.

- [x] **Step 4: Run the archive tests.**

Run: `node --import tsx --test scripts/lib/archive.test.ts`

Expected: PASS.

### Task 3: Add recoverable finalization records

**Files:**

- Modify: `scripts/lib/ledger.ts`
- Modify: `scripts/lib/ledger.test.ts`
- Create: `scripts/lib/finalize.ts`
- Create: `scripts/lib/finalize.test.ts`
- Create: `scripts/finalize-transcript.ts`
- Create: `scripts/recover-pending-archives.ts`

**Interfaces:**

- Produces: `appendPendingArchive(record)` and `appendCompletedArchive(record)` ledger events.
- Produces: `pendingArchives(file)` with each latest unfinished record.
- Produces: `finalizeTranscript(options)` and `recoverPendingArchives(options)`.

```typescript
type ArchiveState = "pending" | "archived";

interface FinalizeOptions {
  transcriptPath: string;
  slug: string;
  score: number;
  outcome:
    "memory-written" | "proposed-rejected" | "skipped-low-score" | "unreadable";
  memoryWritten: string[];
  projectsDir: string;
  archiveDir: string;
  ledgerFile: string;
}
```

- [x] **Step 1: Write failing state-transition tests.**

```typescript
test("records pending before archiving and completion after archiving", () => {
  const records = readLedger(ledgerFile);
  assert.deepEqual(
    records.map((record) => record.archive_state),
    ["pending", "pending", "archived"],
  );
});

test("recovery completes a pending archive without creating another memory record", () => {
  assert.equal(recoverPendingArchives(options).completed, 1);
});

test("a second recovery run leaves a completed archive unchanged", () => {
  assert.equal(recoverPendingArchives(options).completed, 0);
});
```

- [x] **Step 2: Run the ledger and finalization tests.**

Run: `node --import tsx --test scripts/lib/ledger.test.ts scripts/lib/finalize.test.ts`

Expected: FAIL because archive state and recovery do not exist.

- [x] **Step 3: Implement the append-only finalization protocol.**

Add `pending` and `archived` archive states without modifying old ledger entries.
Write a pending event before the archive operation.
Write a destination-bound pending event from `onDestinationReady` before `archiveTranscript` removes the source.
Write an archived event only after that pending event exists.
Make recovery archive a still-present validated source or append completion when the recorded destination already exists.
Report unresolved pending records without modifying them.

- [x] **Step 4: Run the ledger and finalization tests.**

Run: `node --import tsx --test scripts/lib/ledger.test.ts scripts/lib/finalize.test.ts`

Expected: PASS.

### Task 4: Keep malformed transcripts and selection limits safe

**Files:**

- Modify: `scripts/lib/score.ts`
- Modify: `scripts/lib/score.test.ts`
- Modify: `scripts/score-prefilter.ts`
- Modify: `scripts/scan-cold.ts`
- Modify: `scripts/lib/scan.ts`
- Modify: `scripts/lib/scan.test.ts`

**Interfaces:**

- Produces: a distinct unreadable result for JSONL with no valid entries.
- Produces: `selectForDeepRead` with an explicit slug rather than separator-dependent parsing.

- [x] **Step 1: Write failing parsing and selection tests.**

```typescript
test("detects a transcript with no valid JSONL entries as unreadable", () => {
  assert.equal(isUnreadableTranscript("{ invalid\\n"), true);
});

test("caps Windows-style rows per distinct slug", () => {
  assert.deepEqual(
    selectForDeepRead(rows, 1).map((row) => row.slug),
    ["alpha", "beta"],
  );
});

test("rejects a fractional or negative MAX_PER_PROJECT", () => {
  assert.throws(() => parseMaxPerProject("1.5"));
});
```

- [x] **Step 2: Run the score and scan tests.**

Run: `node --import tsx --test scripts/lib/score.test.ts scripts/lib/scan.test.ts`

Expected: FAIL because unreadable results, explicit slugs, and integer cap validation do not exist.

- [x] **Step 3: Implement unreadable and platform-independent selection behavior.**

Add `isUnreadableTranscript(raw)` and return an unreadable CLI row only when parsing found no valid JSONL records.
Keep empty but valid transcripts as low-score data.
Require the `Selectable` interface to carry a `slug` field and use that field for per-project caps.
Deduplicate input paths before selection.
Export `parseMaxPerProject(value)` that accepts only non-negative integer caps, where zero disables the cap.

- [x] **Step 4: Run the score and scan tests.**

Run: `node --import tsx --test scripts/lib/score.test.ts scripts/lib/scan.test.ts`

Expected: PASS.

### Task 5: Verify an installed-plugin shape without development dependencies

**Files:**

- Create: `scripts/verify-plugin.ts`
- Create: `scripts/lib/verify-plugin.ts`
- Create: `scripts/lib/verify-plugin.test.ts`
- Modify: `package.json`

**Interfaces:**

- Produces: `pnpm verify:plugin`.
- Produces: a temporary distribution copy that excludes `node_modules`.

- [x] **Step 1: Write a failing plugin-copy smoke test.**

```typescript
test("runs compiled scan and score commands from a copy without node_modules", () => {
  const result = verifyPluginCopy(pluginRoot);
  assert.equal(result.runtimeChecks, 9);
});
```

- [x] **Step 2: Run the verification-tool test.**

Run: `node --import tsx --test scripts/lib/verify-plugin.test.ts`

Expected: FAIL because the verification tool does not exist.

- [x] **Step 3: Implement the temporary-copy verification tool.**

Copy only `.claude-plugin/`, `skills/`, `dist/`, `README.md`, and `LICENSE` when it exists to a temporary directory.
Confirm that the copy contains no `node_modules` directory.
Set `CLAUDE_CONFIG_DIR` to a new temporary fixture root for every spawned command.
Run compiled `scan-cold` with an intentionally invalid `COLD_DAYS` value and assert the documented rejection before it reads the fixture.
Run compiled `score-prefilter` against a temporary valid transcript fixture.

- [x] **Step 4: Run the verification-tool test and command.**

Run: `node --import tsx --test scripts/lib/verify-plugin.test.ts && pnpm verify:plugin`

Expected: PASS.

### Task 6: Align the skill and documentation with the release contract

**Files:**

- Modify: `skills/mine-stale-transcripts/SKILL.md`
- Modify: `README.md`
- Modify: `CLAUDE.md`
- Modify: `docs/specs/2026-07-26-stale-transcript-memory-mining-design.md`
- Modify: `docs/plans/2026-07-26-stale-transcript-memory-mining-plan.md`
- Modify: `docs/specs/2026-08-27-minimum-safe-release-design.md`

**Interfaces:**

- Produces: user instructions that run `node "${CLAUDE_PLUGIN_ROOT}/dist/..."`.
- Produces: one consistent documented default for `COLD_DAYS`.

- [x] **Step 1: Add failing documentation-contract assertions.**

```typescript
test("published descriptions name only the implemented skill", () => {
  assert.doesNotMatch(readText("README.md"), /merge split-path memory/);
});
```

- [x] **Step 2: Run the documentation-contract test.**

Run: `node --import tsx --test scripts/lib/plugin-metadata.test.ts`

Expected: FAIL because the current product description names deferred skills.

- [x] **Step 3: Update the documentation.**

Describe the manual approval boundary and the Node.js requirement.
Use the finalization and recovery commands in the post-approval path.
Replace stale `COLD_DAYS=30` references with the current 14-day default where they describe current behavior.
Preserve historical calibration records by labeling them historical instead of rewriting them as current behavior.

- [x] **Step 4: Run documentation and formatting checks.**

Run: `pnpm run format:check && node --import tsx --test scripts/lib/plugin-metadata.test.ts`

Expected: PASS.

### Task 7: Run the release gate and perform an operator-approved dry-run

**Files:**

- Modify: `.github/workflows/ci.yml`
- Test: all `scripts/**/*.test.ts`

- [x] **Step 1: Run the full local release gate.**

Run: `pnpm build && pnpm run typecheck && pnpm run format:check && pnpm test && pnpm verify:plugin && claude plugin validate --strict .`

Expected: PASS.

- [x] **Step 2: Add the equivalent build and plugin verification commands to CI.**

Run: `pnpm build && pnpm verify:plugin`

Expected: PASS before adding the workflow steps.

- [x] **Step 3: Run a temporary fixture dry-run.**

Run: `CMK_SCOPE_SLUG_PREFIXES=<approved-slug-prefix> CLAUDE_CONFIG_DIR=<temporary-fixture-root> node dist/scan-cold.js`

Expected: The command lists only old, un-mined, main-session transcripts and changes no fixture files.

- [x] **Step 4: Stop before a real home-directory dry-run.**

Ask the operator for separate approval before reading or changing the real `~/.claude` corpus.

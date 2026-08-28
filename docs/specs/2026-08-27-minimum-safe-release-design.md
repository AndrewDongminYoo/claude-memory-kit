# Minimum safe release design

Date: 2026-08-27

Status: implementation in progress

## Product direction

`claude-memory-kit` is a manual workflow for reviewing cold Claude Code transcripts before retention removes them.
The workflow proposes source-verified native Markdown memory entries.
The operator approves each proposed entry before any memory file changes.
The workflow then records and soft-archives only the approved or explicitly rejected transcripts.

The plugin does not replace Claude Code native memory.
The plugin does not use lifecycle hooks, a database, automatic memory writes, or cross-project recall in this release.

## Release scope

This release contains one implemented skill: `mine-stale-transcripts`.
The plugin metadata and marketplace metadata must not advertise deferred skills.
The plugin requires Node.js 22.23.2 or later.
The distributed plugin must run its committed JavaScript output with `node`.
The distributed plugin must not require a global `tsx` executable or an installed `node_modules` directory.

The repository must document the required runtime and the manual approval boundary.
The repository must state that `COLD_DAYS` defaults to 14.

## Scope contract

Every transcript CLI requires a non-empty `CMK_SCOPE_SLUG_PREFIXES` value.
The value is a comma-separated allowlist of approved project-slug prefixes.
An absent or empty value must fail closed before any transcript is read, written, moved, or recorded.
The scanner must apply the allowlist before it opens a transcript file.
The prefilter and finalizers must reject an input slug outside the allowlist.
Recovery must leave pending records outside the allowlist unchanged and report their skip count.

## Safe finalization

`scan-cold` remains read-only.
`score-prefilter` remains read-only.
Only `finalize-transcript` can remove an archivable source.

An approved transcript moves through this state sequence:

```plaintext
pending archive record -> destination-bound pending record -> archive payload published -> synchronized archive -> completed archive record
pending archive record -> source version change -> aborted archive record -> score and approval
published archive with failed rollback -> destination-bound pending record -> recovery
```

The initial record prevents a later scan from proposing the same transcript again.
The destination-bound pending record reserves an archive path before the archive payload is published.
A recovery command completes a pending archive without repeating memory extraction or memory writes.
An aborted record closes only the matching pending attempt and allows a changed source to be scored and approved again.
If rollback cannot remove a published destination, recovery leaves its pending attempt in place until it can verify and synchronize that destination.
A reserved event has `archive_ready: false` until the archive payload and its directory are synchronized.
If a legacy pending event has no attempt id, recovery leaves it pending when a source version changes.

The archive operation must enforce all of these requirements:

- Accept only a direct main-session transcript under `<CLAUDE_CONFIG_DIR>/projects/<slug>/`.
- Reject a slug that is not one path segment.
- Reject source and destination paths that resolve outside their configured roots.
- Reject symbolic links for the transcript source and slug directory.
- Preserve existing archive files without overwriting them.
- Allocate a collision suffix through an exclusive destination creation step.
- Keep the source until the archive payload is complete.
- Leave malformed transcripts in place with the `unreadable` outcome.

## Ledger contract

The ledger stores immutable JSONL events.
Each event includes the session id, slug, outcome, score, memory paths, archive state, and archive path when it exists.

`minedSessions` treats pending and completed records as excluded from new memory proposals.
An aborted record releases only the matching attempt.
`pendingArchives` returns the latest pending record for each attempt.
The recovery command resolves a pending record only when its source remains in the validated project path or its archive destination already exists.
It synchronizes a recorded archive before it removes a duplicate source.
It must otherwise report an error and leave the record unchanged.

## Malformed transcript contract

A transcript is unreadable when it contains no valid JSONL entries.
An unreadable transcript is reported separately from a low-score transcript.
It is not selected for deep reading.
It is not archived by the finalization workflow.

## Verification contract

`pnpm verify:plugin` validates the distributable plugin without using a development `node_modules` directory.
The command copies the declared distribution files to a temporary plugin directory.
It runs the compiled scan and score commands with `node`.
It validates the plugin and marketplace metadata with the installed Claude Code CLI when that CLI is available.

All automated verification uses a temporary `CLAUDE_CONFIG_DIR` fixture.
Automated verification must not read, write, move, or archive files in the operator's real `~/.claude` directory.
It must provide an explicit temporary-fixture scope to every transcript CLI it runs.

The automated test suite must cover path traversal rejection, source containment, collision handling, unreadable JSONL, pending archive recovery, Windows path grouping, duplicate score input, and invalid project caps.

CI must run build output validation in addition to formatting, type checking, and unit tests.

## Non-goals

- Automatic memory capture or injection.
- Hook, MCP, database, or background-worker integration.
- Cross-project memory recall.
- Hard deletion of transcripts or archives.
- A public release until the release gate passes and the operator performs an approved live dry-run.

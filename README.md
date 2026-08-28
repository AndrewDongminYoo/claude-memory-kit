# claude-memory-kit

`claude-memory-kit` provides one manual Claude Code workflow: review cold session transcripts before retention removes them, promote approved lessons to native Markdown memory, and safely preserve the processed transcript.

The plugin does not capture memory automatically.
It does not use hooks, a database, a background worker, or cross-project recall.

Every transcript command requires `CMK_SCOPE_SLUG_PREFIXES` with one or more comma-separated project-slug prefixes that the operator approved for the batch.

```bash
export CMK_SCOPE_SLUG_PREFIXES="<approved-slug-prefix-1>,<approved-slug-prefix-2>"
```

An absent or empty value fails closed before the command scans, scores, moves, or records a transcript.

## Requirements

The installed plugin requires Node.js 22.23.2 or later.
It runs committed files from `dist/` and does not require a global `tsx` executable or plugin-local `node_modules` directory.

## Installation

This repository is its own Claude Code plugin marketplace.

```log
/plugin marketplace add AndrewDongminYoo/claude-memory-kit
/plugin install claude-memory-kit@claude-memory-kit
```

For local development, load the plugin directory directly.

```bash
claude --plugin-dir /path/to/claude-memory-kit
```

## Workflow

```log
scan-cold -> score-prefilter -> deep read -> operator approval -> native Markdown memory -> finalize archive
read-only    read-only         selected     required            agent-owned            pending -> archived
```

1. `scan-cold` lists un-mined main-session transcripts in the configured scope that are at least 14 days old by default.
2. `score-prefilter` selects the highest-value configured-scope transcripts for a deep read and reports malformed JSONL as `unreadable`.
3. The agent proposes source-backed native Markdown memory entries from selected transcripts.
4. The operator approves, edits, or rejects each proposal before any memory write.
5. `finalize-transcript` records a pending event, archives only a validated main-session transcript without overwriting another archive, and records completion.

An interrupted finalization can be resumed without another memory write.

```bash
node "${CLAUDE_PLUGIN_ROOT}/dist/recover-pending-archives.js"
```

An `unreadable` transcript stays in its original location.
The finalizer records its outcome without archiving it.

## Safety boundary

- Candidate discovery and prefiltering are read-only.
- Every transcript command fails closed without an explicit non-empty `CMK_SCOPE_SLUG_PREFIXES` value.
- The scanner skips an out-of-scope slug before it reads a transcript file.
- The plugin writes native memory only after an explicit operator decision.
- Archive paths must remain under the configured Claude root.
- The archive rejects traversal, source paths outside `projects/<slug>/`, and symbolic links.
- Archive destinations use exclusive creation and preserve existing files with a numeric suffix.
- The source remains until the archive payload exists.
- The ledger is append-only and excludes pending and completed sessions from new proposals.
- Automated verification uses a temporary `CLAUDE_CONFIG_DIR` fixture and never reads or changes the operator's real `~/.claude` data.

## Configuration

| Knob                      | Default     | Meaning                                                                      |
| ------------------------- | ----------- | ---------------------------------------------------------------------------- |
| `CMK_SCOPE_SLUG_PREFIXES` | required    | Comma-separated approved project-slug prefixes. An empty value fails closed. |
| `COLD_DAYS`               | `14`        | Minimum candidate age in days.                                               |
| `MAX_PER_PROJECT`         | `5`         | Maximum deep reads per project. `0` disables the cap.                        |
| `CMK_MTIME_ONLY`          | unset       | Set to `1` to use only file mtime for age.                                   |
| `CLAUDE_CONFIG_DIR`       | `~/.claude` | Claude configuration root.                                                   |
| `SCORE_MIN`               | `12`        | Read-only prefilter threshold in `scripts/lib/score.ts`.                     |

Keep `COLD_DAYS` below the transcript retention period.
Otherwise retention can remove a transcript before it becomes a candidate.

## Development

```bash
pnpm install --frozen-lockfile
pnpm build
pnpm run typecheck
pnpm run format:check
pnpm test
pnpm verify:plugin
```

`pnpm verify:plugin` copies only the distributable plugin files to a temporary directory without `node_modules`.
It runs the compiled scan and score commands with a temporary `CLAUDE_CONFIG_DIR` fixture.

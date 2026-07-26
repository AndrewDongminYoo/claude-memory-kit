# claude-memory-kit

A Claude Code plugin bundling on-demand skills for managing Claude Code's native, file-based memory — the `~/.claude/projects/<slug>/memory/*.md` files and their `MEMORY.md` index — and the surrounding `~/.claude` state.

This is **not** a capture hook like `claude-mem` or `remember`.
It works with the native, human-in-the-loop memory model: you invoke a skill, its deterministic helpers gather candidates, the LLM proposes changes, and nothing is written or moved until you confirm it.

## Installation

This repo is its own plugin marketplace (`.claude-plugin/marketplace.json`).
In Claude Code:

```log
/plugin marketplace add AndrewDongminYoo/claude-memory-kit
/plugin install claude-memory-kit@claude-memory-kit
```

For local development, load it directly without a marketplace:

```bash
claude --plugin-dir /path/to/claude-memory-kit
```

Skills are namespaced once installed, e.g. `/claude-memory-kit:mine-stale-transcripts`.

## Skills

| Skill                    | Status                        | Purpose                                                                                                   |
| ------------------------ | ----------------------------- | --------------------------------------------------------------------------------------------------------- |
| `mine-stale-transcripts` | built; pending first live run | Review cold session transcripts, capture memory-worthy value with a confirm gate, then soft-archive them. |

Planned (each its own spec → plan → implementation cycle): merge split-path memory, promote repeated rules, review per-project config, quarantine `~/.claude` noise.
See `docs/notes/` for the suite decomposition, `docs/specs/` for per-slice designs, and `docs/plans/` for implementation plans.

## How `mine-stale-transcripts` works

```log
scan-cold ──▶ score-prefilter ──▶ LLM deep read ──▶ batch confirm ──▶ write memory ──▶ ledger + soft-archive
(read-only)   (read-only, no LLM)  (above-threshold)  (operator gate)   (approved only)   (move, never delete)
```

1. **Scan** — list cold (default 30+ days), un-mined main-session transcripts. Age is derived from the transcript's internal session timestamp, so bulk-reset `mtime` on copied or worktree config dirs doesn't resurrect old sessions as fresh.
2. **Prefilter** — a cheap, deterministic score (corrections, decisions, artifacts, substance) triages which transcripts earn an expensive LLM read. Sessions that already curated their own memory are dampened so un-curated dev sessions rank first.
3. **Deep read and propose** — the LLM reads each above-threshold transcript and proposes memory entries, each source-verified against specific transcript turns, scoped (project vs global), and de-duplicated against existing memory.
4. **Confirm** — all proposals are presented for approval; the default run is a dry-run that stops here.
5. **Write, ledger, archive** — approved entries are written to native memory; every processed transcript is recorded in an append-only ledger and moved (never deleted) to `~/.claude/.transcript-archive/<slug>/`.

### Safety guarantees

- Dry-run by default: no memory write, no archive, until a batch is confirmed.
- Transcripts are never hard-deleted — soft-archive is a recoverable move.
- Helper scripts are deterministic: no LLM calls, no byte deletion. All judgment and every write pass through the confirm gate.
- Account separation (work vs personal projects) is a hard boundary; ambiguity is asked about, never inferred.

### Configuration

| Knob                | Default         | Meaning                                                      |
| ------------------- | --------------- | ------------------------------------------------------------ |
| `COLD_DAYS`         | `30`            | Minimum age in days for a transcript to be a candidate.      |
| `CMK_MTIME_ONLY`    | unset           | Set to `1` to force `mtime`-based age (skip internal parse). |
| `CLAUDE_CONFIG_DIR` | `~/.claude`     | Root of the Claude config tree the scripts operate on.       |
| `SCORE_MIN`         | `12` (constant) | Prefilter threshold in `scripts/lib/score.ts`, test-pinned.  |

State lives in gitignored paths inside `~/.claude`: the mining ledger at `.claude-memory-kit/mining-ledger.jsonl` and the archive at `.transcript-archive/`.

## Development

```bash
pnpm install
pnpm run typecheck      # tsc --noEmit
pnpm run format:check   # prettier
pnpm test               # run scripts/*.test.ts via tsx
```

Helper scripts under `scripts/` run directly with `tsx` (no build step) and are deterministic — they never call an LLM or delete files; the LLM judgment and confirm loop live in the skills.

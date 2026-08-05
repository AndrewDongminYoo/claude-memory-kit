# claude-memory-kit

A Claude Code plugin bundling on-demand skills for managing Claude Code's native, file-based memory — the `~/.claude/projects/<slug>/memory/*.md` files and their `MEMORY.md` index — and the surrounding `~/.claude` state.

This is **not** a capture hook like `claude-mem` or `remember`.
It works with the native, human-in-the-loop memory model: you invoke a skill, its deterministic helpers gather candidates, the LLM proposes changes, and nothing is written or moved until you confirm it.

## Why

Every Claude Code session leaves a transcript under `~/.claude/projects/` — and that directory only grows (easily hundreds of files and hundreds of MB).
Buried in those transcripts are the corrections you gave once and had to give again, the decisions that never made it into memory, the gotchas a session learned the hard way and then forgot.
When a session goes cold, that knowledge dies with it — unless you mine it first.

A run looks like this from your side:

```log
> /claude-memory-kit:mine-stale-transcripts

Scanned 214 cold transcripts (30+ days old, never mined) across 12 projects.
Prefilter: 9 worth an LLM read; the rest ledgered as low-score.

3 memory proposals from those 9 sessions:

[my-app] project · new file: ios-build-cache.md
  "Xcode incremental builds break after `pod install`; wipe DerivedData
   first. Decided in session 2026-05-12 after two failed fixes."
  Evidence: turns 41–44 (your correction), turn 58 (working fix)

Approve, edit, or reject each — nothing is written or archived until you say so.
```

You approve the entries worth keeping, and the next session in that project starts already knowing them.
The processed transcripts move to a recoverable archive, so `~/.claude/projects/` shrinks without a single byte deleted.

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
(read-only)   (read-only, no LLM)  (selected only)   (operator gate)   (approved only)   (move, never delete)
```

1. **Scan** — list cold (default 14+ days), un-mined main-session transcripts. Age is derived from the transcript's internal session timestamp, so bulk-reset `mtime` on copied or worktree config dirs doesn't resurrect old sessions as fresh. Finding nothing prints the corpus age span, because zero candidates is also what a retention collision looks like.
2. **Prefilter** — a cheap, deterministic score (corrections, decisions, artifacts, substance) triages which transcripts earn an expensive LLM read. Sessions that already curated their own memory are dampened so un-curated dev sessions rank first, and a per-project cap keeps one busy project from consuming the whole batch.
3. **Deep read and propose** — the LLM reads each selected transcript and proposes memory entries, each source-verified against specific transcript turns, scoped (project vs global), and de-duplicated against existing memory.
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
| `COLD_DAYS`         | `14`            | Minimum age in days for a transcript to be a candidate.      |
| `MAX_PER_PROJECT`   | `5`             | Cap on deep reads per project; `0` disables the cap.         |
| `CMK_MTIME_ONLY`    | unset           | Set to `1` to force `mtime`-based age (skip internal parse). |
| `CLAUDE_CONFIG_DIR` | `~/.claude`     | Root of the Claude config tree the scripts operate on.       |
| `SCORE_MIN`         | `12` (constant) | Prefilter threshold in `scripts/lib/score.ts`, test-pinned.  |

#### `COLD_DAYS` must stay under your retention window

Claude Code deletes old transcripts on its own schedule (`cleanupPeriodDays` in `settings.json`, 30 by default).
If `COLD_DAYS` reaches that limit, a transcript becomes eligible for mining at the same moment retention deletes it, and the scan returns zero forever — a silent structural failure, not an empty backlog.
Measured on a 2267-transcript corpus (2026-08-05): `COLD_DAYS=30` yielded 0 candidates, `COLD_DAYS=14` yielded 786.
The default is 14 for that reason, and `scan-cold` prints the corpus age span whenever it finds nothing, so the collision is visible instead of silent.

#### Why a per-project cap instead of a higher threshold

The prefilter score separates projects but saturates within one — long sessions max every signal cap, so the top of the ranking flattens.
On the same corpus, 80% of the 155 above-threshold transcripts came from a single project, and raising `SCORE_MIN` concentrated the batch further (98% at 70) rather than trimming it.
`MAX_PER_PROJECT` is the lever that actually diversifies the batch: cap 5 turned 155 deep reads into 21 across 5 projects.

State lives in gitignored paths inside `~/.claude`: the mining ledger at `.claude-memory-kit/mining-ledger.jsonl` and the archive at `.transcript-archive/`.

## Development

```bash
pnpm install
pnpm run typecheck      # tsc --noEmit
pnpm run format:check   # prettier
pnpm test               # run scripts/*.test.ts via tsx
```

Helper scripts under `scripts/` run directly with `tsx` (no build step) and are deterministic — they never call an LLM or delete files; the LLM judgment and confirm loop live in the skills.

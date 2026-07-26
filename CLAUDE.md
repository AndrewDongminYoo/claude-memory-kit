# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
pnpm install
pnpm run typecheck                                    # tsc --noEmit
pnpm run format:check                                 # prettier check (format to fix)
pnpm test                                             # all tests: node --import tsx --test scripts/**/*.test.ts
node --import tsx --test scripts/lib/score.test.ts    # single test file
```

Scripts are TypeScript run directly with `tsx` (no build step): `tsx scripts/scan-cold.ts`.

## What this is

A Claude Code **plugin** (`.claude-plugin/plugin.json`) bundling on-demand skills for managing Claude Code's native file-based memory (`~/.claude/projects/<slug>/memory/*.md` + `MEMORY.md` index).
Deliberately **not** a capture hook: skills are invoked manually, propose changes, and write only what the operator confirms.
Document flow lives in `docs/`: `notes/` (suite decomposition — the six planned components and sequencing) → `specs/` (per-slice design) → `plans/` (implementation plans).
Only slice #4, `mine-stale-transcripts`, is built so far; the others (merge split-path memory, promote rules, config review, quarantine) are deferred and each gets its own spec cycle.

## Architecture — two strictly separated layers

**Deterministic helper scripts** (`scripts/`, tested): never call an LLM, never delete bytes, read-only except `archive-transcript.ts` (which only moves files).
CLI entry points are thin wrappers over `scripts/lib/` modules:

- `scan-cold.ts` → `lib/scan.ts`: lists cold, un-mined main-session transcripts (sub-agent/workflow child transcripts excluded). Age comes from the transcript's _internal_ session timestamp by default, not mtime — mtime is bulk-reset on copied/worktree config dirs (`lib/timestamps.ts`; `CMK_MTIME_ONLY=1` forces mtime, `COLD_DAYS` overrides the 30-day cutoff).
- `score-prefilter.ts` → `lib/score.ts`: cheap no-LLM triage score deciding which transcripts earn an expensive LLM deep read (`SCORE_MIN` constant, currently 12). Signal weights are pinned by `score.test.ts` fixtures — a reweighting that reorders known-worthy vs known-noise fixtures fails loudly. The `selfCurated` signal dampens sessions that already wrote to memory/rules (they're keyword-dense but re-mining them yields duplicates).
- `archive-transcript.ts` → `lib/archive.ts`: soft-archive = move to `~/.claude/.transcript-archive/<slug>/`, numeric-suffix on collision, never overwrite or delete.
- `lib/ledger.ts`: append-only JSONL at `~/.claude/.claude-memory-kit/mining-ledger.jsonl` — the source of truth for "already mined". Ledger and archive are deliberately gitignored paths inside the `~/.claude` repo.
- `lib/paths.ts`: resolves the Claude root from `$CLAUDE_CONFIG_DIR` else `~/.claude` — never hardcode home paths.

**Skill layer** (`skills/*/SKILL.md`): holds all LLM judgment and the human confirm loop.
The pipeline (scan → prefilter → deep read/propose → batch confirm → write memory → ledger + archive → report) is orchestrated by the skill prose, not by code.

## Invariants (do not weaken in any change)

- Dry-run by default; no memory write and no archive until the operator confirms a batch.
- Transcripts are never hard-deleted — soft-archive (move) only; unparseable files are ledgered `unreadable` and left in place.
- Helper scripts stay deterministic and LLM-free; new judgment belongs in the skill, new mechanics in `scripts/lib/` with tests.
- Account separation (work vs personal slugs) is a hard boundary in the mining skill — ask, never infer.

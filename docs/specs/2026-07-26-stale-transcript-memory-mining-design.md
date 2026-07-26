# Design — stale-transcript memory mining (`mine-stale-transcripts`)

Date: 2026-07-26
Status: proposed (awaiting operator review)
Slice: #4 of the claude-memory-kit suite (see `docs/notes/2026-07-26-suite-decomposition.md`)

## Problem

Claude Code writes every session to a `~/.claude/projects/<slug>/*.jsonl` transcript.
On this machine there are **1672** such transcripts totalling **562M**, none tracked in git.
Cold sessions accumulate genuine decisions, corrections, and post-mortems that were never distilled into the tracked native memory, so the value is stranded in files that are otherwise disposable.
There is no tool that reviews cold transcripts, captures what is worth remembering, and then reclaims the space.

## Goal and non-goals

Primary goal: **preserve knowledge** — surface memory-worthy facts from cold transcripts and record them (with confirmation) into native memory.
Secondary goal: reclaim disk by removing transcripts once mined.

Non-goals:

- Not a capture _hook_; it runs on demand (later, a launchd _notification_ may prompt a run, but never an autonomous write).
- Not an autonomous memory writer — every memory write passes a human confirm gate.
- Not a hard-deleter — transcripts are soft-archived (recoverable), never `rm`-ed.
- Not the shared `native-memory` CLI — that is extracted later when a second skill needs it.

## Approach (A): skill + minimal deterministic helpers

A single skill, `mine-stale-transcripts`, orchestrates the run.
Deterministic, testable work is pushed into small helper scripts the skill calls; the LLM judgment and the confirm loop stay in the skill/agent.

```log
mine-stale-transcripts (SKILL.md, agent-driven)
  ├─ scan-cold.<ext>       → list cold, un-mined candidate transcripts (deterministic)
  ├─ score-prefilter.<ext> → cheap per-transcript value score, no LLM (deterministic)
  ├─ (agent) deep-read + propose memory entries for high-score candidates
  ├─ (agent) batch confirm loop with the operator
  ├─ write-memory (agent, via native memory format) — only confirmed entries
  ├─ archive-transcript.<ext> → soft-archive processed transcripts (deterministic)
  └─ ledger.<ext>          → append processed record (deterministic)
```

Helper language: **TypeScript run via a pinned runner** (matches the operator's existing script toolkits) OR POSIX `sh` if the logic stays trivial; decided in the plan.
The helpers read only `~/.claude`; they never call an LLM and never delete.

## Data flow

1. **Scan** — enumerate `~/.claude/projects/<slug>/*.jsonl`.
   A transcript is a **candidate** when both hold:
   - **cold**: `mtime` older than `COLD_DAYS` (default **30**), so the session is finished and unlikely to be resumed; and
   - **un-mined**: its session id is absent from the ledger (each transcript is mined at most once).
2. **Prefilter score** — for each candidate, compute a cheap value score from the raw jsonl **without an LLM** (see Scoring).
   Candidates below `SCORE_MIN` skip the deep read and go straight to archive as low-value noise (their session id is still ledgered, with `outcome: skipped-low-score`).
3. **Deep read + propose** — for candidates at or above `SCORE_MIN`, the agent reads the transcript and proposes zero or more memory entries, each in native memory format, correctly scoped, and de-duplicated against existing memory (see Proposal).
4. **Confirm** — the agent presents proposed entries in a batch; the operator approves, edits, or rejects each (see Confirm).
5. **Write** — only approved entries are written to `~/.claude/projects/<slug>/memory/<slug-name>.md` plus a one-line pointer in that project's `MEMORY.md`.
6. **Archive + ledger** — every processed transcript (whether it yielded memory or not) is soft-archived and recorded in the ledger.

## Candidate selection details

- `COLD_DAYS` default 30, overridable per run.
- Cross-path duplicates: the same logical project can appear under `-Users-…` and `-Volumes-…` slugs (the #2 problem).
  This skill does **not** merge them — it treats each slug dir independently and writes any resulting memory into that same slug's `memory/`.
  Consolidating split memory is #2's job; this skill must not pre-empt it.
- **Main-session transcripts only** (`projects/<slug>/*.jsonl`, one level deep). Verified 2026-07-26: `projects/` holds 903 main-session transcripts plus ~769 nested `…/<session>/subagents/**.jsonl` sub-agent and workflow-agent child transcripts. The nested children are **out of scope for mining** — their knowledge is already reflected in the parent session, and they are noise-heavy internal delegation. They are pure disk (a #6 / disk-GC concern), removed with their parent's archival, not mined.
- `history.jsonl`, `shell-snapshots/`, `todos/`, `sessions/` and other ephemeral state are also out of scope (they belong to #6).
- Field note (2026-07-26): the oldest transcript on disk is ~22 days, so at the default `COLD_DAYS=30` there are currently zero candidates — expected, not a bug. First live runs will either wait for sessions to age past 30 days or lower `COLD_DAYS` deliberately.
- **Age source — internal timestamp, not mtime.** On a copied or git-worktree config dir (e.g. `/Volumes/dongminyu/.claude`), a bulk checkout/rsync resets every transcript's mtime to one instant, so mtime silently understates age and cold detection finds nothing. The scanner therefore derives age from the transcript's **internal per-entry `timestamp`** (the earlier of internal-time and mtime), falling back to mtime only when no internal timestamp exists. Verified 2026-07-26 on the external-volume `.claude` worktree: `COLD_DAYS=7` found **0** candidates by mtime but **129** by internal timestamp. Costs one file read per candidate; set `CMK_MTIME_ONLY=1` to force the cheap mtime path when the dir is known-pristine.

## Cheap prefilter scoring (no LLM)

The score is a weighted sum of signals extractable by scanning the jsonl lines, chosen because they correlate with "this session produced a durable decision" while costing only a file read:

- **operator-correction signals** — user turns containing correction/directive markers (e.g. `아니라`, `하지 마세요`, `대신`, "actually", "instead", "don't", "revert"); these are the single strongest memory-worthy signal.
- **decision / post-mortem keywords** — `root cause`, `decided`, `turns out`, `the fix`, `gotcha`, `TIL`, `remember`, honesty markers (`[UNKNOWN]`, `[PARTIAL]`).
- **durable-artifact signals** — git commit hashes / `git commit` invocations, file writes to tracked config, PR / release actions.
- **substance proxies** — assistant/user turn count and tool-use density above a floor (filters trivial one-shot Q&A).
- **negative signals** — session dominated by errors with no resolution lowers the score.
- **self-curated dampening** — a session that wrote to `**/memory/`, `**/rules/`, `MEMORY.md`, or `CLAUDE.md` has already captured its own value; its score is multiplied by 0.4 so genuinely un-curated dev sessions outrank it. This is the **workspace-premise** adjustment: this workspace runs GC / memory-curation in dedicated independent sessions, which are keyword-dense and would otherwise saturate the top with already-captured material.

Weights and thresholds are constants in `score-prefilter`, tuned against a labelled sample of real transcripts during the plan's calibration step, and are covered by a unit test so a weight change that regresses a known-good/known-noise fixture fails loudly.
The scorer emits, per candidate, a numeric score plus the matched signals, so the deep-read step (and the operator) can see _why_ a transcript was surfaced.

Calibration v1 (2026-07-26): scored a random 120-transcript sample. Distribution 0 / 1.4 / 49.5; **39%** cleared `SCORE_MIN=6`; top scorers were genuine heavy-work sessions, but the top **saturated at 52** (all caps hit), so heavy sessions could not be ranked against each other.

Calibration v2 (2026-07-26), after the `COLD_DAYS=7` demo over 763 candidates:

- **Caps raised** (`correction 6, decision 10, honesty 8, artifact 6, substance 5`) — the top de-saturated (max 76.5, one session at max, versus a large tie at 52 before).
- **`SCORE_MIN` raised to 12** — above-threshold share fell from 35% to 31%, trimming LLM deep-read cost while keeping high recall.
- **Self-curated dampening added** (see above) — 41 native-memory-writing sessions were detected and dampened. Note: `llm-wiki-dongminyu` sessions still rank at the top and are _not_ flagged, correctly — they curate the wiki store, not `~/.claude` native memory, so their native-memory-worthy operator feedback may be un-captured; dedup at deep-read time handles any redundancy.
- Remaining item: heavy sessions that hit every cap still tie; a turn-count or size tiebreaker is deferred.

Calibration v3 (2026-07-26), after the first live mining batch on the external-volume worktree: the two **highest** scorers were scorer false-positives that the deep-read correctly rejected — a deep-research "expert research analyst" query (its output is a wiki page, not native memory) and an `/insights` usage-report session (generated analysis, not an operator decision). These automated-analysis sessions are keyword-dense (decisions/verdicts in their generated prose) but hold no native-memory-worthy operator feedback. Candidate future signal: treat a first-user-turn matching `expert research analyst` / `/insights` / `produce a structured analysis` as a negative signal, the same way `selfCurated` is. Not yet implemented — recorded so the pattern is not re-discovered. Live yield this batch: 1 memory-worthy of 4 above-threshold, confirming the deep-read + confirm gate, not the scorer, is what guards precision.

## Deep read and memory proposal

For each above-threshold candidate the agent:

- reads the transcript (chunking or summarising if it is very large, so a single huge session cannot blow the context budget);
- extracts only **durable, non-obvious** facts — the same bar the native memory rules already set: skip what the repo/git history/CLAUDE.md already records, skip conversation-local detail;
- classifies each fact's **scope** per `~/.claude/rules/memory-scope.md` (project vs global) and its **type** (`user` / `feedback` / `project` / `reference`);
- **de-duplicates** against the existing `MEMORY.md` and memory files for that project (and, for global facts, against `~/.claude/rules/`), proposing an _update_ to an existing entry rather than a duplicate when one already covers the topic;
- formats each as a native memory file body with correct frontmatter, ready to write verbatim on approval.

Every proposed fact is **source-verified** against the transcript (SVOP): the proposal cites the transcript turn(s) it derives from, and the agent never invents dates, ids, or proper nouns not present in the session.

## Confirm loop

Batch review, not per-file interruption.
After a run's deep-read pass, the agent presents all proposed entries grouped by project, each showing: proposed memory body, scope/type, the transcript evidence, and whether it is a new file or an update to an existing one.
The operator approves / edits / rejects each entry.
Only approved entries are written.
Rejected entries are recorded in the ledger (`outcome: proposed-rejected`) so the same transcript is not re-proposed on a later run.

Default run is **dry-run**: it scores, deep-reads, and prints proposals, but writes no memory and archives nothing until the operator confirms the batch.

## Soft-archive and ledger

- **Archive**: processed transcripts are moved to `~/.claude/.transcript-archive/<slug>/<session>.jsonl` (gitignored, outside `projects/`), preserving the slug so a transcript can be restored to its origin.
  Nothing is hard-deleted; disk under `projects/` is reclaimed but the bytes remain until the operator prunes the archive (a later, separate decision — possibly #6).
- **Ledger**: an append-only JSONL at `~/.claude/.claude-memory-kit/mining-ledger.jsonl`, one record per processed session: `{session_id, slug, processed_at, score, outcome, memory_written: [paths]}`.
  Append-only makes an interrupted run resumable and idempotent — a re-run skips everything already ledgered.
  The ledger is the source of truth for "un-mined"; it is small and may be tracked in the `~/.claude` repo (operator's call).

## Account separation

Transcripts mix personal and work-context sessions.
The skill honours the operator's hard boundary and the wiki work-de-attribution policy:

- It derives a session's account from its project slug and the operator's known mapping; when the account is work-scope, proposed memory must not carry concrete work identifiers (employer, ticket ids) into personal memory, and sensitive employment content is never written to a shareable artifact.
- When account is ambiguous, the skill asks rather than infers (SVOP "don't guess — ask").

## Error handling

- Corrupt / partial jsonl: the scanner skips unreadable lines and flags the file; a transcript that cannot be parsed is left in place and ledgered `outcome: unreadable`, never archived blindly.
- Very large transcripts: summarise-then-mine so context is bounded.
- Interrupted run: the append-only ledger means the next run resumes from where it stopped; no double-write, no double-archive.
- The `~/.claude` repo may be modified by the operator in parallel — the skill stages only the specific memory files it writes and never runs a bulk `git add -A` (operator-parallel-git discipline).

## Testing

- Helper scripts (`scan-cold`, `score-prefilter`, `archive-transcript`, `ledger`) each get unit tests, including a labelled fixture set of small transcripts (one clearly memory-worthy, one clear noise) that pins the scorer's ranking so a weight regression fails.
- The skill ships a dry-run path exercised end-to-end against a fixture `projects/` tree, asserting: correct candidates chosen, no writes in dry-run, archive+ledger only after confirm, idempotent re-run.
- No network, no LLM in the helper tests.

## Resolved decisions (2026-07-26)

- Helper language: **TypeScript**, run via a pinned runner (`tsx`), matching the operator's existing script toolkits.
- The ledger and the archive are **not tracked** in the `~/.claude` git repo — both live under gitignored paths and hold local-only operational state.

## Open questions (resolve later)

- Scorer weights: finalize against a real labelled sample during calibration (plan Phase 2).

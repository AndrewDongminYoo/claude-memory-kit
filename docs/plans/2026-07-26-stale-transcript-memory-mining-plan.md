# Implementation plan — `mine-stale-transcripts` (slice #4)

Date: 2026-07-26
Status: in progress — Phases 0–4 built and tested; Phases 5–6 gated on real cold data
Design: `docs/specs/2026-07-26-stale-transcript-memory-mining-design.md`

## Progress (2026-07-26)

- Phase 0 — scaffold: **done** (TypeScript plugin, tsx/tsc/prettier gate).
- Phase 1 — scan + ledger: **done** (main-session-only scanner, append-only ledger, 9 tests).
- Phase 2 — prefilter scorer: **done** (no-LLM signal scorer, calibrated on a 120-transcript live sample, worthy-vs-noise ranking pinned).
- Phase 3 — skill orchestration: **done** (`SKILL.md` wires scan → score → deep-read → confirm → write → ledger → archive with the guardrails).
- Phase 4 — soft-archive + write path: **archive helper done** (move-not-delete, collision-safe, 16 tests total).
- Phase 5 — real dry-run calibration: **blocked** — the oldest transcript on disk is ~22 days, so at `COLD_DAYS=30` there are zero candidates. Run once sessions age past 30 days, or lower `COLD_DAYS` deliberately for a first pass.
- Phase 6 — first live mining run: **gated** on Phase 5 and operator presence (it writes memory and archives).

## Success criteria

The slice is done when, on a fixture `projects/` tree and then on the real `~/.claude`:

1. A dry-run surfaces the correct cold, un-mined candidates ranked by value, with matched signals shown, and writes nothing.
2. After a batch confirm, only approved memory entries are written (native format, correct scope/type, MEMORY.md pointer updated), processed transcripts are soft-archived, and the ledger records every processed session.
3. A re-run is idempotent — already-ledgered sessions are skipped.
4. Helper unit tests pass, including the scorer ranking fixture.

## Phase 0 — repo scaffold and conventions

- Add the Claude plugin skeleton: `.claude-plugin/plugin.json`, `skills/mine-stale-transcripts/SKILL.md` (stub), `scripts/`, `tests/`, `README.md`, `.gitignore`, and the tooling manifest for the chosen helper language.
- Decide helper language (design open question): default to **TypeScript run via the operator's pinned runner** to match existing script toolkits; fall back to POSIX `sh` only if every helper stays trivial.
- Verify: `<runner> --version` resolves; lint/format gate runs clean on the empty scaffold.

## Phase 1 — cold-scan + ledger helpers

- `scripts/scan-cold` — enumerate `~/.claude/projects/**/*.jsonl`, filter by `mtime > COLD_DAYS` (default 30) and absence from the ledger, emit `{session_id, slug, path, mtime, size}` as JSON.
- `scripts/ledger` — append-only reader/writer over `~/.claude/.claude-memory-kit/mining-ledger.jsonl`; `has(session_id)`, `append(record)`.
- Root resolution: never hardcode `~/.claude`; resolve from `$CLAUDE_CONFIG_DIR` or `$HOME/.claude`, and confirm it is a directory before touching it.
- Verify: unit tests for cold cutoff (boundary at exactly `COLD_DAYS`), ledger round-trip, and ledger-skip; run against a temp fixture tree, not the real `~/.claude`.

## Phase 2 — cheap prefilter scorer (+ calibration)

- `scripts/score-prefilter` — read one transcript's jsonl, compute the weighted signal score from the design's signal list, emit `{score, matched_signals[]}`; no LLM, no network.
- Calibration: hand-label a small sample of ~15–20 real transcripts as memory-worthy / noise, tune weights and `SCORE_MIN` so the ranking separates them, and freeze that sample as a ranking fixture.
- Verify: scorer unit test asserts the known-worthy fixture outranks the known-noise fixture and that `SCORE_MIN` splits them; changing a weight to break this fails the test.

## Phase 3 — the skill (orchestration, dry-run first)

- Write `skills/mine-stale-transcripts/SKILL.md`: scan → score → (for `>= SCORE_MIN`) deep-read + propose → batch-confirm → write → archive → ledger.
- Encode the guardrails as explicit skill steps: SVOP citation of transcript evidence per proposal, scope/type classification per `memory-scope.md`, de-dup against existing `MEMORY.md`, account-boundary check with ask-don't-infer, dry-run as the default and writes only after batch confirm.
- Verify: run the skill in dry-run against the Phase-1 fixture tree; assert candidates chosen match expectation and nothing is written or archived.

## Phase 4 — soft-archive + write path

- `scripts/archive-transcript` — move a processed transcript to `~/.claude/.transcript-archive/<slug>/<session>.jsonl`, creating dirs, never overwriting (suffix on collision), never `rm`.
- Wire the skill's post-confirm path: write approved memory files + MEMORY.md pointer (staging only those paths, no bulk `git add`), then archive + ledger each processed transcript.
- Verify: on the fixture tree, after a simulated confirm — approved memory present and correctly scoped, transcript moved to archive (origin empty), ledger updated; re-run is a no-op.

## Phase 5 — real-world dry-run and calibration check

- Run dry-run against the real `~/.claude` (read-only): confirm candidate count is sane, the top-ranked transcripts are genuinely the interesting ones, and low-score noise is correctly demoted.
- Adjust `COLD_DAYS` / weights if the real distribution disagrees with the fixture; do not change behaviour silently — record any tuning in the design's calibration note.
- Verify: operator eyeballs the ranked dry-run output and confirms the top candidates are worth mining before any live write.

## Phase 6 — first live mining run (gated)

- With operator present, run one live batch on a small set (e.g. the top few candidates of a single project), confirm entries, and inspect the written memory + archive + ledger.
- Verify: the written memory reads correctly, `~/.claude` git shows only the intended memory files staged, and the mined transcripts are archived and ledgered.

## Out of scope (this slice)

- launchd notification wrapper (later, thin).
- Extracting the shared `native-memory` helper CLI (only when #2 / #3 need it).
- Merging split-slug memory (#2), rule promotion (#3), config review (#5), `~/.claude` noise quarantine (#6).

## Risks

- **Scorer false-negatives** drop real value on the floor: mitigated by keeping the archive recoverable (nothing hard-deleted) and by surfacing matched signals for operator spot-checks.
- **Context blow-up** on huge transcripts: mitigated by summarise-then-mine and per-run candidate caps.
- **Account-boundary leakage** into personal memory: mitigated by the explicit account check and ask-don't-infer; verified by including a work-scope transcript in the fixture set and asserting no work identifiers are proposed.
- **Parallel operator edits** to `~/.claude`: mitigated by path-scoped staging and never bulk-adding.

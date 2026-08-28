# CLAUDE.md

## Commands

```bash
pnpm install --frozen-lockfile
pnpm build
pnpm run typecheck
pnpm run format:check
pnpm test
pnpm verify:plugin
node --import tsx --test scripts/lib/score.test.ts
```

`pnpm build` compiles the distributable Node.js files into tracked `dist/`.
Installed plugins run `node dist/<entry>.js` and must not rely on `tsx` or `node_modules`.

## Product boundary

This plugin implements one manual workflow: review cold transcripts before retention, propose source-backed native Markdown memory, wait for approval, and preserve processed transcripts safely.

Do not add a hook, database, background worker, automatic memory write, or cross-project recall without a new approved design.

## Architecture

`scripts/` contains deterministic helpers.
The helpers never call an LLM.

- `scan-cold.ts` lists cold, un-mined direct main-session transcripts from approved `projects/<slug>/` prefixes and ignores symbolic links.
- `score-prefilter.ts` scores approved-scope candidates, reports malformed JSONL as `unreadable`, and selects a capped per-project set for deep reading.
- `finalize-transcript.ts` records pending state, calls the validated archive operation, and records archived completion.
- `recover-pending-archives.ts` completes a pending archive without any memory write.
- `lib/archive.ts` rejects traversal, non-project sources, symbolic links, and destination overwrites.
- `lib/ledger.ts` stores append-only JSONL events under `.claude-memory-kit/mining-ledger.jsonl`.

The skill owns LLM judgment, transcript evidence, native-memory authoring, and the operator approval gate.
Helpers own deterministic file and ledger behavior.

## Invariants

- `COLD_DAYS` defaults to 14.
- Every transcript CLI requires non-empty `CMK_SCOPE_SLUG_PREFIXES` and fails closed without it.
- Scanner filtering occurs before a transcript file is read.
- Scan and score are read-only.
- A source transcript remains after finalization completes.
- Unreadable transcripts are ledgered but never archived.
- Pending ledger events and unchanged archived sources prevent another memory proposal for that session.
- A retained source with a changed archived fingerprint returns to score and approval.
- Tests and plugin verification must use a temporary `CLAUDE_CONFIG_DIR` fixture.
- Never run an automated test or smoke check against the operator's real `~/.claude` directory.

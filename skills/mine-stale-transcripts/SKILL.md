---
name: mine-stale-transcripts
description: Use to review cold Claude session transcripts (~/.claude/projects/<slug>/*.jsonl), capture memory-worthy value into native memory with a confirm gate, then soft-archive the processed transcripts. Knowledge-preservation first; nothing is hard-deleted.
---

# Mine stale transcripts

> Status: scaffold. Orchestration is implemented in Phase 3 (see
> `docs/plans/2026-07-26-stale-transcript-memory-mining-plan.md`).

This skill reviews cold, un-mined session transcripts, proposes memory-worthy
entries for operator confirmation, writes only the approved ones into native
memory, and soft-archives the processed transcripts.

Default run is a dry-run: it scores and proposes but writes nothing until a
batch is confirmed.

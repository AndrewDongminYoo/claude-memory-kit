---
name: mine-stale-transcripts
description: Use to review cold Claude session transcripts (~/.claude/projects/<slug>/*.jsonl), capture memory-worthy value into native memory with a confirm gate, then soft-archive the processed transcripts. Knowledge-preservation first; nothing is hard-deleted; every memory write is confirmed.
---

# Mine stale transcripts

Review cold, un-mined session transcripts, propose memory-worthy entries for the
operator to confirm, write only the approved ones into native memory, then
soft-archive the processed transcripts.

**Primary goal is knowledge preservation, not disk reclamation.** Default is a
dry-run: score and propose, but write and archive nothing until a batch is
confirmed.

Helper scripts live under `${CLAUDE_PLUGIN_ROOT}/scripts` and are run with `tsx`.
They are deterministic, never call an LLM, and never delete bytes; the judgment
and the confirm loop are yours.

## When to use

- Periodically, to distil value out of old sessions before they age out of use.
- When `~/.claude/projects/` has grown large and you want the durable knowledge
  captured before reclaiming space.

Do not use it to mine sub-agent or workflow child transcripts — only main-session
transcripts are in scope (the scanner already enforces this).

## Pipeline

### 1. Scan for candidates (read-only)

```bash
tsx "${CLAUDE_PLUGIN_ROOT}/scripts/scan-cold.ts"    # COLD_DAYS=30 default
```

Emits cold (`mtime` age >= `COLD_DAYS`), un-mined (absent from the ledger)
main-session transcripts as JSON, oldest first. Zero candidates is a normal,
valid outcome — stop and say so.

### 2. Prefilter score (read-only, no LLM)

Score the candidate paths; only those at or above `SCORE_MIN` earn an LLM read:

```bash
tsx "${CLAUDE_PLUGIN_ROOT}/scripts/score-prefilter.ts" <path1> <path2> ...
```

Each line reports `score`, `above`, `turns`, and the matched `signals` (so you and
the operator can see _why_ a transcript surfaced). Below-threshold candidates are
**not** read; they are ledgered `skipped-low-score` and archived in step 6.

### 3. Deep read and propose (LLM, above-threshold only)

For each above-threshold transcript, read it (summarise-then-mine if it is very
large so one session cannot blow the context budget) and propose zero or more
memory entries. For every proposed fact:

- **Source-verify it (SVOP).** It must trace to specific transcript turns; cite
  them. Never invent dates, ids, or proper nouns not present in the session.
- **Apply the native-memory bar.** Keep only durable, non-obvious facts. Skip
  what the repo, git history, or CLAUDE.md already records, and skip
  conversation-local detail.
- **Classify scope** per `~/.claude/rules/memory-scope.md` (project vs global)
  and **type** (`user` / `feedback` / `project` / `reference`).
- **De-duplicate.** Check the project's existing `MEMORY.md` and memory files
  (and, for global facts, `~/.claude/rules/`). If an entry already covers it,
  propose an _update_ to that file, not a duplicate.
- **Respect the account boundary.** Derive the account from the slug. For a
  work-scope session, never carry concrete work identifiers (employer, ticket
  ids) into personal memory, and never write sensitive employment content to a
  shareable artifact. If the account is ambiguous, ask — do not infer.

Format each proposal as a native memory file body with correct frontmatter,
ready to write verbatim on approval.

### 4. Batch confirm

Present all proposals grouped by project. For each show: the proposed memory
body, its scope/type, the transcript evidence, and whether it is a new file or an
update to an existing one. The operator approves, edits, or rejects each.

Only approved entries proceed. In a dry-run, stop here and report — write and
archive nothing.

### 5. Write approved memory

For each approved entry, write the memory file under
`~/.claude/projects/<slug>/memory/` and add its one-line pointer to that
project's `MEMORY.md`. Stage only the specific files you write; never
`git add -A` the `~/.claude` repo (it may have parallel operator edits).

### 6. Ledger and soft-archive

For every processed transcript (memory-written, proposed-rejected, or
skipped-low-score), append a ledger record, then soft-archive it:

```bash
tsx "${CLAUDE_PLUGIN_ROOT}/scripts/archive-transcript.ts" <transcript.jsonl> <slug>
```

Archiving moves the transcript to `~/.claude/.transcript-archive/<slug>/`
(recoverable). A transcript that fails to parse is left in place, ledgered
`unreadable`, and never archived blindly.

### 7. Report

Summarise: candidates scanned, above-threshold, memory written (with paths),
skipped, and bytes moved to archive. Note that the archive is recoverable and
that pruning it is a later, separate decision.

## Hard rules

- **Dry-run by default.** No memory write and no archive until a batch is
  confirmed.
- **Never hard-delete a transcript.** Soft-archive only.
- **Never write memory without confirmation.** No autonomous writes.
- **Account separation is a hard boundary.** Ask, do not infer, when unsure.
- **Every proposed fact is source-verified** against the transcript.

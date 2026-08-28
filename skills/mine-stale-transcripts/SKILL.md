---
name: mine-stale-transcripts
description: Use to manually review cold Claude Code transcripts before retention, propose native Markdown memory with evidence, require approval, then safely preserve the processed transcript.
---

# Mine stale transcripts

Review cold main-session transcripts before retention removes them.
Promote only approved, source-backed lessons to native Markdown memory.
Then use the finalizer to preserve the processed transcript.

This workflow is manual.
Do not write memory or finalize an archive until the operator approves the specific batch action.

The installed plugin requires Node.js 22.23.2 or later.
Run only the compiled helper files in `${CLAUDE_PLUGIN_ROOT}/dist`.
Do not require `tsx` or plugin-local `node_modules` at runtime.

Before every helper command, define the approved project-slug prefixes for this batch.

```bash
export CMK_SCOPE_SLUG_PREFIXES="<approved-slug-prefix-1>,<approved-slug-prefix-2>"
```

Every helper fails closed when `CMK_SCOPE_SLUG_PREFIXES` is absent or empty.
Do not use a broad prefix that can include another account.
The scanner skips an out-of-scope slug before it reads a transcript file.

## 1. Recover first

Before a new scan, recover any interrupted finalization.

```bash
node "${CLAUDE_PLUGIN_ROOT}/dist/recover-pending-archives.js"
```

Report unresolved records.
Do not recreate memory proposals or write memory during recovery.

## 2. Scan candidates

Run the read-only scanner.

```bash
node "${CLAUDE_PLUGIN_ROOT}/dist/scan-cold.js"
```

The scanner lists only configured-scope direct `projects/<slug>/<session>.jsonl` main-session transcripts.
It excludes mined sessions and symbolic links.
The default `COLD_DAYS` value is 14.

If the scanner finds no candidates, read its age diagnostic before reporting an empty backlog.
Retention can remove transcripts before they become cold when `COLD_DAYS` is too high.

## 3. Prefilter without an LLM

Pass scanner candidate paths to the read-only prefilter.

```bash
node "${CLAUDE_PLUGIN_ROOT}/dist/score-prefilter.js" <path1> <path2>
```

Read only rows marked `selected` for the deep-read step.
A finalizable row includes a SHA-256 `fingerprint`.
Carry that value through the review and approval step.
Treat a row marked `unreadable` as a preservation problem, not low-score noise.
Do not deep-read or archive an unreadable transcript.
Treat a row marked `missing` as a non-finalizable race result.
Do not deep-read, archive, or ledger it.

After the operator agrees to record the result, preserve its source file and write only its ledger outcome.

```bash
node "${CLAUDE_PLUGIN_ROOT}/dist/finalize-transcript.js" <transcript.jsonl> <slug> 0 unreadable
```

## 4. Deep-read and propose memory

For each selected transcript, propose only durable and non-obvious facts.
Every proposed fact must cite the source transcript turns that support it.
Check existing project memory before proposing a duplicate.

Classify the proposed entry as project or global memory according to the native-memory rules.
Keep work and personal account data separate.
If the scope is ambiguous, ask the operator instead of inferring it.

Present proposals grouped by project.
Show the proposed Markdown body, memory destination, and transcript evidence for each proposal.

## 5. Require approval and write memory

Wait for explicit approval, edits, or rejection of every proposal.
Write only approved native Markdown memory entries.
Update the matching `MEMORY.md` index entry when the native format requires it.

Stage only the memory files written for this confirmed batch.
Do not bulk-stage the Claude configuration repository.

## 6. Finalize the processed transcript

After the approved memory write, or after the operator confirms a rejection or low-score result, run the finalizer once for that transcript.

```bash
node "${CLAUDE_PLUGIN_ROOT}/dist/finalize-transcript.js" <transcript.jsonl> <slug> <score> <memory-written|proposed-rejected|skipped-low-score> <fingerprint> [memory.md ...]
```

The finalizer records a pending archive event before moving the transcript.
It preserves the source until the destination payload exists.
It then writes a completion event.
It rejects an archivable source whose bytes no longer match the reviewed `fingerprint`.
Rescore and obtain approval again when that happens.

Use the recovery command in step 1 if the command stops before completion.
Do not run the finalizer against a path outside the configured `projects/<slug>/` directory.

## Hard rules

- Do not read, write, move, or archive files in an ambiguous account scope.
- Do not run a helper without a non-empty `CMK_SCOPE_SLUG_PREFIXES` value.
- Do not write memory without explicit operator approval.
- Do not hard-delete transcripts or archives.
- Do not treat malformed JSONL as low-score data.
- Do not bypass a pending archive with a new memory write.

# claude-memory-kit — suite decomposition and sequencing

Date: 2026-07-26
Status: accepted (sequencing), living note

## What this project is

`claude-memory-kit` is a **plugin** that bundles a set of **on-demand skills** for managing Claude Code's _native_ file-based memory (the `~/.claude/projects/<slug>/memory/*.md` files and their `MEMORY.md` index), plus the surrounding `~/.claude` state.
It is deliberately **not** hook-based like `claude-mem` or `remember` — the operator manages memory through committed markdown under a `~/.claude` git repo and periodic `gc_config` runs, and wants tooling that works _with_ that native, human-in-the-loop model rather than a passive capture hook.

Form-factor decision: one plugin, several skills, plus a thin shared helper layer that is extracted only when a second skill needs it (see Approach A below).
This answers the operator's open "skill vs plugin?" question: **plugin bundling skills**, because every component is an agent-driven workflow over the `.claude` filesystem — not a passive hook and not a standalone binary.

## The six components (operator's original framing)

| #   | Component                                                                                         | Classification               | Overlap with existing tooling                                                              |
| --- | ------------------------------------------------------------------------------------------------- | ---------------------------- | ------------------------------------------------------------------------------------------ |
| 1   | Native-memory manager, not hook-based                                                             | Umbrella (the plugin itself) | —                                                                                          |
| 2   | Merge memory across worktree / external-volume paths into one dir                                 | Novel skill                  | none                                                                                       |
| 3   | Promote repeated rules → `rules/`; harness-wide → `CLAUDE.md` section                             | Skill                        | automates the existing `~/.claude/rules/memory-scope.md` "Promotion" policy (today manual) |
| 4   | GC stale `.jsonl` transcripts periodically; extract memory-worthy value first with a confirm gate | Novel skill                  | adjacent to `gc_config`                                                                    |
| 5   | Review per-project skills / hooks / settings                                                      | Novel skill (audit)          | none                                                                                       |
| 6   | Soft-delete `~/.claude` noise into a quarantine dir                                               | Skill                        | explicitly "gc_config과 유사" — extends `gc_config`                                        |

Scope flag: this is six components, and #3 / #6 overlap tooling the operator already has.
Each component ships as its own spec → plan → implementation cycle; they are not built together.
#3 and #6 should **extend** `memory-scope` / `gc_config` rather than duplicate them.

## Grounding facts (verified 2026-07-26)

- `~/.claude` is its own git root; it tracks `agent-memory/`, `rules/`, `skills/`, `commands/`, `agents/`, `workflows/`, `settings.json`, and `projects/*/memory/*.md` (a whitelist exception), and gitignores everything else under `projects/`.
- Transcripts: **1672 `*.jsonl` on disk, 0 tracked**; `projects/` is **562M**.
- The same-project-split problem (#2) is currently **low incidence**: only `llm-wiki-dongminyu` is split across `-Users-…` and `-Volumes-…` slugs, and only one side has `memory/`. It recurs structurally whenever a project is opened from a worktree or the external volume.

## Sequencing decision

First slice: **#4 — stale-transcript memory mining** (operator's choice, 2026-07-26).
Rationale: highest immediate recurring value, concrete and verifiable, and its deterministic helpers (transcript scan, cheap scoring, ledger, archive) are the natural seed for the shared helper layer that #2 / #3 will later reuse.

Primary goal of #4: **knowledge preservation first** — mine cold transcripts for memory-worthy value before removing them; disk reclamation is secondary.

## Architecture stance (Approach A)

Build the feature as a **skill plus minimal deterministic helper scripts**, human-in-the-loop by construction.
Extract a shared `native-memory` CLI/library (Approach B) only when the second skill (#2 or #3) actually needs those helpers — not up front (YAGNI).
Defer the launchd daemon (Approach C); later add only a thin launchd _notification_ ("N cold transcripts ready to mine"), never autonomous memory writes.

## Deferred

- Components #2, #3, #5, #6 — each its own later spec.
- Shared `native-memory` helper CLI — extract on second use.
- launchd notification wrapper.

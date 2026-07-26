# claude-memory-kit

On-demand skills for managing Claude Code's native, file-based memory — the `~/.claude/projects/<slug>/memory/*.md` files and their `MEMORY.md` index — and the surrounding `~/.claude` state.

This is **not** a capture hook like `claude-mem` or `remember`.
It works with the native, human-in-the-loop memory model: skills you invoke that read `~/.claude`, propose changes, and write only what you confirm.

See `docs/notes/` for the suite decomposition, `docs/specs/` for per-slice designs, and `docs/plans/` for implementation plans.

## Skills

| Skill                    | Status      | Purpose                                                                                                   |
| ------------------------ | ----------- | --------------------------------------------------------------------------------------------------------- |
| `mine-stale-transcripts` | in progress | Review cold session transcripts, capture memory-worthy value with a confirm gate, then soft-archive them. |

Planned: merge split-path memory, promote repeated rules, review per-project config, quarantine `~/.claude` noise.

## Development

```bash
pnpm install
pnpm run typecheck      # tsc --noEmit
pnpm run format:check   # prettier
pnpm test               # run scripts/*.test.ts via tsx
```

Helper scripts under `scripts/` are deterministic and never call an LLM or delete files; the LLM judgment and confirm loop live in the skills.

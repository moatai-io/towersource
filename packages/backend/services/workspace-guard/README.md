# services/workspace-guard

PreToolUse hook that prevents AI sessions from polluting the workspace
top-level layout.

## Responsibility

Block creation of new top-level folders/files under `~/workspace/` that aren't
on the canonical `ALLOWED_ROOTS` list, and block creation of new project
folders under `~/workspace/projects/` (those must go through the project-create
API to avoid "ghost projects").

Existing top-level entries pass through grandfathered, so ongoing work isn't
disturbed.

## Public API

- `preToolUseWorkspaceGuard(input, toolUseID, opts)` — SDK PreToolUse hook
  callback. Wired in `../ai/claude-sdk.ts` queryOptions.

## Before you touch this

- The `ALLOWED_ROOTS` set is the **single source of truth** for what belongs
  at workspace root. Adding a new root here = policy change → also document
  in `workspace/AGENTS.md` Workspace Layout section.
- Hook **must not throw** — defaults to allow on any error. The deny path
  must be explicit and intentional.
- `TOWER_WORKSPACE_UNRESTRICTED=1` env var = admin escape hatch. All
  overrides logged to `~/workspace/.audit/admin-overrides.log`.
- Bash command parsing is conservative (mkdir/touch/cp/mv/git clone/git
  worktree add). Don't expand without considering false-positive cost —
  the hook must never block legitimate work.

## Related decisions

- `workspace/decisions/2026-05-11-hook-parity-self-hosted-servers.md` — why this
  exists as an SDK hook rather than external `.mjs`
- `workspace/decisions/2026-05-09-tower-hooks-via-sdk-options.md` — general
  policy for new hooks
- `workspace/decisions/2026-05-01-workspace-root-guard.md` — original guard
  design and ALLOWED_ROOTS rationale
- `workspace/decisions/2026-05-04-projects-mkdir-policy.md` — why projects/
  mkdir is special-cased

## Companion

- `../audit/hook.ts` — PostToolUse provenance log. Pair: that records what
  happened; this prevents what shouldn't happen. Block events are also
  recorded by `logBlock` to `~/workspace/.audit/root-write-blocks.log`.
- `../security/connector-guard.ts` — same SDK hook pattern (PreToolUse +
  legacy `decision: 'block'` + new `hookSpecificOutput.permissionDecision`
  for forward compat).

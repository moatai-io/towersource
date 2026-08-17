# services/audit

Provenance audit log for Tower AI sessions.

## Responsibility

Append a one-line JSON record to `~/workspace/.audit/provenance.jsonl` every time
an AI session calls Write / Edit / NotebookEdit / Bash on a path under
`~/workspace/` or `~/tower/`.

The log is the source of truth for:
- `/commit-session` — grep `"$TOWER_SESSION_ID"` to find files this session touched
- multi-session safety — figure out which session created an unfamiliar folder
- post-hoc forensics — admin investigating `~/workspace/foo` provenance

## Public API

- `makePostToolUseProvenance(towerSessionId, identity?)` — SDK/Pi PostToolUse
  hook factory. Wired in `../ai/claude-sdk.ts` and `../../engines/pi-engine.ts`.

## Before you touch this

- The output shape must stay backward-compatible with the legacy external
  `~/.claude/hooks/workspace-guard/post-tool-use.mjs` — `/commit-session` and
  other consumers parse the same fields (`sessionId`, `towerSessionId`, `tool`,
  `action`, `path`, `src?`). Schema v2 adds normalized fields but does not
  remove the legacy ones.
- Schema v2 fields: `schemaVersion`, `engineSessionId`, `cwd`, `scope`, `repo`,
  `relpath`, and optional `username`. Consumers should prefer `towerSessionId`
  and `relpath` when present, then fall back to legacy `sessionId` + `path`.
- Bash command raw text is not stored by default. Records carry
  `commandHash`/`commandPreview` only; `AUDIT_STORE_RAW_COMMAND=1` is a local
  forensic escape hatch.
- This hook **must not throw** — it would abort the AI turn. Always
  try/catch and log to console.
- File I/O is sync (`appendFileSync`). Acceptable because each call is
  microseconds and an in-flight error mid-write is easier to debug than
  a detached promise reject.

## Related decisions

- `workspace/decisions/2026-05-11-hook-parity-self-hosted-servers.md` — why this
  exists as an SDK hook rather than external `.mjs`
- `workspace/decisions/2026-05-09-tower-hooks-via-sdk-options.md` — general
  policy for new hooks
- `workspace/decisions/2026-05-03-multi-session-safety.md` — `TOWER_SESSION_ID`
  trail and `/commit-session` design
- `workspace/decisions/2026-05-01-workspace-root-guard.md` — original audit
  log purpose

## Companion

- `../workspace-guard/hook.ts` — PreToolUse mkdir / write guard. Pair: this
  records what happened; that prevents what shouldn't.
- `../inline-edit/audit.ts` — separate path that records inline-edit actions
  (backend direct call, not via AI tool). Same jsonl, different action tag.

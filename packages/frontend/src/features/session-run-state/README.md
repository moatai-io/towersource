# session-run-state

Owns the shared session-row display state for sidebar rows and chat tabs.

## Responsibility

Session execution state arrives through multiple frontend stores:

- `session-store.streamingSessions`
- `chat-store.turnStateBySession[sessionId].phase`
- unread/read attention state
- queue counts and active tool metadata

This module is the single display-policy layer that turns those raw signals into one row model: leading status, title emphasis, and elapsed-time visibility.

- `turn_terminal(outcome=completed)` is the only source of completion attention and done badges.
- `sdk_done`, `turn_done`, `session_status: idle`, and streaming false only settle activity/metrics; they never create completed attention.
- The terminal projection is ordered by root turn and terminal timestamp so stale replay cannot overwrite a newer result.

## Public API

- `turn-terminal-projection.ts` — authoritative terminal reducer; stale root-turn events are ignored.
- `session-row-state.ts` — shared row policy used by the sidebar session list and chat tabs.
- `deriveSessionRowState(input)` — returns leading status, unread title emphasis, and elapsed-time visibility.
- `isRunActivePhase(phase)` — shared predicate for phases that must render the three-dot running signal.
- `markSessionRunActive/Finished/Idle()` — small coordinated mutation wrappers for the most important runtime paths.

## Important rule

Activity and unread attention are separate planes. Running-like phases own the leading indicator while active. Unread attention still bolds the title, and once activity ends it owns the completion check. A missing read field never implies unread by itself.

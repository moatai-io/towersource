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

## Interactive question audience and attention

- AUQ payloads and attention events use user-scoped delivery to the execution recipient, not session viewers. Session read access alone does not authorize answering. Answers require the exact question ID, session ID, and recipient user ID.
- Only the originating, currently visible session renders the question popup. Background sessions retain `awaiting_user` row attention without opening a popup in another chat.
- Connection snapshots restore unanswered question IDs for that recipient. Ordinary idle/preparing events cannot erase question attention; an explicit answer, cancellation, timeout, or terminal event clears it.
- Server questions remain in-memory with a 60-minute timeout; browser reconnect recovery does not imply persistence through a server restart.
- Implementation: `packages/backend/services/session/pending-questions.ts`, `packages/backend/routes/ws-handler.ts`, `packages/frontend/src/hooks/useChatRuntime.ts`, `packages/frontend/src/components/chat/ChatPanel.tsx`.
- Regression checks: `pending-questions.test.ts`, `background-ask-user-routing.source.test.ts`, `session-run-actions.test.ts`. These are local automated checks, not deployment or live multi-browser verification.

## Chat failure presentation

The session-local error/connection surface is owned by
[`chat-feedback`](../chat-feedback/README.md). It consumes run state without
changing it; request/transport errors must not manufacture terminal outcomes or
emit generic chat failure toasts. Existing session-row attention remains here.

## Unanswered question attention

An unanswered `pendingQuestionId` keeps the phase at `awaiting_user` across generic
active/idle and late `done` edges. An explicit answer/timeout clears the question
ID; actual stop/error transitions cancel the attention. This invariant lives in
`chat-store.setTurnPhase`, including direct store callers. The optional AI Team
quick panel also consumes this phase for its recent-conversation question mark.
Regression coverage: `session-run-actions.test.ts` and
`components/agents/AITeamQuickPanel.source.test.ts`. Local tests are not live
multi-browser verification or deployment evidence.

Question clearing is shared by `session_awaiting_user`, `answer_question_ack`,
and `ask_user_timeout` through `resolveSessionQuestion`. Both session and
question ID must match; stale/missing-ID and duplicate edges are no-ops. Only
resolving the foreground session resumes its composer spinner.
`hooks/useChatRuntime.auq-events.test.tsx` drives the actual runtime event handler
and shared row indicator for stale edges, answer/clear ordering, reconnect
restoration, and background answers. This is jsdom verification, not live UI QA.

`clearMessages()` resets only the foreground transcript/popup and must preserve
`turnStateBySession`: navigation calls it while background sessions still run or
await answers. Runtime event tests cover that navigation reset sequence followed
by idle and answer events. Explicit session deletion/account resets own removal
of global run state.

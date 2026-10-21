# Chat feedback

Owns the presentation policy for chat transport/request failures. A disconnect is
not evidence that a turn failed. This module never writes transcript messages or
changes execution state.

## Contract

- `setChatConnection(connected)` receives WebSocket connectivity. Disconnects are
  shown after 1.5 seconds to avoid flashing during short restarts. Reconnect clears
  ephemeral request feedback, but does not erase confirmed run errors.
- `reportChatRequestFailure(sessionId)` records an unscoped request notice in the
  currently viewed session, not a failure attributed to its run. No active session
  or a disconnected transport produces no notice. The server currently provides
  no operation correlation on these errors; never claim a specific request failed.
- `ChatFeedback` owns surface selection, precedence and lifetime. Disconnected
  status takes precedence over errors. Confirmed `turnStateBySession` errors stay
  visible until execution state changes. Request notices disappear after eight
  seconds of viewing. Session switching cannot display another session's notice.
- Recovery uses the existing composer; there is no automatic replay or new retry
  button that could duplicate a write. Connectivity alone never means a task has
  recovered; the existing reconnect synchronization owns execution reconciliation.

Integration: `hooks/useChatRuntime.ts` reports facts, and
`components/chat/ChatPanel.tsx` renders one surface outside the transcript.

## Deep-module boundary / toast audit

`utils/toast.ts` is intentionally a thin Sonner wrapper, not an error policy.
At inspection there were 149 production `toastError` calls and additional direct
`toast.error` calls. The complexity is distributed surface/lifetime/retry choices,
not the wrapper's line count. Adding global network-message matching or suppressing
all errors in that wrapper would hide real save/upload failures.

Prefer feature-owned feedback modules receiving domain facts, not a universal
`notify(message, severity, surface, duration, retry, ...)` API that gives all policy
back to callers. Chat is the first bounded implementation. Save/upload and session
creation failures remain unchanged. Migrating those owners or adding structured
server request correlation is separate work, not part of this change.

## Validation

- `ChatFeedback.test.tsx`: delayed disconnect, reconnection cleanup, run-state
  preservation, session scoping, expiry and confirmed failure lifetime.
- `hooks/useChatRuntime.error-boundary.test.ts`: unscoped errors preserve runs;
  foreign-session frames cannot stop the active run; current-session failure has
  no toast.
- `hooks/useWebSocket.source.test.ts`: existing reconnect queue contracts.

Local tests/typecheck do not establish live upgrade verification. No deployment
or real backend restart is required by these tests.

File saves/uploads now have a separate bounded owner:
[`file-operation-feedback`](../file-operation-feedback/README.md). They do not
reuse chat run state or turn transport/request failures into execution failures.

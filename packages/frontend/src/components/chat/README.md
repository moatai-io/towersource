# Chat UI contracts

## Persisted session wait alarm

- `SessionWaitAlarmCard.tsx` is a small, right-aligned companion above the active conversation, rendered by `ChatPanel.tsx`. It shows only a pending saved alarm: reason, local resume time (semantic `time`), and hours/minutes remaining. A due alarm says it is waiting for the session to become idle; it does not imply a tool or agent is currently running. The existing wait tool/history cards remain independent.
- `useSessionWaitAlarm.ts` reads `/api/sessions/:sessionId/wait-alarm` on mount/reload, every 30 seconds while visible, after visibility restoration, and on a streaming-state change. Requests time out after 15 seconds. Timers/listeners/requests are cleaned up on session switch/unmount; late responses cannot replace the active session. Countdown state belongs to the card so it does not rerender the streamed transcript.
- The backend envelope is `{ alarm, canManage }`; alarm fields include `id`, `sessionId`, `status`, `wakeAt`, `reason`, `version`, `createdAt`, and `updatedAt`. Readable shared sessions are read-only unless the server returns `canManage: true`. `now`, `cancel`, and `reschedule` POSTs carry `{ id, version }`, plus ISO `wakeAt` for rescheduling. The server remains responsible for authorization, optimistic concurrency, persisted scheduling, and same-session admission.
- Controls are disabled while a write is pending. Polling/stream changes/hidden-tab transitions cannot abort a pending control; session switches can. Ambiguous writes, timeouts, and conflicts trigger a GET reconciliation, never an automatic POST retry. Invalid future times outside 30 days are rejected locally as well as by the server. Load failures display an explicit recovery control instead of an unverified countdown.
- `SessionWaitAlarmCard.test.tsx` covers persisted reload projection, pending/due/terminal labels, read-only ownership, versioned controls, ISO time validation, conflicts, permission loss, bounded polling/visibility cleanup, late prior-session responses, and pending-control/timeout races. Korean and English labels live in `locales/*/chat.json`. These are local component tests; browser placement, background backend admission, and restart recovery still require integration/live verification.

## Localized rich-content controls

- UI chrome in `TerminalBlock.tsx`, `MermaidBlock.tsx`, `SkillInvocationChip.tsx`, and the attachment drop overlay in `InputBox.tsx` uses the `chat` namespace. Command text, terminal output, explicit block titles, skill aliases, and technical format names remain source data; localization must not rewrite them.
- New controls have Korean `defaultValue` text and matching `ko`/`en` resource entries are required before integration. Fallbacks are recovery text, not a substitute for the English resource catalog.
- `TerminalBlock.locale.test.tsx` exercises Korean fallback labels while preserving command/custom-title data. `../common/MajorSurfaces.locale.source.test.ts` guards translated controls across editor, viewer, snapshots, summaries, helper-agent details, usage, and work timeline. Existing Mermaid tests protect rendering and chunk recovery; they do not establish live-browser layout verification.

## In-turn sleep tool

- `ToolUseCard.tsx` and its `ToolChip` render `sleep` (including SDK/MCP aliases such as `mcp__sleep__sleep`) with a static clock and localized Waiting/Wait complete states. They do not reuse the thinking dots or spinning activity glyph for waits.
- `durationSeconds` is displayed as the requested **expected wait**, not remaining time. `reason` stays user/model source text. No client countdown is inferred from the enclosing turn start time, and no wake-now button is exposed without a backend wake API.
- Active expanded cards explain that the existing response Stop control cancels the wait. Structured cancelled/error results and plain abort/error output must not be shown as successful completion. Historical unresolved tools must not claim to be running.
- `message-parser.ts` owns localized sleep labels, summaries, and activity names. Matching Korean/English resources live in `locales/*/chat.json`. `ToolUseCard.test.tsx` and `message-parser.language.test.ts` cover live/completed/cancelled/error/history states, aliases, static duration, clock, and language behavior; these are local component tests, not a live-browser or full backend cancellation verification.

## Composer width

- `ChatPanel.tsx` caps the input dock, message rows, and awaiting-user notice at 1080px on wide screens while keeping the existing mobile padding and full-width behavior. `InputBox.tsx` gives the textarea the remaining flex width, so widening the dock also widens the actual typing area; the textarea's internal padding is unchanged.

## Question navigation

- Previous/next user-message arrows sit in a narrow rail vertically centered on the conversation viewport (excluding the composer and turn notices), not the full chat panel. The existing keyboard shortcuts and scroll targets remain unchanged. The arrows only appear when a navigation target exists.
- The attachment button stays to the left of the textarea. On desktop its outer margin is removed and row gap reduced while keeping a roughly 38px button target; the textarea receives the recovered horizontal space.

## Composer status line

- `ChatPanel.tsx` renders `ActiveTurnStatusPill` above the composer for every live turn, not only `awaiting_user`. It restores the existing phase label, Tower mark, and server-adjusted elapsed timer so activity remains visible while reading history. Elapsed time uses whole seconds and is hidden while awaiting user input.
- Keep the live timer outside the virtualized message list to avoid scroll remeasurement. Its clock follows the mounted live-turn notice and must not reset merely because token streaming pauses during preparation or tools.
- `StatusLine.tsx` below the composer retains model/context information and the latest completed assistant duration when idle. It must not duplicate the live timer or show old duration during an active turn. Persisted `durationMs` takes precedence over fresh in-memory metrics for the matching recent message.
- Do not insert a synthetic empty assistant row with three dots after the latest user message. The above-composer status owns pending activity; actual assistant messages, tool content, questions, and errors retain their existing rendering.
- Stopped-turn notices remain above the composer; progress commentary remains in the conversation.
- `StatusLine.test.tsx` and `ChatPanel.active-turn-status.source.test.ts` cover timer ownership and active/idle rendering contracts. Actual narrow-viewport geometry requires separate browser verification.

## Floating AskUserQuestion card

- `ChatPanel.tsx` bounds the expanded question wrapper with an explicit `h-full` within the inset chat layer, capped at 44rem. The card's `max-h-full` must resolve against this definite height; a wrapper with only `max-height` does not provide a reliable percentage-height constraint. Mobile vertical padding is 12px rather than the desktop reserve.
- `FloatingQuestionCard.tsx` owns one vertical scroll body containing the question, options, Other button, and custom input. Do not add a second capped, overscroll-contained list: it traps touch scrolling before the custom input outside that list can be reached.
- The action footer stays outside the scroll body and does not shrink. Custom input keeps a 44px minimum height and uses 16px mobile text to avoid iOS focus zoom.
- Opening Other reveals its input row. A visual viewport resize reveals the currently focused input again after keyboard-driven layout changes. Listener and animation-frame cleanup are required.

### Verification

- `FloatingQuestionCard.test.tsx`: input, submission, single-scroll structure, focus and viewport-resize behavior.
- `FloatingQuestionCard.layout.source.test.ts`: containing-block height and mobile padding regression guards.
- `FloatingQuestionCard.locale.source.test.ts`: localization guards.

These automated tests check structure and event handling, not actual browser geometry. Real-device iOS Safari/Android keyboard and touch-scroll verification remains separate from unit-test results.

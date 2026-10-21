# Session welcome

## Current contract

Every ordinary empty ChatPanel shows the Primary Agent's `AgentIdentityAvatar`, explicit profile display name, one polite work question, 2–3 dialogue answers, and a free-input hint. A legacy Project without a profile uses a neutral localized name; its Project name is not an invented persona. The old first-Project-only task screen and orbit splash are replaced, while the beginner tour and `/tower-intro` chat guide remain available.

`ChatPanel` enables `useSessionWelcome` only after the active session's messages have loaded, with no visible messages and no streaming turn. Initial-preparation interview sessions that already contain real messages remain normal conversations. This feature is not the separate [initial preparation interview](../../../../../docs/architecture/agent-initial-preparation.md).

- The complete ko/en static welcome renders immediately, without a spinner or provider dependency. The UI currently supports ko/en; unsupported installation language identifiers are already normalized to English by the existing locale loader. The API also accepts ja/zh, but that does not introduce unsupported frontend locale bundles.
- `POST /api/session-welcome` receives `{ projectId, sessionId, locale }` and cookie authentication. The response is display data `{ contextLine, question, choices: [{ label, message }] }`, never hidden instructions or trusted metadata. Context/question/label/message are bounded to 900/160/40/240 characters, with 2–3 choices.
- A result replaces the static content only before interaction. Actual `InputBox` focus, typing, clicks, pointer actions, and restored non-empty drafts freeze pending personalization. Welcome answers and guide actions do likewise. A 2500 ms client ceiling, API errors, and malformed results retain the static fallback.
- Session/Project/locale changes, disabling the welcome, and unmount abort the request. A disposed/request-identity guard rejects late responses even when a fetch implementation ignores abort. API content from the previous scope is never rendered in the new scope.
- Clicking an answer sends its `message` through the ordinary `ChatPanel.onSend` path. No client-authored hidden context, `SendOptions`, fake assistant message or new WebSocket frame is added. The backend separately retains a bounded opening snapshot and revalidates it in the common system-prompt builder for conversation continuity; see the backend contract. `useChatRuntime.ts` remains unchanged.
- The backend owns access, audience, private continuity, utility model selection, and cache isolation: [service](../../../../backend/services/welcome/session-welcome.ts), [route](../../../../backend/routes/session-welcome-api.ts).

The first real model reply uses the existing first-turn memory pipeline and the system prompt's **Work-focused curiosity**, not trusted welcome output. The prompt asks one easy work question at a time, provides useful help along the way, and does not delay a clear delegated task with an interview. See [code map](../../../../../docs/architecture/code-map.md) and [system prompt](../../../../backend/services/system-prompt.ts).

## Evidence and validation

- `SessionWelcome.test.tsx`: immediate fallback/identity, English copy, real message selection, tour/chat guide, late click result, session/Project abort, disabled fetching, timeout, malformed response.
- `../../components/chat/InputBox.test.tsx`: actual composer focus/edit/click reject pending personalization; restoring a saved draft prevents a welcome request.
- `../../components/chat/ChatPanel.first-day-empty-state.source.test.ts`: integration wiring/empty-only guard and locale guide regression checks. Behavior tests above complement, rather than replace, these source checks.

Executed local validation: these tests plus existing InputBox attachment/mobile/stop/upload and locale-integrity tests; frontend TypeScript check. Existing InputBox tests emit asynchronous React `act` warnings and include 9 existing skips. No deployment, live provider/UI validation, or claim of complete memory is implied.

Live synthetic-input probe: the configured utility model returned in 5.8s and 2.5s (two samples, not a percentile). The welcome budget is therefore 6s server / 6.5s client; the static UI remains immediate and interaction freezes it. Completed ledger records require explicit recorded-status wording. No real customer data was sent in this probe.

The recap is now a short colleague briefing, with up to 900 characters and larger line height. The API schema is unchanged; questions and choices retain their existing limits.

## Preparing indicator
While the welcome request is pending, show a polite live status with a reduced-motion-aware pulse and reassure users they can start immediately. Composer and choices remain usable. Clear the status on success, rejection, malformed response, timeout or user interaction; no additional inference calls are introduced.

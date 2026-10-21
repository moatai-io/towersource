# Secretariat — private proactive proposal inbox

## Ownership and accepted scope

This frontend feature presents the account-owned **비서실** (Secretariat), using the existing Tower personal menu, theme tokens, app view router and source-session navigation. Product direction: [`docs/decisions/secretariat-proactive-assistant-direction.md`](../../../../../docs/decisions/secretariat-proactive-assistant-direction.md).

The UI describes the feature as “진행 중인 일을 챙기고, 필요한 확인과 다음 작업을 먼저 제안합니다.” It does not generate proposals, schedule AI calls, send external notifications, execute work, or approve new work. Opt-in is explicit; absent/loading settings render off with the switch disabled. Disabled users can still read existing proposals.

## Navigation and privacy contract

- `Header.tsx` exposes `global-nav-secretariat` in the existing personal menu to signed-in admin/operator/member roles, not guest/viewer roles. `App.tsx` clears directory/system-tab conflicts and closes the sidebar when this entry is selected.
- `ActiveView = 'secretariat'` and `?view=secretariat` make the surface available in both desktop and mobile `AppContentRouter` composition.
- The panel is keyed by the active authentication identity (`token`) so switching accounts cannot retain another account's proposals. Pending fetches/mutations are cancelled on unmount and ignored after cancellation. This frontend defense does not replace backend account ACL enforcement.
- Source links retain `/s/<sessionId>` hrefs and dispatch the existing `kanban-select-session` event for ordinary clicks; modifier clicks keep normal browser behavior. No new source-session resolver exists here.

## Account API contract

`secretariat-api.ts` uses `VITE_API_URL || ''`, existing Bearer auth from local storage, and AbortSignal. GET responses are validated without truthy coercion.

- `GET /api/secretariat` returns `{ enabled: boolean, pausedReason: string | null, proposals: [{ id, title, body, createdAt, readAt, sessionId, projectId }] }`. `readAt`, `sessionId` and `projectId` are nullable strings; title/body/date/id are strings.
- `PATCH /api/secretariat` sends only `{ enabled: boolean }`.
- `POST /api/secretariat/proposals/:id/read` sends no settings/body fields and URL-encodes the proposal ID.
- Both mutations accept an empty successful response and then GET the authoritative account state. Settings/read receipts are not optimistically fabricated. A failed mutation preserves prior state and offers explicit retry. A successful mutation followed by failed refresh reports a load error instead of claiming a new state.

## Read and pause contract

List rendering, menu entry, source navigation and refreshing do **not** create read receipts. Proposal bodies are collapsed by default. An explicitly expanded body is marked read once it intersects the viewport and the document is visible (visibility-only fallback where IntersectionObserver is unavailable). Different bodies have independent read guards. Already-read bodies create no receipt. Closing the body disconnects observers.

Unread proposals explain that periodic AI checks are paused. All read/paused transitions use the returned server state; the UI owns no scheduling/resume timer. Generic server pause reasons are not rendered as technical strings. The user can opt out even while unread proposals are paused. Failed receipts keep the body readable, explain the retained pause, and offer retry.

Bodies are intentionally inert, whitespace-preserving text, **not** rich executable visual blocks/embedded HTML/remote images. Loading, empty, load error, toggle error, read error, retry and manual refresh states are exposed. Switch and accordion controls are keyboard-focusable and labelled with ARIA state. KO/EN text lives in the owning `layout` locale namespace.

## Evidence and limits

- `SecretariatPanel.test.tsx`: UI lifecycle, default-off/auth, body-only read, viewport/visibility guards, multiple proposals, pause/resume, toggle/read/load failure retries, source navigation, inert text, cancellation.
- `secretariat-api.test.ts`: response validation, nullable identifiers, HTTP errors, URL encoding, empty mutation responses, configured API origin/cancellation.
- `secretariat-navigation.source.test.ts`: personal-menu entry, conflicting-surface cleanup, desktop/mobile identity keys, actual existing session event contract.
- Existing owners: `AppContentRouter.test.tsx`, `hooks/useUrlSync.test.ts` protect routing and refreshable URL behavior.
- [`e2e/secretariat.authenticated.spec.ts`](../../../../../e2e/secretariat.authenticated.spec.ts) uses authenticated read-only fixture routes and a synthetic secretariat API. At 1280px and 390px it covers real personal-menu entry, off/on/off, no list read receipt, body-only read, pause clearing, zero horizontal overflow and source-session navigation.

Executed locally: targeted Vitest tests, frontend TypeScript, the two Chromium fixture flows and vendored design lint. No external AI/provider call, backend modification, deployment or live account/scheduler verification is performed by this frontend work. Synthetic browser API responses are **not** proof that the deployed backend or periodic generation is enabled.


## Hourly popup follow-up

The opt-in check interval is now one hour. A large app-level popup is shown only while the page is visible, no other semantic dialog or legacy full-screen overlay exists, no input is focused, and no session is streaming. The UI polls stored proposals once per minute; polling never invokes a model. Other dialogs take priority.

Migration 239 adds `shown_at`, separate from `read_at`. An owner-scoped atomic `POST /api/secretariat/proposals/:id/respond` with `show` claims automatic presentation once across tabs. Closing never acknowledges; unread continues blocking generation. `skip` acknowledges and enforces at least an hour before another attempt. `today` acknowledges and defers for 24 hours, explicitly labelled “24시간 쉬기” rather than an ambiguous midnight boundary. No external delivery or automatic work execution is added. Reloading between a presentation claim and rendering can suppress that popup, but the proposal remains in the inbox (at-most-once presentation).

Local follow-up verification includes popup component tests, owner/parallel presentation claims in temporary PostgreSQL, and TypeScript checks. Production migration/provider calls/deployment have not been performed.


## Contextual notes follow-up

Lite now reads up to 12 recent active user/assistant messages from the selected owner-scoped source session (up to 1,000 characters each). Tool results, thinking and hidden blocks are excluded; malformed truncated structured content is omitted. Source access and work freshness are checked before and after loading context. Secret-pattern messages are withheld from the model. Conversation is untrusted evidence, not executable instructions.

The note may be an observation, options, a briefing or a question. No mandatory question ending or 2–4 sentence template remains. Output is capped at 1,500 tokens / 4,000 body characters, not a target length. Jev still selects a bounded candidate/direction without receiving the transcript. Popup notes above 600 characters initially show a short opening excerpt and expand on demand. Close and rest controls remain outside the scrollable detail area. No additional model call is used to summarize.

Verification: context privacy extraction, extended note parsing, message forwarding and long-note expansion unit tests; provider live quality remains unverified. No deployment or paid inference was performed.


## Navigation and live readiness correction

Desktop Secretariat navigation now preserves the sidebar; mobile closes only its drawer. The existing selected session is retained. Model readiness forwards the current LiteLLM catalog timestamp rather than rejecting catalog-backed models. Hourly occurrence deduplication uses 3,600 seconds (not the previous 21,600), and an existing occurrence prevents a claim from advancing settings without recording a run.

A user-authorized single-account manual check on the corrected local service returned `skipped`, and bounded Jev selection returned no accepted candidate. No proposal was fabricated, no unread/rate/access protection was bypassed, and these source changes are not a production deployment.


Revision 4: `delivery=inbox` notes appear only in the existing inbox and do not trigger automatic popup claims. Unread still pauses further AI calls. Missing delivery is treated as legacy popup for backward compatibility. Migration 241 and backend changes are required for new classification.


## Participating sessions scope

Candidate discovery now starts from at most ten recently active sessions across Projects where the user is currently a member, rather than running Work Ledger items. Participation means session ownership or a server-attributed user message matching the current account username. Username changes may exclude historical participation; no inference from display names or mere viewing is made. Shared/channel sessions still pass the current session ACL before any content is read. Administrator read exceptions alone do not admit candidates. Archived Projects/sessions, child sessions and registered helper backing sessions are excluded. Order is latest active top-level user/assistant message time, not metadata modification time. Already-proposed unchanged sources are excluded; subsequent ACL rejection can yield fewer than ten candidates.

Each Project connection must pass readiness before its bounded two-message preview enters selection. Lite uses the selected Project's connection. Source freshness uses the conversation timestamp, not a Work Ledger status. The current inbox and automatic checks use this scope. The requested manual “비서 브리핑” button is not implemented by this change.

Validation includes isolated PostgreSQL participation, helper exclusion, membership revocation, ten-candidate cap and ordering tests. No live inference, notification, production schema changes or deployment were performed.


## On-demand briefing and workspace-preserving dialog

The menu opens an overlay without changing activeView, selected session, sidebar or URL. Close, Escape and backdrop dismiss it and restore focus. Explicit source navigation closes the overlay. Legacy page links remain compatible.

`POST /api/secretariat/briefing` accepts no scope arguments and uses authenticated identity. It returns an existing unread proposal first; otherwise it runs one manual inspection without changing opt-in or the scheduled due time. Manual claims share the existing lease, require active identity, enforce a rolling one-minute retry guard and unread/access checks, and use separate occurrence keys. Manual output is inbox-only and expanded in the requesting UI, not automatically popped up. Closing cancels the UI request; a server call already underway may finish and save to the inbox. No automatic work execution occurs. Busy/no-proposal outcomes currently share a cautious UI status rather than claiming there is certainly no useful work.

Local tests cover manual execution while OFF, unchanged opt-in, shared lease and repeat suppression, API identity binding, dialog close/focus, and desktop/mobile browser navigation. Production/provider verification has not been performed.


### Authenticated entry regression

Dialog and automatic popup identity keys use the current decoded authentication token userId, not the legacy localStorage userId cache. Valid sessions restored without that cache must still open the dialog. Server APIs remain the authority for authorization; this is a rendering fix, not an access grant. The authenticated browser suite covers missing legacy storage and close behavior.


### Secretariat identity

A shared SecretariatFace component uses the existing core-talent portrait as the default UI face for the personal secretariat, independent of Project Agent profiles. The persistent header face shortcut was removed at user request. The existing app-menu entry remains; the inbox dialog and proposal popup retain the face. This is a UI identity, not a new Agent or an individualized profile setting. Input focus still defers automatic popups; explicitly opening the secretariat is not deferred.


## Personal conversational prototype

Migration 245 adds account-owned chat rows with source Project/session provenance and a per-user inference lease. /chat GET/POST uses authenticated ownership, current Project membership and source-session access checks. The tool-less Lite responder reads authorized recent private dialogue and proposals from the selected Project; it cannot delegate, execute work or change schedules. Project-derived replies become hidden after source access revocation. No chat exists until a usable authorized source and provider connection exist. Replies are bounded non-streaming completions. Closing does not cancel already-started provider work.

The UI shows incoming proposals beside personal dialogue and refreshes proposals while visible. This is a first conversational prototype, not the complete coordinator: no delegated execution, natural-language scheduling/completion extraction, streaming or semantic proposal deduplication. Explicit existing pause/read controls remain authoritative. Live provider checks and migration application are not performed.


## Stable conversation subject

Migration 246 allows an owner-only general conversation with no source binding. Requests optionally select a current authorized proposal ID, explicitly select general via null, or continue the last visible conversation by omission. New proposals do not automatically change the subject. Histories passed to the model are restricted to the selected source session, not simply any conversation in its Project. General chat uses Lite readiness without requiring a Jev gateway connection. Source-bound history remains filtered by current access; access revocation can remove previous context. Same-transaction user/assistant rows sort user first for continuity.

This change addresses subject continuity only. Natural-language deferral/completion persistence and live end-to-end paid inference remain outstanding; no false claim of scheduling or work execution is permitted. Backend regression tests pass; repository typecheck is blocked by an unrelated FileTabBar.tsx prop typing error in the current shared worktree.


## Personal session entry and modal (migration 247)

A unique owner-private `personal_secretary` session provides a stable identity in Recent Sessions. Menu and Recent Sessions open the same overlay without replacing the underlying workspace. The session is created on authorized first chat access or first automatic proposal, and activity advances on replies/proposals. Header face shortcut remains removed. This is not an unrestricted ordinary tool-using session: generic send is denied and chat uses the dedicated bounded Lite endpoint.

Messages remain in source-aware secretary storage; standard getMessages/getMessagesPaginated use an authorized read-time projection for this session label rather than duplicating source-protected content. Current Project membership and source-session ACL are applied; private session reads reject nonowners including admin read exceptions. Fix: chat now inspects accessResult.allowed (a denied result object is truthy). Existing chat rows remain owner/source-bound even if their new conversation_id is unset. General/session content is not migrated destructively.

Limitations: projection currently covers the bounded chat/inbox window, not full historical pagination; broad search/export paths that query raw messages do not automatically gain this projection. Ordinary execution tools and automatic full session-context compaction are not enabled. Legacy proposal controls remain in the panel as well as the chronological chat feed. Recent-session live unread push is not added; normal list refresh discovers activity.

Validated by secretary tests, common message-store/access regression tests, full typecheck, and desktop/mobile existing browser flows. Recent-session routing has a source regression test; full live database/browser routing requires deployment plus migration 247 and has not been verified here. No production migration, paid call, commit or deployment was performed.


## Continuous Core conversation correction

Chat now uses preset/core (automatic proposal writing remains Lite). Topic selection is removed: all currently authorized history/proposals form one chronological context, bounded to forty items/60,000 characters without per-message slicing. Standard MessageBubble renders the feed. Legacy read/source controls are collapsed. This remains a bounded quickReply path, NOT the standard persistent engine runtime: no full-history compaction, streaming, or tools yet. Long-term recall beyond the bounded window is not promised.

Migration 248 stores transitive source_refs for mixed-source replies so membership/session revocation hides derived content too. Current sources are rechecked before saving. Existing rows retain their previous direct source protection. No production migration, paid inference or deployment performed.


## Native conversation runtime (migration 249)

Secretary reply execution now calls the existing Pi engine.run with preset/core and an engine session path persisted per owner. First use or an external-source fingerprint change rehydrates authorized transcript into the native session file; unchanged evidence reuses that file and its SDK-native compaction. A dedicated server-only secretaryConversation flag disables tool assembly without abusing interview mode or granting host access. Failed engine turns invalidate the resume pointer. A five-minute inference lease replaces the old short quickReply lease.

Important remaining integration gaps: HTTP currently returns a completed reply (native streaming events are not forwarded to the popup); callback metrics/compact boundaries are not yet persisted through standard message callbacks; full generic WebSocket stop/steer is not wired to this UI. Engine execution/compaction is reused, but the normal ws-handler turn lifecycle is not wholly reused. Do not report this as complete standard-session parity. Live paid compaction/restart behavior remains unverified. Sources are rechecked before saving; no deployment, migration application or commit performed.


### Native streaming follow-up

POST /chat/stream forwards native assistant snapshots and compact phases over NDJSON and emits done only after authorized persistence. The UI renders streaming content with MessageBubble, supports Stop via request cancellation, and aborts when unmounted. Disconnect aborts the native engine; failed/stopped turns invalidate resume state. A token-checked heartbeat extends the inference lease during long runs. No steering endpoint or shared ws-handler turn telemetry is claimed. SDK compaction uses the native session path; actual paid long-context/restart testing remains outstanding.


## Conversation-first layout

The dialog keeps its identity header and composer fixed while only the conversation viewport scrolls. The duplicate proposal list has been removed. Opt-in and policy live in a header settings disclosure. Briefing is a composer action; its status/result is displayed in the feed. Source links sit on proposal messages. Proposal end markers, observed within the conversation viewport, acknowledge long messages after their end becomes visible in an active document. Scrolling history suppresses automatic follow and offers a new-message jump; sending follows the new reply. Complete native send/stop behavior remains unchanged.

Validation: 33 frontend unit tests, full type/theme checks, five Chromium desktop/mobile fixture flows; mobile screenshot inspected. The old panel tests for removed accordion behavior were replaced with single-feed/settings/briefing orchestration tests. This is not live model quality validation.

Follow-up: repeated polling with unchanged content does not trigger a new-message indicator. Its floating button tracks the actual composer height via ResizeObserver, including browser textarea resize. End-marker reads are retried on visibility restoration, not only on intersection events. No backend or model behavior changes.

### Reopen request recovery

The browser keeps only the last unresolved UUID in sessionStorage scoped by authenticated userId, not prompt/reply text. Reopening checks owner-only request state; completed results replace the feed, terminal failures release the send gate, and unknown/running states block new sends while offering “결과 확인”. No inference is automatically replayed. Browser storage access and stale unknown-state resolution require further hardening; there is intentionally no unsafe “retry anyway” path. This does not add scroll-position persistence or live proposal-quality validation.

# Session welcome: lightweight first-screen contract

This module owns `POST /api/session-welcome`, registered in
[`routes/api.ts`](../../routes/api.ts) behind the existing authentication middleware.
It is an optional, stateless conversation opening, not a Session execution, task
result, Work Ledger record, or permission grant.

## Request and response

The request is a strict JSON object; caller-supplied user/role/context fields are rejected:

```json
{ "projectId": "44444444-4444-4444-8444-444444444444", "sessionId": "55555555-5555-4555-8555-555555555555", "locale": "ko-KR" }
```

Both IDs must be UUIDs. Locale normalizes to `ko`, `en`, `ja`, or `zh`; other valid
language codes use English fallback. Responses have `Cache-Control: no-store`:

```json
{
  "contextLine": "최근에 ‘견적 구조’ 내용을 다뤘습니다.",
  "question": "견적을 지금 어떤 기준으로 살펴보고 싶으세요?",
  "choices": [
    { "label": "견적 기준을 정리하고 싶어요.", "message": "견적을 비교할 기준부터 정리하고 싶어요." },
    { "label": "새로운 일을 이야기하고 싶어요.", "message": "새로운 일을 설명할게요." }
  ]
}
```

`contextLine` may be empty. There are 2–3 choices. Character limits are 900 / 160 /
40 / 240 for context line / question / label / message. Strict plain-text validation
rejects markup, control characters, unexpected fields and duplicate labels. The
model generates a grounded recap from authorized summaries and recorded work states.
It must distinguish recorded completion from goals and historical questions. This semantic
contract is evaluated separately from shape validation; the validator cannot prove truth.

HTTP 400 means invalid input; 401 means missing authenticated identity; 403 means
current content access or ownership was denied; 404 means no target session;
503 means an authority/storage check could not complete safely. Generation failure,
invalid model output, disabled model, no eligible summaries, timeout or overload
returns HTTP 200 with a context-free localized static opening. Clients should show
their static opening immediately and retain it on any failure.

## Authority and continuity boundaries

- Use the authenticated actor, current active Project membership,
  [`canAccessSession` / `canSendSessionMessage`](../pm/project-access.ts), target
  ownership, and exact target Project match before reading summaries or cache.
- Empty private or Project-visible, unarchived, non-room owner sessions are personalized.
  Explicitly shared (including previously shared), Agent/room and already started sessions use static fallback. Read-only actors cannot steer Sessions.
- Read at most ten same-user/same-Project unarchived sources, updated
  within 30 days, excluding the target and any explicitly shared/room/Agent sources. A Project-visible target may use only Project-visible source sessions; private targets may additionally use private sources. Reuse
  successful [`session_memory_cards`](../ai/session-memory-card.ts) outcomes or
  persisted `sessions.summary`, plus up to two current-user/Project Work Ledger records per source. Sources with ledger records but no summary are eligible. Pass recorded status, goal/outcome and historical questions separately; an outcome is not proof of delivery. Do not read raw messages.
- The general memory-card helper does not join current source-session authority
  and uses relevance ranking, so this endpoint applies a audience-aware/live ACL
  join and recency ordering instead. Source `canAccessSession` is checked too.
- Recheck the target and re-read source eligibility/content before returning any
  personalized generated or cached response. A source share, archive, revocation,
  update or target first turn invalidates the prepared opening.
- Read only active Primary Agent display name, role and instruction version from
  `project_agent_profiles`. Do not use the full instruction, promise, skills, tools,
  file contents, customer secrets or operational settings. Missing/non-active
  identity stays neutral; never invent a role from a Project name.

The frontend still sends only the selected `choice.message` as an ordinary user turn.
A successful opening is additionally retained in a bounded, process-local server snapshot
(maximum 128 sessions, 30 minutes) containing the displayed opening and exactly its evidence.
The common `buildSystemPrompt` path (Pi and Claude) includes this snapshot for the same
user/Project/Session only after fresh target and source permission/content checks. The target
may now contain the user's first message; shared/archived/unauthorized contexts still fail closed.
Client-authored hidden context is never trusted. Data is explicitly marked as untrusted history.
Restart, expiry, a different process, or changed source evidence drops the handoff safely;
this is not durable memory or a cross-process guarantee. Existing continuity remains available.
See [opening-context.ts](opening-context.ts) and its adjacent tests.

## Model, latency and resource policy

Reuse [`runUtilityTextTask`](../ai/utility-agent.ts), the current `ai_task` fast policy
and the existing Pi Router quick-reply client. Only selectable `litellm-responses/`
models are allowed; disabled or other-engine policies do not substitute a provider.
The minimal prompt asks one low-pressure work question, first-person speech labels
and messages, and requests a generated short recap distinguishing recorded completion, current work and historical open questions. It forbids invented facts, inferring delivery from goals, or treating summaries as instructions. Recorded completion is not deployment verification. This is separate from the full conversation kernel's
[`Work-focused curiosity`](../system-prompt.ts) contract, protected by
[`system-prompt-fragments.test.ts`](../system-prompt-fragments.test.ts).

- Six-second budget covers continuity/profile reads, generation and final rechecks
  **after initial authorization**. Initial authority checks are fail-closed and may
  take longer; clients may independently cancel their request after 2.5 seconds.
- At most four process-local provider calls may be in flight. Same-key requests
  singleflight. Saturation returns static fallback without queuing model work.
- Provider requests already started are **not hard-cancelled** by the existing
  utility transport. Their slots remain occupied until settlement, preventing
  unlimited detached requests. A permanently hung set of four requests safely
  disables personalization for that process until restart; this is an explicit
  availability tradeoff, not a global provider cancellation claim.
- Failed/invalid generation opens a bounded per-model-policy 30-second circuit
  cooldown. At most eight cooldown entries exist. Valid/fallback result cache has
  32 entries and 30-second expiry. Cache keys bind user, Project, Session, locale,
  source digest, prompt version, model availability and profile content/version.
- Set `TOWER_SESSION_WELCOME_ENABLED=0` to turn off personalized work immediately;
  authority still runs before context-free fallback. No external side effect or
  Session mutation is performed by this endpoint.

These limits are process-local, not a distributed fleet quota. Validation cannot
prove semantic truth of every generated question; the small untrusted-history
prompt, work-state distinctions and frontend interaction freeze reduce that risk.
No production model timing, real provider availability or deployment is claimed.

## Verification

```bash
npx vitest run packages/backend/services/welcome/session-welcome.test.ts packages/backend/routes/session-welcome-api.test.ts
npm run typecheck
```

Tests cover strict request/response, locale fallback, live authority before cache,
private audiences, source recheck, three-source/30-day SQL bounds, cache isolation,
expiry/cap, four detached-call cap, timeout, disabled models, profile version,
kill switch, failure cooldown and HTTP error sanitization. Tests mock persistence
and inference; live PostgreSQL/provider/browser verification is separate.

## Work-aware opening verification
The v2 prompt generates the recap rather than forcing a title-only line. Tests verify work-state
and question evidence in the prompt, generated recap preservation, server handoff, principal
isolation and revocation/error fallback. Schema validation cannot prove generated semantic
accuracy: actual provider latency and groundedness require live evaluation. No live inference
or production deployment is claimed by these unit tests.

Live synthetic-input probe: the configured utility model returned in 5.8s and 2.5s (two samples, not a percentile). The welcome budget is therefore 6s server / 6.5s client; the static UI remains immediate and interaction freezes it. Completed ledger records require explicit recorded-status wording. No real customer data was sent in this probe.

## Recognition and suggestions
The input additionally includes at most two current-user/current-Project automations,
including enabled state, last recorded status and run timestamps. This metadata is
Project-visible under `task/automation-manager.ts` membership scoping; bounded task text is minimized by `safeAutomationContext`; error text and execution output bodies are never selected. Automation-only evidence is eligible.
Recap recent work first, then propose at most one grounded continuation or improvement;
do not force advice or infer repetition from one record. An enabled job is not a successful
run and a successful run is not proof of usefulness. This is current-Project personalization,
not an all-Project personal dashboard. Cross-Project suggestions remain out of scope.
Regression tests cover Project targets excluding private sources and automation-only input.

## Colleague briefing and automation intent
The v4 opening permits a 900-character recap (usually 3–5 coherent sentences),
with 2–3 supported topics and a reasoned next step. Account display name may be
used once without inventing a nickname. Inputs now include bounded automation
purpose, task instructions and schedule metadata. Task text is untrusted data,
not executable instructions. `safeAutomationContext` omits entire fields with
common credential/contact signals and strips links/markup. This is conservative
heuristic minimization, not a guarantee of detecting all sensitive content.
Raw run results/error bodies and cross-Project/personal chat are NOT included.

No automatic modification of automations is authorized by an opening suggestion.

### Expanded history budget
Read the latest 10 eligible sessions updated within 30 days, with up to 2,000 characters of persisted summary per session. Keep two automation items separately (12 evidence items total). The generator and final revalidation use the same 12-item limit. This does not fetch raw conversation or expand short stored summaries. Session summary text alone may reach 20,000 characters; attached work records and automation context add to that amount. Measure latency against the existing six-second budget.

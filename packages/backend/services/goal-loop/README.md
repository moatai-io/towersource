# Goal loop prototype

## Scope

`goal-loop.ts` is an engine-neutral, sequential Inspect → Change → Check runner with an actual bounded code loop. It is **not registered as a Tower tool and not connected to the production engine**. A successful prototype test does not mean `/goal` now runs through this module.

The runner owns cycle counts, phase ordering, two-cycle stagnation detection, strategy-change requirements, stop decisions, and current-revision evidence requirements. Injected callbacks own domain inspection, authorized changes, checks, and persistence. Evidence references are adapter attestations, not proof of independent verification.

## Integration design

Keep goal completion separate from agent-turn transport recovery. A model invocation ending normally does not imply goal completion. Existing agent-turn fencing and side-effect protections must remain authoritative for real execution.

Before exposing `goal_start`, `goal_step`, `goal_status`, or `goal_finish`:

1. Add runtime argument schemas, closure-scoped user/project/session ownership, persistent storage, versioned compare-and-swap and idempotency keys. The prototype TypeScript types are not an API validator.
2. Bind model steps to existing turn claims. Do not introduce a second owner that bypasses recovery or uncertain-side-effect handling.
3. Implement approval/cancellation propagation and bounded adapter execution. AbortSignal is cooperative; do not replay callbacks that have not confirmed termination.
4. Persist command intent and receipts atomically where possible. Reconcile interrupted change/check phases rather than calling `runGoal` on an old running record. The prototype explicitly rejects that replay.
5. Register the tool behind an opt-in capability, connect continuation after normal model completion, and add integration tests proving no auto-resume during approval wait, user stop, superseding user message, or uncertain external effects.
6. Expose actual state to the user and link `/goal` only after end-to-end verification. No production migration, service restart, or deployment is part of this prototype.

## Verification

`npx --no-install vitest run packages/backend/services/goal-loop/goal-loop.test.ts`

The 15 unit cases verify two actual iterations, approval stop, stagnation handling, strategy-switch failure, stale evidence, budget exhaustion, uncertain-change stop, cancellation, persistence failure, verify-only completion, interrupted-state replay rejection, and invalid budgets. Callbacks are fixtures, not live models. Real persistence, multi-owner fencing, router/API schemas, and model continuation remain unimplemented.

## Command and storage prototype

`goal-session.ts` adds strict Zod commands, closure-bound ownership, expected-version checks, idempotency conflict detection, bounded receipts, and ordered phase transitions. `goal-store.ts` supplies a PostgreSQL transaction adapter that rechecks session ownership and project membership and locks the parent session before first insertion. It is deliberately not registered or invoked by production code.

`schema.sql` is a draft outside the automatic migration directory; it has not been applied. No live database persistence or locking claim has been verified. Tests now total 23: runner fixtures, session command tests, and two mocked PostgreSQL contract tests. Mock tests do not establish real SQL validity, concurrent transaction behavior, or permission revocation race safety.

The session command transition implementation and callback runner currently duplicate policy; consolidate them before production wiring to avoid drift. Other blockers include read-only status, server-side evidence validation, current-root-turn/stop fencing, timeout enforcement, paused-goal approval resumption, and tool/engine registration. A passing model-provided evidence reference is not independent verification. These prototypes must not be advertised as a working `/goal` runtime yet.

## Shared transition and continuation driver

`goal-transition.ts` now owns phase/cycle/completion/stagnation policy for both the callback runner and session commands. Inspect attempts count toward the budget even when strategy-change enforcement stops them.

`goal-continuation.ts` adds a real bounded dispatch loop after normal model completion. Host-observed stop, approval wait, owner loss, superseding root turn, uncertain side effects, or failed invocation prevent dispatch. No state progress after an invocation stops rather than repeatedly prompting an uncooperative model. Dispatch must atomically recheck these conditions and fence the expected version; a preliminary policy check alone is not race-safe.

33 tests pass across four files, including two actual fixture dispatches to goal completion and stop/approval/ownership/supersession cases. The driver is still not connected to PiEngine. No live model continuation, durable DB integration, production capability registration, or rollout has occurred. These remain required before advertising `/goal` as code-driven in Tower.

## Pi tool factory (not activated)

`engines/pi-goal-tool.ts` exposes an unregistered `createGoalTools` factory for `goal_step` and read-only `goal_status`. Both use strict model input schemas and closure-bound scope. Tool output omits ownership and idempotency receipts. Every call requires a host authorization adapter, and every check additionally requires a trusted receipt verifier; no permissive default exists. Status reads do not advance version or update DB timestamps.

The factory is intentionally absent from tool assembly: the host authority gate, transactional turn fencing, and real receipt verifier have not been implemented. Gate checks outside a transaction alone are not race-safe. Do not activate by supplying an always-true verifier. The goal is opt-in and should not alter ordinary chats.

Verification: 37 tests pass across five files; backend `tsc --noEmit -p tsconfig.backend.json` passes. Four added adapter tests exercise status stability, forged evidence rejection, authorization rejection, and injected scope rejection. These are fixture tests, not production model/DB integration tests.

## Evidence verifier boundary

`goal-evidence.ts` validates server-issued receipts against closure scope, expected goal version, check phase, criterion identity/hash, revision, current artifact digest, trusted verifier identity, and pass/fail. A forged reference, old artifact under a reused revision label, changed criterion, duplicate receipt, or unavailable reader fails closed. Empty evidence is accepted only for an explicitly inconclusive check. The Pi adapter now passes expectedVersion to the verifier.

51 tests and backend typecheck pass. These include 14 evidence-validation cases; receipt readers and artifact digests are fixtures. There is no production receipt issuer/reader yet. A successful entry in `side_effect_executions` cannot be treated as a passed goal criterion: it proves tool execution disposition, not semantic acceptance. Actual receipt issuance requires an explicitly bound checker and server-observed artifact digest. Code/domain checks and human/visual acceptance need distinct issuers.

The verifier currently runs before the goal transaction. Production completion must revalidate a receipt/authorization snapshot under transactional fencing to close the check-to-write race. Therefore neither this verifier nor the tool factory may yet be enabled as a production completion authority. Do not paper over this boundary with always-true adapters or model-authored receipt records.

## Integrated prototype checkpoint

The prototype now includes:
- `goal-guard.ts`: concrete transactional SQL fence for matching owner/boot, live lease, running state, no user wait, no newer root, and no uncertain effects. An exact closure-supplied current goal_step execution ID can exclude only its own running wrapper receipt. Other running/uncertain effects still block.
- `goal-runtime.ts`: opt-in composition of tools and after-invocation continuation, per root turn, with a local reentrancy guard. Disabled mode exposes no tools and does not access storage. Distributed dispatch ownership remains a required host adapter.
- `goal-checker.ts`: receipt issuance from a host-approved checker, checking artifact digest and authorization before/after execution and requiring fenced commit. No arbitrary model command is accepted by this API.

67 fixture/unit tests pass across nine files, including tool-driven inspect/change/check invocations in the composition test and receipt issuance failure cases. These are not live Pi/DB tests. Latest backend typecheck is blocked by errors in `services/voice-runtime/tower-session-turn-gateway.ts` at lines 157 and 176, outside this work's files; an earlier check in this run passed before those errors appeared.

### Remaining production blockers (not solved by more interfaces)

1. Persistent immutable receipt table, real artifact revision ownership/hash capture, concrete allowed checker bindings, and transaction-fenced receipt issuer/reader must be implemented and tested with PostgreSQL.
2. Current Pi tools are assembled per SDK session, while goal authority/owner token is per root turn. A real per-turn binding must prevent stale cached tool context after a new user message.
3. Bind continuation to normal invocation settlement without competing with transport recovery; acquire atomic version/owner/stop authorization at dispatch. Account for compaction, cancellation, and existing side-effect wrapper execution identity.
4. Match lock order and isolate membership/new-user-message races with actual writers. SQL predicate presence tests do not prove concurrent correctness.
5. Only then register capability/assembly and enable for an explicitly approved local test. No schema application or production activation has occurred.

Do not count this composition as production integration or promise that current `/goal` uses these tools. It is an unregistered prototype with executable tests.

## Cached-tool root binding

`goal-binding.ts` adds a per-SDK-session proxy that resolves the current root at call time using the existing current-root-turn service. Binding/release use unique tokens so old cleanup cannot clear a newer binding. Active tool or continuation execution blocks rebinding; release/disposal aborts continuation cooperatively. Old-turn tool results are suppressed after invalidation. The proxy is still not installed in Pi tool assembly.

73 tests pass, including stale-root rejection, delayed-tool replacement blocking, old cleanup, disposal, and continuation cancellation. Backend typecheck still fails outside this change at voice-runtime/tower-session-turn-gateway.ts:157. Real DB migrations, receipt storage, and Pi dispatch integration remain pending. No production activation.

## Real PostgreSQL verification

Executed `GOAL_PG_E2E=1 npx --no-install vitest run packages/backend/services/goal-loop/goal-postgres.e2e.test.ts`: 7/7 PASS against a disposable postgres:16-alpine container, not a mock. The test applies the existing relevant migrations and draft goal schema only inside that isolated database. It verifies concurrent first-request idempotency, competing-update serialization, owner loss/user wait/newer message rejection, read-only status timestamps, and rejected-evidence rollback. Container cleanup was verified after execution. Production DB and services were not touched.

Normal suite: 73 passed, 7 opt-in PostgreSQL tests skipped (executed separately above). Latest backend typecheck passes. These results establish a bounded real-DB slice, not full concurrency safety against every production writer and not live Pi/model execution. Actual engine/assembly installation and trusted receipt integration remain outstanding.

## Current architecture: Tower-owned goal tools

The experimental Pi lifecycle integration and ws-handler goal admission were removed.
RunOpts contains no goal runtime or request. PiEngine does not admit, reject or
continue goals. Missing goal infrastructure no longer changes ordinary `/goal`
skill execution. Source regression tests enforce this separation.

`goal-tools.ts` owns engine-neutral `goal_step` and `goal_status` definitions,
validation and authority/evidence checks. `engines/pi-goal-tool.ts` is only a
compatibility adapter, not a registered tool or execution owner. The service
composition no longer imports Pi tool implementation or SDK types.

The earlier runtime, admission and binding helpers remain unregistered prototypes,
not the target production dispatcher. In particular, root-bound storage and
`afterInvocation` loops need redesign before reuse: persistent goal identity must
outlive each independently owned dispatched turn.

Next integration must be at Tower's orchestration layer: persistent goalId →
existing Turn Dispatcher → engine execution → durable terminal event → verification
and next-dispatch decision. No direct engine recursion or duplicate recovery loop.
Stop, approval waits, superseding input and uncertain effects must fence dispatch.
Receipt storage and real checker bindings remain required. Tool calls alone do not
make execution automatically continue. No production activation or deployment.

## Goal terminal manager slice

`goal-manager.ts` separates persistent `ManagedGoal.id` from each execution's
`rootTurnId`. A server-observed durable terminal event produces at most one
idempotent next-execution intent. Goal progress and the intent must commit in one
store transaction. The decision handles duplicate/stale terminals, authorization,
stop, approval, supersession, uncertain effects, verified completion, progress and
execution/cycle budgets. It never calls an engine or starts a timer.

Correction to earlier integration plan: `agent-turn/turn-dispatcher.ts` currently
scans **retry** candidates, not newly admitted work. A goal continuation MUST NOT
be injected as a failed-turn retry. The future intent consumer needs an authorized
new-turn admission gateway that rechecks stop/new-input/ACL/budget and atomically
claims the intent and records its distinct rootTurnId. Existing engine ownership
and recovery still apply to that newly admitted turn. Ambiguous dispatch must be
reconciled by intent identity, never blindly replayed.

Implemented here: pure decision logic and transactional port contract, with 12
new tests (94 suite passes total). Not implemented: production store adapter,
outbox schema/consumer, initial goal admission, shared tool registration, receipt
issuer or real-model E2E. No runtime activation. In-memory/pure tests do not prove
PostgreSQL atomicity or concurrent consumer safety.

## PostgreSQL terminal/outbox persistence

`goal-manager-store.ts` locks the persistent goal, asks a transaction-local trusted
observer for ACL/terminal/safety/evidence state, and commits the goal version and
unique dispatch intent together. No conflict is swallowed. Older pending intents
are cancelled in that same transaction. `goal-manager-schema.sql` is a draft for
isolated tests only, not an applied production migration.

Isolated PostgreSQL suite: 9/9 pass, including concurrent duplicate terminal
settlement producing exactly one intent and an insert conflict rolling back the
goal update. Existing 7 root-bound prototype tests also pass. The new observer is
a fixture: these tests prove SQL atomicity for this slice, NOT real ACL/terminal
verification. Concrete observer, admission/outbox consumer, cross-writer lock order
and shared tool registration remain production blockers. No activation occurred.

## Transactional intent consumer

`goal-intent-consumer.ts` locks goal then intent, rechecks through a trusted
transactional gateway, and atomically persists the new execution request, budget
increment, active root and admitted intent. Duplicate consumers return the same
admitted root without enqueuing again. Busy leaves a pending intent; denied/stale
requests are cancelled. Enqueue failure rolls back all writes. There is no engine
call or new background retry timer.

Isolated PostgreSQL suite now passes 14 cases. Five new cases cover concurrent
consumers/replay, busy, denied, stale intent, and rollback after a partial queue
insert (busy/denied are parameterized). The queue and gateway are explicitly TEST
fixtures, not real Tower turn admission. Real ACL/stop/new-input checks and the
production execution request gateway remain unimplemented; no model ran. This
consumer is not registered or deployed. Existing registerAgentTurn alone is not
sufficient: it does not share the caller's transaction or admit an actual prompt.

## Actual dispatch safety queries

`goal-dispatch-safety.ts` reads real session/project owner and membership, original
user-message anchor, subsequent input, running/uncertain side effects, active turns
and approval/attention state. The original input anchor must be persisted at goal
creation and must not be replaced by the latest input. Seven isolated PostgreSQL
cases cover ready, busy, newer input, missing anchor, archived session, approval
wait and scope mismatch; the complete PG suite is now 21/21.

This is deliberately NOT a complete ready-to-deploy gateway: session row locking
alone does not serialize existing message/stop/ACL writers. A shared admission
fence and persisted goal stop/revocation state are still required. The current
handleChat path writes a user message; reusing it for an internal continuation
would falsely supersede the input anchor. Do not connect it by constructing a fake
WebSocket/user message. Internal execution provenance must be explicit before
model dispatch. No real model execution or production activation was performed.

## Internal request persistence checkpoint

`goal-internal-request.ts` and draft `goal_internal_requests` persist original user
input provenance without writing a synthetic user message or retry turn. PG suite
22/22 verifies this. This is NOT actual engine admission: the consumer currently
uses the returned request ID as a reserved root identifier, whereas agent_turns
and side_effect_executions require a messages FK. Do not register this gateway for
execution. A common execution-request/provenance model and shared admission fence
must be designed before dispatch, cancellation and recovery can safely use it.
See work/goals/tower-goal-orchestration.md for the explicit blocked goal criteria.

Correction: internal-request gateway now exposes `persist`, NOT `enqueue`, and
cannot be passed as GoalTurnAdmissionGateway. Persistence leaves intent pending,
activeExecution null and dispatched unchanged. These invariants pass in the real
isolated PG test. The earlier reserved-root shortcut is removed. See
work/goals/execution-request-design.md for the proposed shared execution model.

## Additive execution-request backfill experiment

`execution-request-draft.sql` is an isolated-only additive experiment. It preserves
legacy request IDs and leaves all existing turn/ledger foreign keys untouched.
Cross-session and non-user roots abort rather than being skipped or guessed.
PG suite 25/25 verifies preserved turn data, coverage and full rollback of failed
DDL/backfill transactions. Normal suite 94 passes; backend tsc and diff check pass.
This is not an approved migration or a complete provenance-enforced repository.
Shared admission fencing, FK transition, internal runtime dispatch, real receipt
verification and common tool registration are still not implemented end to end.

## Shared in-process admission mutex

The existing ws-handler FIFO mutex now lives in agent-turn/session-admission-lock.ts;
chat and structured edits keep the same behavior. Goal intent consumption obtains
this same mutex, revalidates session identity in the transaction and releases in
finally. PostgreSQL 26/26 includes waiting behind chat admission and checking the
latest safety outcome after release. Combined local suite: 119 passes; tsc passes.
This is NOT a cross-process DB fence and does not integrate stop/ACL writers.
No production goal consumer or model dispatch is registered.

## Durable goal stop

`goal-stop.ts` atomically marks a goal stopped and cancels pending intents after
scope/ACL checks. It preserves the active root and explicitly returns whether
engine cancellation is still required. Persisted stop outranks late terminal
observations. PG 29/29 covers idempotency, owner denial and stop/admission racing;
combined ordinary suite 119 passes. This does not wire the UI Stop button or cancel
an engine. SQL locking is still prototype goal-first; do not mix with a future
session-first migration piecemeal.

## Isolated internal turn registration

`goal-turn-registration.ts` registers an internal request as a real agent_turn row
only under the draft execution-request FK transition. PG 30/30 includes a test
that changes the FK inside a savepoint, inserts the internal turn with no user
message, verifies the row and rolls back all experiment changes. This is not engine
execution. It requires preauthorized same-transaction admission and remains
unregistered. Side-effect ledger FK, recovery SQL, tool context and production
migration are not transitioned. Local integration refactoring was approved;
production changes and external model invocation were not.

## Existing ownership and ledger paths verified with internal roots

claimForegroundAgentTurn/settleAgentTurn accept an optional transaction query
adapter; side-effect begin/finish/fail accept an optional transaction runner.
Defaults remain unchanged. The isolated cutover case now invokes the actual
services to verify ownership, duplicate claim denial, fenced settlement, running
effect blocking and recovery result reuse for a root without a user message.
No provider/external operation ran. PG 30 cases pass; agent-turn+goal suite 160
passes with 32 opt-in skips; backend tsc passes. Recovery discovery/supersession
queries and default production request schema remain unchanged and are blockers.

## Provenance-aware recovery eligibility (draft)

execution-recovery-safety.ts uses the original user message rather than internal
turn acceptance time. It checks due time, current session/project access, goal
identity/status/active execution and ambiguous effects. Extended real-PG cutover
assertions cover eligible, owner busy, stopped goal, delayed retry, wrong goal
owner and newer input predating the internal turn. This is a read-only eligibility
gate, not an authoritative claim and not installed in the recovery dispatcher.
PG 30 cases and 160 ordinary tests pass; tsc/diff checks pass. The default recovery
path remains unchanged pending atomic shared admission and schema transition.

## Recovery claim transaction slice

execution-recovery-claim.ts locks prototype goal/session/turn records and invokes
existing claimAgentTurn with the same transaction query adapter after provenance
eligibility checks. It remains unregistered and cannot fence noncooperating input
or ACL writers. claimAgentTurn now scopes its locked row by session_id as well as
root_turn_id; the PG regression proves a wrong-session claim neither claims nor
increments attempts. PG suite 31/31. Real provider execution, shared production
schema and tool registration remain outstanding; do not deploy as complete.

## Common tool to persistent manager bridge

createGoalServiceTools accepts an engine-neutral service; legacy factory remains
compatible including its public error codes. managed-goal-service.ts updates the
same managed_goals record read by terminal management, with bounded idempotency
receipts and progress versions. managed-goal-guard.ts checks actual source input,
ACL and live turn token/boot/lease. Missing trusted receipt verifier denies checks.
PG 33 cases pass. Tool registration and actual checker remain unavailable. The
running side-effect wrapper's own receipt exclusion must be solved before exposing
this guard through the normal tool ledger. No production activation or live E2E.

## Exact wrapper exclusion and final integration audit

The managed guard may exclude only its closure-bound current goal_step wrapper
with matching execution ID, root, owner token and live lease. Uncertain, wrong
tool/token, expired and NULL lease rows remain blockers. SQL uses NOT COALESCE
so NULL cannot silently bypass the block. PG 39/39; combined suite 187 passes;
backend tsc/diff checks pass. No running test containers remain.

Final call-site audit: managed-goal service, internal registration and recovery
claim have no normal request-path callers. Tests are not production activation.
Initial admission, common schema/fence rollout, immutable receipt issuer/reader,
common tool registration and real dispatcher/model E2E remain incomplete. This
checkpoint exhausted the declared cycle budget and is explicitly NOT completed.

## Initial admission through real terminal observation

managed-goal-start.ts admits one explicitly authorized goal on an already-owned
user turn, validating the live guard and deduplicating concurrent starts.
managed-goal-terminal.ts observes real settled agent_turns instead of a fixture
completion event. PG composition now covers start -> common inspect tool -> actual
settleAgentTurn -> next intent. Nonterminal and busy safety snapshots are ignored,
not misreported as approval waits. Receipt completion still fails closed.
PG 40/40 and ordinary 160 pass. Latest backend tsc is blocked by unrelated
voice-fast-execution.ts:31 missing identity argument; that file was not changed.
No tool registry activation, production migration, provider call or full E2E.

## Persistent evidence reader and completed terminal composition

managed-goal-evidence.ts verifies DB receipts against persistent goal/root,
criterion hash, revision, trusted verifier and a host-provided current digest.
The draft table rejects ordinary UPDATE/DELETE via trigger; this is not protection
against privileged DDL/TRUNCATE. No public receipt writer is exposed.
Terminal observation can reverify completed evidence. PG start->inspect->check->
actual turn settlement->completed passes, including missing/forged/untrusted and
changed-digest denial. Receipts and digest remain fixtures: not a real checker or
filesystem fence. PG 41/41; ordinary+voice suite 190 pass; tsc/diff pass. Initial
runtime admission/registry/dispatcher and actual model E2E remain unactivated.

## Real bounded code checker and receipt issuance

bounded-code-check.ts runs server-approved argv with timeout/output limits and
compares an approved file manifest before/after. No raw output is returned. This
is not a sandbox or arbitrary command permission. managed-code-receipt.ts checks
live goal authority before/after and inserts real execution evidence. The caller
must hold an artifact-writer fence; repeated digest reads alone do not prove ABA
safety. The end-to-end DB composition now uses a real node assertion process and
real file digest, not an injected passed receipt. PG 42/42, ordinary 167 pass and
tsc/diff pass. It still does NOT invoke an LLM or expose production goal tools.

## Revised target: AI-evaluated closed loop

User clarification supersedes the earlier premise that only machine-checkable
receipts may decide completion. ai-review-loop.ts implements work -> separate AI
review -> validated pass/revise/needs_input -> feedback-driven work. Code enforces
schema, fixed criterion coverage, consistent pass, bounded malformed-response
retry, snapshot freshness, stop and final atomic acceptance. Tests/receipts are
supporting evidence, not substitutes for the evaluator. ai-review-prompts.ts keeps
evaluator instructions separate from untrusted artifact input. No Pi-specific
lifecycle hooks were added.

10 behavioral tests pass, including two work invocations after revise without user
intervention. These use fake AI ports, NOT live models. Real model/tool execution
adapters, durable continuation and runtime activation still need implementation.
The previous strict-receipt prototype is retained but is not the mandatory product
completion policy. Do not claim actual /goal uses this loop yet.

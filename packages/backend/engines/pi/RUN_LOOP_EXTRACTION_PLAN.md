# Pi run-loop extraction plan

## Goal

Thin `packages/backend/engines/pi-engine.ts` further without changing runtime behavior. The high-risk area is `PiEngine.run()`: it owns streaming event translation, persistence, steering delivery, watchdog terminalization, transient retry, Codex fallback, and turn metrics. This plan keeps extraction incremental and test-led.

## Current boundary

Already extracted low-coupling modules:

- `provider-safeguards.ts` — provider transport/request safeguards
- `message-adapter.ts` — Pi content → Tower blocks
- `model-registry.ts` — auth/model registry wiring
- `session-resources.ts` — prompt/resource loader assembly
- `tool-assembly.ts` — built-in/custom/MCP tools + hooks
- `session-settings.ts` — Pi SDK settings
- `quick-reply.ts` — stateless quick reply provider calls
- `session-manager.ts` — session file open/create
- `stale-cleanup.ts` — stale ephemeral file cleanup
- `channel-reply.ts` — `@ai` channel reply adaptation
- `rehydrate.ts` — hard-switch message rehydration
- `run-policy.ts` — pure watchdog/retry policy helpers
- `session-entry.ts` — live session state shape

`pi-engine.ts` is now mainly the engine class plus the streaming run loop.

## Non-goals

- Do not rewrite the run loop into a new abstraction in one step.
- Do not move model/workflow judgment into backend helpers.
- Do not change user-visible streaming behavior, DB write order, steer semantics, fallback policy, or watchdog thresholds.
- Do not introduce an event bus/framework just to make the file look smaller.

## Proposed extraction phases

### Phase A — Pure helpers first

Extract logic that can be unit-tested without a Pi SDK session:

1. `turn-metrics.ts`
   - compute final `turn_done.usage`
   - choose `contextInputTokens`
   - map failure class from watchdog/terminal/transient flags

2. `stream-coalescer.ts`
   - queue/flush assistant UI snapshots
   - queue/flush assistant DB updates
   - expose counters now stored in `streamPerf`

3. `transient-notice.ts`
   - 최종 실패·사용자 중단처럼 turn이 끝난 안내만 안정적인 문구로 만든다
   - 자동 복구 중간 상태는 assistant transcript에 저장하지 않는다
   - 최종 안내 중복 append를 방지한다

Acceptance: each module gets direct unit tests with fake inputs. No Pi SDK mocking needed.

### Phase B — Event handler slices

Extract event-case handlers one at a time, still invoked by `run()`:

1. `handleQueueUpdate(...)`
   - consume steering queue diffs
   - emit `steer_delivered`

2. `handleMessageUpdate(...)`
   - accumulate text/thinking/tool blocks
   - coalesce UI/DB updates

3. `handleMessageEnd(...)`
   - final assistant content sync
   - usage/cost/cache accounting
   - per-iteration DB metrics
   - reset `msgId`/accumulator for next iteration

4. `handleAgentEnd(...)`
   - SDK catch-path errors
   - Codex fallback request marking
   - transient suppression/retry marking
   - zombie terminalizer scheduling

Acceptance: source-contract tests can move from regex-on-`pi-engine.ts` to direct unit tests on these handlers.

### Phase C — Run context object

Only after A/B are stable, collect scattered local variables into an explicit context object:

- `PiRunContext`
- `PiRunQueues`
- `PiRunMetrics`
- `PiRunTerminalizers`

This reduces argument lists for event handlers. It should be a plain object, not a class hierarchy.

### Phase D — Optional run-loop extraction

After enough unit coverage, move the full generator body into `pi/run-loop.ts`:

```ts
runPiTurn({ sessionId, prompt, opts, callbacks, entry, engineDeps })
```

`PiEngine.run()` should remain the public adapter that obtains/creates the session and delegates.

## Test strategy

Prefer direct unit tests over more regex source-contract tests.

Minimum tests before moving the whole run loop:

- `turn-metrics.test.ts`
  - uses post-compaction live context when compaction succeeded
  - otherwise uses max(provider last input, live context estimate)
  - `numIterations` is at least 1
  - failure classes: watchdog, transient, sdk zombie, unknown fatal

- `stream-coalescer.test.ts`
  - immediate flush pushes one assistant event
  - delayed flush does not duplicate after final flush
  - DB update coalescing keeps latest content
  - counters increment consistently

- `transient-notice.test.ts`
  - 자동 복구 중간 안내 상수/저장 정책이 없다
  - 최종 exhaustion·사용자 중단 안내 문구가 안정적이다
  - 최종 안내를 기존 내용에 한 번만 append한다
  - 같은 최종 안내를 중복 append하지 않는다

- `channel-reply.test.ts`
  - assistant text deltas are computed from cumulative Tower messages
  - tool_use triggers `onToolUse`
  - compact triggers `onCompact`
  - engine_done carries next session file
  - non-recoverable engine_error throws
  - internal session is disposed in `finally`

- `run-policy.test.ts`
  - watchdog Korean reasons are stable
  - generic connection drops get one retry and router restart backoff
  - non-generic transient abort uses configured bounded backoff

## Stop condition

Stop extracting when the remaining `run()` body is coherent and risky to split further without integration tests. A slightly longer orchestrator is better than a scattered state machine that nobody can reason about.

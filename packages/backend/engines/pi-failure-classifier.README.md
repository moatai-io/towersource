# Pi provider failure classification

`pi-failure-classifier.ts` owns provider/SDK error classification and user-safe notices. `pi/run-policy.ts` consumes this classification for transient retry eligibility, and `pi/turn-metrics.ts` records run-end failure causes.

## Responses usage shape failures

A provider/proxy Python exception matching `'dict' object has no attribute 'usage'` is `provider_response_schema`, not `transient_transport`, including when wrapped in an HTTP 502/503/504 error. It remains a distinct cause but is eligible for bounded run-loop recovery: at most two retries, with 30s and 90s backoff. Existing SDK retry ownership, user abort, watchdog, and durable recovery safety checks still apply; retry eligibility is not a guarantee that pending steering or uncertain side effects can be replayed safely. This exception does not become a socket failure.

The user notice identifies response-format processing rather than claiming repeated network disconnections. Run-end metrics preserve this classification when the raw provider error is available. Genuine socket/time-out errors retain existing transport recovery.

This is recovery policy, not a fix inside LiteLLM. The exact provider component and failing line require its original exception stack and installed version. Tower must not fabricate usage values, drop the usage field, or claim that missing accounting data is a successful model response.

Tests: `__tests__/pi-failure-classifier.test.ts`, `__tests__/pi-turn-metrics.test.ts`, `__tests__/pi-run-policy.test.ts`. These cover local classification/notice/metrics; they do not prove live provider recovery or steering queue completion.

## Recovery exhaustion is terminal

Pi transport/provider retries remain bounded within the current run. Once that budget
is exhausted, `surfaceTransientAbortFailure` marks the durable recovery claim `failed`,
sets the error terminal outcome, and returns before incomplete-turn continuation.
Provider capacity errors do not receive a second durable retry budget after exhaustion.
A user-requested stop retains the separate neutral aborted outcome. A user may start a
new request explicitly; terminal failure does not schedule that request automatically.
Source regression coverage: `__tests__/pi-engine.test.ts` (Pi transient abort auto-retry).
This change does not claim live provider-failure injection or alter unrelated watchdog,
startup-recovery and intentional-wait behavior.

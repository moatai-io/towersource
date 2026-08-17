# Pi recovery

Pi SDK Session의 복구 가능 상태를 관측하고 Tower의 자동 복구 정책을 좁게 유지한다.

## 책임

- SDK transcript leaf 역할과 idle/queue 상태를 안전하게 요약한다.
- 정상 prompt 종료 후 추측성 native continuation의 opt-in 정책을 소유한다.
- assistant tool-only leaf는 완료로 오인하지 않으며 자동 prompt나 native continuation을 실행하지 않는다.
- secret이나 transcript 본문을 로그에 포함하지 않는다.

## Public API

- `inspectPiRecoveryState(session)`
- `isIncompleteToolBoundaryContinuationEnabled(env)`
- `decidePiContinuationRecovery(state)`
- `decidePiRestartRecovery(state)`
- `decidePiRetryOwnership(sdkRetryObserved)`
- `continuePiNativeLifecycle(session, reason)`
- `isPiNativeContinuationUnavailable(message)`
- `runPiContinuationRecovery(params)`
- `settlePiRecoveryOutcome(params)`

## 들어오기 전 알아야 할 것

Pi 0.82.1은 `_runAgentPrompt()` 내부에서 retry, compaction, queued-message continuation을 이미 수행한다. Tower는 정상 종료를 다시 이어가기보다 명확한 interruption만 복구해야 한다.

- SDK private lifecycle 필드 접근은 `native-continuation-adapter.ts` 한 파일에만 둔다.
- continuation trigger별 claim·준비·선택된 primitive 실행·settlement는 `recovery-coordinator.ts`가 공통 처리한다.
- `recovery-policy.ts`는 trigger를 모르며 leaf 상태를 공통 primitive로만 분류한다. `pi-engine.ts`가 trigger별로 허용 범위를 좁혀 transient assistant leaf만 recovery prompt로 재개하고, post-compact·incomplete assistant leaf는 fail-closed한다.
- server restart와 transient는 서로 다른 사실 기반 recovery prompt를 사용한다.
- assistant tool-only leaf가 남아 있으면 durable outcome을 `completed`로 두지 않는다.
- server restart와 transient recovery의 native continue/recovery prompt 선택은 `recovery-policy.ts`가 소유하고, 실행 후 completed/failed/uncertain/retryable settlement는 coordinator가 처리한다.
- 자동 transient recovery 중간 상태는 로그와 live run 상태에만 남기며 assistant 본문에는 저장하지 않는다. 최종 exhaustion·사용자 중단만 별도 terminal 안내로 저장한다.

관련 설계: `workspace/projects/tower/work/pi-continuation-reliability-redesign-2026-08-02.md`

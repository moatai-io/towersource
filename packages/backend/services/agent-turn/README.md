# Agent turn recovery

## 책임
원 사용자 메시지(`root_turn_id`) 하나를 하나의 durable workflow로 관리한다. Restart, transient, post-compact, incomplete-turn recovery는 모두 `turn-supervisor.ts`의 동일한 PostgreSQL 상태 행과 fencing token을 사용한다.

상태는 의도적으로 `running`, `waiting_retry`, `completed`, `failed`, `needs_attention` 다섯 개만 둔다. Provider 생성 실패는 제한적으로 `waiting_retry`가 될 수 있지만, 외부 부작용이 불확실하면 `needs_attention`에서 자동 반복을 멈춘다.

Recovery owner는 `owner_token`과 `owner_boot_id`를 함께 가진다. 동일 backend boot에서는 lease를 존중하지만, startup `server-restart` recovery는 이전 boot의 owner가 이미 죽었다는 사실을 이용해 남은 lease를 즉시 fencing/reclaim한다.

Restart recovery는 **24시간 이내의 최신 사용자 turn**에만 허용한다. 24시간을 넘긴 active row 또는 같은 세션의 더 최신 사용자 메시지에 뒤처진 row는 `needs_attention`으로 닫고 모델·도구를 자동 실행하지 않는다. 이는 오래된 부작용 재실행과 비활성 세션의 최근 목록 상승을 함께 막는 안전 경계다.

## Public API
- `registerAgentTurn` / `claimForegroundAgentTurn` / `claimAgentTurn` / `settleAgentTurn` — foreground와 recovery가 공유하는 durable turn 상태기계
- `findDueAgentTurnRetries` — backoff가 지난 `waiting_retry` discovery. 실행 claim은 하지 않음
- `createAgentTurnDispatcher` / `startAgentTurnDispatcher` — due turn을 기존 recovery executor로 깨우는 최소 process loop
- `wakeAgentTurnDispatcher` / `stopAgentTurnDispatcher` — settlement 직후 빠른 wake와 graceful shutdown
- `getActiveAgentTurnTiming` — reconnect/restart가 사용할 권위 시작·대기시간 snapshot
- `expireUnsafeRestartRecoveryTurns` — 24시간 초과 또는 최신 사용자 turn에 뒤처진 복구 후보를 fail-closed 정리
- `setAgentTurnWaitingUser` — AskUserQuestion 사람 대기 구간 누적
- `tryClaimAgentTurnRecovery` — transient/post-compact/incomplete/restart recovery의 단일 소유권 획득
- `releaseAgentTurnRecovery` — terminal 전 실패한 claim을 재시도 가능 상태로 반환
- `completeAgentTurnRecovery` — 현재 fencing token만 terminal 상태 기록
- `decidePiTurnTerminal` / `toTurnTerminalMessage` — Pi invocation evidence를 순수 분류하고 authoritative `turn_terminal` wire event로 투영
- `wrapToolsWithSideEffectLedger` — 공통 Pi tool boundary에서 성공 결과 재사용·running/uncertain 반복 차단
- `beginSideEffectExecution` / `finishSideEffectExecution` / `failSideEffectExecution` — 도구 실행 ledger 상태 전이

상태 저장과 UI 완료 authority는 구분한다. `turn-supervisor.ts`가 durable row를 저장하고, `turn-terminal.ts`가 실행·복구 없이 terminal outcome을 순수 분류한다. `turn_done`, `engine_done`, `session_status: idle`은 완료 증거가 아니며 `turn_terminal(outcome=completed)`만 완료 표시와 완료 부수효과를 연다.

## 들어오기 전 알아야 할 것
이 모듈은 외부 시스템과 Tower DB 사이의 원자적 exactly-once를 약속하지 않는다. 대신 recovery 중 성공 결과를 재사용하고, 실행 결과가 불명확하면 `uncertain`으로 자동 반복을 차단하는 at-most-once 정책을 제공한다. Provider가 자체 idempotency key/receipt를 제공하면 도구 구현에서도 함께 사용해야 한다.

Dispatcher는 두 번째 상태기계가 아니다. `waiting_retry` due row를 발견해 기존 `resumeInterruptedDetails()`에 전달할 뿐이며, 실제 실행 권한은 Pi recovery가 획득하는 기존 `owner_token` fencing claim이 계속 가진다. Candidate passive backend에서는 시작하지 않는다.

Foreground Pi turn도 SDK session을 열기 전에 `claimForegroundAgentTurn`으로 같은 fencing token을 얻는다. 이 claim은 recovery `attempt_count`를 올리지 않으며, foreground와 이후 automatic retry 모두 token을 가진 owner만 settlement할 수 있다.

`agent_turn_router_evidence`는 LiteLLM/Codex-LB Responses의 request/terminal 관측을 root turn에 연결하는 진단 테이블이다. Router `response.completed`만으로 Tower turn을 완료하지 않는다. `completed`에는 계속 durable assistant row가 필요하며, Router completed인데 assistant가 없으면 reconciliation 대상으로 남긴다.

## 관련 결정
- `workspace/decisions/2026-07-15-issue-176-continuation-recovery-dup-sideeffects.md`
- `workspace/decisions/2026-06-16-pi-provider-capacity-retry-and-notices.md`
- `~/workspace/decisions/2026-08-03-tower-codex-lb-terminal-evidence-boundary.md`

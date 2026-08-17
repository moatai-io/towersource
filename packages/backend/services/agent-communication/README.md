# Agent Communication

Agent Session 사이의 background turn 실행 계약을 소유한다.

## 책임

- `session-turn-runner.ts`: engine async iterator 시작, 시작 acknowledgement, stream 소비를 한 경로로 통일한다.
- `message-envelope.ts`: Agent Session 메시지 envelope을 persistence 경계에서 검증한다.
- `inbox-store.ts`: envelope과 최초 delivery attempt를 한 transaction으로 저장하고 inbox를 조회한다.
- `send-shadow.ts`: 기존 Session send를 durable envelope으로 projection해 best-effort shadow 기록한다.
- `completion-shadow.ts`: child completion callback을 durable report envelope으로 projection한다.
- `delivery-shadow.ts`: legacy steer/inject/wake에서 관측된 전달 결과를 delivery row에 best-effort 반영한다.
- `delivery-lease-store.ts`: due delivery의 SKIP LOCKED claim, token/boot fenced renew·settle을 소유한다.
- `delivery-controller.ts`: 명시 호출 한 번에 recipient의 due delivery 하나를 claim·policy 판정·adapter 실행·settle한다.
- `delivery-pump.ts`: PostgreSQL due rows를 startup·주기 sweep하고 process-local doorbell로 recipient별 drain을 직렬화한다.
- legacy send는 durable row를 acceptance 직후 ID로 claim하고 같은 engine start-ack/callback 경로 안에서 fenced terminal settle한다.
- child completion report도 inject/wake 전에 known delivery를 claim하고 delivery 성공 뒤 callback consume 전에 fenced terminal settle한다.
- spawn/send/wake adapter가 같은 실행 계약을 사용하도록 한다.

## Public API

- `runSessionTurnStream(input)` — 이미 준비된 engine/run options/callbacks를 실행하고 각 Tower message를 호출자에게 전달한다.
- `normalizeAgentMessageEnvelope(input)` — durable message envelope을 검증하고 기본값을 채운다.
- `acceptAgentMessage(input)` — message와 pending delivery attempt를 원자적으로 접수한다.
- `getAgentMessage(messageId)`, `listAgentInbox(sessionId, limit)` — shadow inbox 상태를 읽는다.

## 들어오기 전 알아야 할 것

- 이 모듈은 Session 생성, 권한 계산, 메시지 저장, report routing, wake queue를 소유하지 않는다.
- `agent_turns` 등록과 terminal settlement는 각 호출자의 정책 callback에 남아 있다.
- 현재 inbox는 shadow persistence 기반이다. Session send와 child completion inject/wake callback은 shadow dual-write한다.
- `accepted`는 DB 접수 성공만 뜻하며 recipient turn 실행이나 응답 완료를 뜻하지 않는다.
- shadow 저장·settlement 실패는 경고를 남기되 기존 send/callback을 실패시키지 않는다. delivery authority가 아직 legacy 경로에 있기 때문이다.
- active Pi steer는 `injected_active`, idle runner 시작은 `started_turn`, 관측된 완료/실패는 `completed`/`failed`로 shadow 기록한다.
- pump는 backend startup과 10초 주기로 due rows를 다시 발견한다. process-local 알림은 지연을 줄일 뿐 correctness source가 아니다.
- recovery adapter는 `agent_send` request와 기존 source root turn이 모두 있을 때만 같은 Session background runner/callback 경로를 재사용한다. 실행 중 recipient는 retry_wait로 미룬다.
- 재시작 전 `claimed`였던 delivery는 외부 도구 중복 실행을 피하기 위해 자동 replay하지 않고 `needs_attention/ambiguous_after_restart`로 격리한다.
- 일반 pump의 기본 adapter는 실행하지 않고 `needs_attention`으로 settle한다. legacy send cutover는 기존 공개 계약을 보존하기 위해 acceptance 직후 known delivery를 직접 claim한다.

## 관련 파일

- `../session/spawn-rpc.ts`
- `../agent-turn/README.md`
- `work/2026-08-10-agent-conversation-lifecycle-deep-module-plan.md`

# services/ai — AI dispatch / SDK / 보조 에이전트

채팅에서 발생하는 AI 호출 (`@ai`, `@task`), Claude/Pi SDK 어댑터, 짧은 텍스트 작업용 utility agent, 능동 알림 에이전트, 요약/분류 등의 보조 모듈을 모음.

## 책임

- **Claude SDK 어댑터** — `query()` 래핑, 옵션 빌드, 세션 추적, orphan 정리 (claude-sdk)
- **Pi 세션 런타임** — Pi engine 의 in-process 실행 / backup / resume (pi-session-runtime)
- **`@ai` mention 처리** — 멘션 감지, rate limit, 세션 매핑 (ai-dispatch)
- **Channel AI 응답** — 룸 단위 영속 AI 세션 + 즉답 응답 (ai-quick-reply)
- **Utility agent** — 짧은 텍스트 task (이름 짓기, 요약 등) 의 가벼운 SDK 호출 (utility-agent). 오래된 직접 제공자 모델 지정은 `litellm-responses/mini`로 전환하며, Router 장애 시 생성에 실패할 수 있습니다.
- **요약** — 대화 / 메시지 압축 (summarizer)
- **Proactive agent** — AI 가 먼저 말 거는 시스템 (proactive-agent)

## Public API

### `claude-sdk.ts` — Claude SDK wrapper (~10 export)
- `executeQuery(...)` — SDK `query()` 메인 진입점
- `getSession(sessionId)` — 활성 SDK 세션 조회
- `cleanupSession(sessionId)` — 세션 종료
- `abortSession(sessionId)` — 진행 중 작업 중단
- `consumeInterruptedSessions()` — 부팅 시 좀비 세션 회수
- `cleanupOrphanedSdkProcesses()` / `stopOrphanMonitor()` — 좀비 프로세스 모니터
- `gracefulShutdown()` — 종료 시 모든 세션 안전 종료
- `backupSessionFile(sessionId)` — `.jsonl` 백업

### `pi-session-runtime.ts` — Pi engine 런타임
- `backupPiSessionFile` / `getPiBackupPath` — Pi 의 in-process 세션 파일 백업
- `consumeInterruptedPiSessions` — 부팅 시 회수
- `gracefulPiShutdown` — 종료 시 정리
- `preparePiResumeSession` — resume 전 환경 세팅

### `ai-dispatch.ts` — `@ai` / `@task` 감지 + rate limit
- `parseAiMention(text)` — @ai/@task 멘션 추출
- `checkRateLimit` / `checkConcurrentLimit` — 사용자/룸/글로벌 rate limit
- `checkAiCallPermission` — 권한 검증
- `recordAiCall` — 호출 기록 (rate limit 카운팅)
- 타입: `MentionType`, `RateLimitConfig`, `RateLimitResult`

### `ai-quick-reply.ts` — Channel AI 응답
- `handleChannelAiMention(...)` — `@ai` 호출의 메인 진입점
- 룸별 영속 세션 (room-manager.getOrCreateChannelAiSession 사용)
- SDK 의 auto-compact 가 컨텍스트 윈도우 관리

### `utility-agent.ts` — 짧은 텍스트 task
- `runUtilityTextTask(prompt, opts?)` — 한 번 호출, 짧은 응답
- `engineFromModel(modelId)` — 모델 ID → engine ('claude' | 'pi')
- `auto-namer`, `summarizer` 가 사용
- `onResult`는 선택적 진단 콜백입니다. 생성 성공과 fallback(엔진 비활성·빈 응답·timeout·HTTP 오류·기타 런타임 오류)을 구분하며 모델 ID와 HTTP 상태만 전달합니다. 원문·응답·provider 오류 본문은 전달하지 않습니다.
- 자동 제목은 첫 사용자 메시지와 첫 AI 메시지 전체를 사용합니다. 유형별 제목 예시를 제공하고 URL을 제거합니다. 표시용 호환 함수는 실패 시 앞 20자를 반환하지만, 자동 저장 경로는 `generateSessionNameResult`의 성공 여부를 확인합니다. 실패한 대체 제목은 저장하지 않습니다. `[auto-name-result]`에는 세션 ID와 성공/실패 상태가 포함됩니다. 첫 AI 메시지가 시작 안내라면 후속 최종 답변은 포함되지 않습니다.
- 검증: `auto-namer.test.ts`, `utility-agent.test.ts`는 모의 응답 기반 회귀 테스트입니다. 실제 provider 가용성과 제목 품질은 별도 live 검증이 필요합니다.

### `summarizer.ts` — 메시지 요약
- `generateSummary(messages)` — utility-agent 통해 요약 한 줄

### `proactive-agent.ts` — 능동 알림
- `initProactiveAgent(broadcastFn)` — 부팅 시 1회
- `fireProactive(template, ...)` — 외부에서 알림 트리거. 모델 미지정 시 Core(`defaults.session`)를 사용하고 명시된 template 모델은 보존한다. 자동화 runner는 별도로 해석한 모델을 전달한다. `services/task/task-default-core.source.test.ts`가 기본값 전달 경계를 확인한다.

## 들어오기 전에 알아야 할 것

- **3 가지 AI 실행 경로** (혼동 주의):
  1. **사용자 채팅 세션** — 일반 chat → engines/index.ts → claude-engine / pi-engine
  2. **Channel AI** — `@ai` 멘션 → ai-quick-reply.ts (룸별 세션)
  3. **Task 실행** — `@task` / 명시적 task → task-runner.ts (claude-sdk 직접)
- **claude-sdk 는 Claude 전용**. Pi 는 별도 SDK 흐름 → engines/pi-engine.ts.
- **Pi provider 경계** — `engines/pi/provider-boundary.ts`와 `model-registry.ts`는 `litellm-responses/*` 및 공식 `openrouter/*`만 등록·해석합니다. 과거 VM 모델 파일의 Azure/OpenAI/Codex 행과 직접 키는 Pi 실행 허용 근거가 아닙니다. `quick-reply.ts`에도 같은 경계를 적용합니다. LiteLLM Router 연결은 `litellm-credentials.ts`가 소유합니다.
- **utility-agent 는 *engine 추상화* 통과** — generic, model 따라 자동 라우팅. 작은 task 면 이거 사용. 압축 모델과 Codex 오류 복구 모델은 `engines/pi/agent-end-policy.ts`에서 별도 설정으로 결정합니다.
- **ai-dispatch 는 stateless utility** — 외부 의존성 없음. 단위 테스트 쉬움.
- **proactive-agent 는 broadcastFn 주입식** — fastify/express 와 분리. 부팅 시점에 inject.
- **summarizer 는 utility-agent 위에 얇게** — language-resolver 로 사용자 언어 감지 + 짧은 요약 prompt.
- **claude-sdk 의 generateScopedToken 사용** — sandbox 같은 좁은 권한 task 에. ideas namespace + 15min 만료 등.

## 관련 결정문서

- `workspace/decisions/2026-05-03-ai-friendly-refactoring.md` — 이 폴더가 분리된 이유

## 관련 모듈

- `engines/index.ts` / `engines/claude-engine.ts` / `engines/pi-engine.ts` — 사용자 채팅 세션의 메인 흐름
- `services/auth/auth.ts` — generateScopedToken (sandbox token 발급)
- `services/auth/credential-store` — Claude 계정 회전
- `services/room/room-manager` — Channel AI 세션 영속
- `services/session/session-manager` — proactive-agent 가 세션 생성
- `services/task/task-runner` — `executeQuery` 직접 사용 (full task 모드)
- `services/messaging/index` — proactive-agent 가 messageRouter 통해 알림 발송
- `services/auto-namer` — utility-agent 사용
- `services/deploy/bwrap-sandbox` — claude-sdk 가 sandbox 모드일 때 쓰는 wrapper
- `services/workspace/jsonl-utils` — claude-sdk 가 .jsonl 위치 찾기

## 테스트

- `ai-dispatch.test.ts` — mention parsing + rate limit (stateless, 빠름)
- `ai-quick-reply.test.ts` — Channel AI 흐름 (mock 무거움)
- `pi-session-runtime.test.ts` — backup / restore
- `summarizer.test.ts` / `utility-agent.test.ts` — vi.mock 으로 SDK 격리
- `engines/__tests__/pi-provider-boundary.test.ts`, `pi-agent-end-policy.test.ts` — 직접 경로 차단 및 압축/오류 복구 분리

# Model Policy

## 책임

Tower의 논리 workload policy를 실제 모델과 reasoning effort로 해석한다. Agent와 Harness는 가능한 한 물리 모델명 대신 policy id를 참조한다.

## Public API

- `resolveModelPolicy()` — policy id를 immutable 실행 설정으로 해석한다.
- `resolveAgentExecutionPolicy()` — Agent definition의 명시값과 policy를 합성한다.
- `MODEL_POLICY_IDS` — 지원되는 정책 id.

## 알아야 할 것

- `medium`은 기존 Tower 기본 동작을 보존한다.
- `extra-high`는 현재 Pi SDK의 `xhigh`에 대응한다.
- `max`는 현재 Pi SDK가 `xhigh`까지만 지원하므로 명시적으로 `xhigh`로 제한하고 downgrade 정보를 남긴다.
- `ultra`는 향후 multi-agent orchestration용 예약 정책이며 지금은 실행할 수 없다.
- `core`와 `lite`는 workload/reasoning policy가 아니라 사용자-facing **관리형 모델 프리셋**이다. 신규 Pi 세션의 기본 선택은 `preset/core`로 저장하고, Lite를 명시적으로 고르면 `preset/lite`로 저장한다. 기존 `policy/core`와 `policy/lite`는 읽기 호환하고 신규 저장에서 정규화한다. `defaults.session`은 VM 관리자가 선택한 Core의 **물리 Router 매핑**이지 세션 선택 ID가 아니다. 턴 시작 시 현재 매핑을 해석하며 비었거나 실행 불가능하면 `MODEL_PRESET_UNAVAILABLE`로 차단한다. 프리셋 문자열 자체를 LiteLLM에 보내지 않는다. 기존 직접 선택한 Router ID는 프리셋으로 추론하거나 일괄 변경하지 않는다.
- `low`/`medium` 등 기존 reasoning-effort 정책은 별도로 유지되며, 관리자 설정 변경 시 대응 모델 참조를 함께 갱신한다. `ai_reply`와 `ai_task`는 Lite 보조 실행의 호환 필드이며, `ai_task`라는 이름은 자동화 본문 모델을 뜻하지 않는다.
- 대화·자동화·Task·Skill Workbench·모델 미지정 proactive 실행은 Core(`defaults.session`)를 기본으로 사용한다. 논리 `background` 정책도 항상 현재 Core 매핑을 해석한다. 기존 VM 정책 파일에 Lite 모델이 남아 있어도 `background`의 모델만 Core로 해석하고 effort/enabled는 보존한다. 관리자 Core 저장은 `background` 참조를 갱신하며 Lite 저장은 `low/title/summary`만 갱신한다. 명시적인 Agent/Task/Automation 모델 선택은 유지한다. 제목·짧은 요약 등 보조 실행 및 별도 압축 모델 경로는 변경하지 않는다.
- 구현·검증: `model-policy.ts`, `model-policy.test.ts`, `routes/api.ts`, `services/task/task-default-core.source.test.ts`, `services/skill-workbench/skill-workbench.test.ts`, `components/admin/AdminPanel.ai-operations.source.test.ts`. 로컬 회귀 테스트는 운영 설정 변경·배포·provider 실제 호출을 대신하지 않는다.
- 관리자 AI 화면의 모델별 기본 추론 수준은 VM 로컬 `models.json`의 각 Pi 모델 `defaultReasoning`만 수정한다. `PATCH /api/admin/models/reasoning`은 admin 전용이며 operator 화면에는 읽기 전용으로 표시한다. 명시적 실행 effort/정책은 모델 기본값보다 우선한다. Pi는 새 세션뿐 아니라 재개한 세션의 매 턴 시작 시 현재 모델의 VM 설정을 다시 읽어 적용한다. 카탈로그 새로고침은 기존 값은 보존하며, 처음 발견한 `gpt-6-sol`은 `high`, `gpt-6-astra`는 `low`로 등록한다.
- `smartest`/`smart`/`mini`는 VM 매핑·호환에 쓰이는 Router 별칭이며 기본 세션 선택을 뜻하지 않는다. 폐기한 `gpt55`는 패키지 모델 등록부에서 제거하고, 오래된 VM 파일에 남아도 Pi 등록·모델 해석·quick reply를 거부한다. 과거 세션의 직접 `gpt55` 선택은 다음 전송에서 Core 선택으로 복구하며 과거 Usage 행은 보존한다. 원본 provider ID로 자동 치환하지 않는다. Team 권한과 모델 매핑이 바뀌면 허용된 Router ID로 기본값을 별도 변경해야 한다. 과거 Usage Ledger·DB 행과 저장된 Harness snapshot은 일괄 재작성하지 않는다.
- 활성 Pi 백엔드는 시작 시 VM의 자체 LiteLLM 연결로 `/models` 카탈로그를 한 번 비동기 갱신한다. 성공 시 런타임 모델 레지스트리와 클라이언트 선택 목록을 갱신하되 `models.json`의 고객 Core/Lite 기본 매핑은 바꾸지 않는다. 조회 실패는 부팅을 막지 않고 마지막 정상 스냅샷을 유지한다. 수동 관리자 새로고침도 유지하며, passive candidate에서는 자동 갱신하지 않는다. 주기적 갱신은 없다. 관련 코드: `packages/backend/index.ts`, `packages/backend/services/ai/litellm-model-catalog.ts`; 검증: `packages/backend/services/ai/litellm-catalog-startup.source.test.ts`, `packages/backend/services/ai/litellm-model-catalog.test.ts`.
- Core/Lite 슬롯은 매핑이 VM 로컬 목록에서 누락·비활성화되어도 모델 선택 메뉴와 상태 표시줄에 남는다. 선택한 매핑이 실행 불가능하면 턴 시작 전에 `MODEL_PRESET_UNAVAILABLE` 오류를 반환하며 다른 모델로 조용히 대체하지 않는다.
- 관리자 프리셋 매핑 변경은 `models.json`의 `modelPolicies` revision을 올린다. 해당 프리셋을 선택한 기존 세션은 다음 턴부터 최신 매핑을 사용하며, 이미 진행 중인 턴과 과거 직접 선택 모델은 영향을 받지 않는다. 신규 Usage Ledger 행은 `selected_preset`, `preset_mapping_revision`, 요청 Router ID, 실제 provider 모델을 별도로 기록한다. `model_policy_id`는 프리셋 귀속에 사용하지 않는다. 스키마 migration 224가 적용된 후 새 코드가 기록할 수 있다.
- 기존 Pi 세션에 저장된 직접 모델 ID가 현재 VM 선택 목록에서 사라졌거나 비활성화됐으면 **다음 사용자 전송**에서만 `preset/core`로 복구한다. 프런트 요청 모델이 없거나 저장 모델과 같은 경우만 해당하며, 다른 명시적 선택·Core/Lite 프리셋·현재 선택 가능한 직접 모델은 보존한다. `/models` 동기화 실패 시에는 마지막 정상 카탈로그를 유지하는 기존 계약을 따르며, 새 직접 모델을 임의로 허용하지 않는다. Core 매핑의 실행 가능 여부를 먼저 검증하고 실패하면 `MODEL_PRESET_UNAVAILABLE`로 차단한다. 성공 시 세션 선택을 먼저 저장한 뒤 이전 모델과 Core 전환을 대화의 작은 안내 표시로 남기고 UI 모델 표시를 갱신한다. 이전 대화·Usage 행은 소급 변경하지 않는다. 구현: `legacy-session-recovery.ts`, `routes/ws-handler.ts`, `MessageBubble.tsx`; 검증: `legacy-session-recovery.test.ts`, `ws-legacy-model-recovery.source.test.ts`, `session-alias.test.ts`.

- 기본값·복구 경계의 회귀 테스트는 `config.test.ts`, `session-alias.test.ts`, `session-manager.engine-switch.test.ts`, `pi-provider-boundary.test.ts`, `pi-agent-end-policy.test.ts`, `litellm-model-catalog.test.ts`, `model-store.core.test.ts`가 담당한다. SDK 압축 기본 모델은 현재 세션 모델이며 이 변경에서 바꾸지 않는다. 실제 VM 배포와 Router upstream 모델 확인은 별도 검증이다.

- 모델 선택 메뉴와 현재 선택 버튼, Agent 모델 선택은 프리셋의 `runtimeModelId`를 읽어 `Core - gpt-6-sol`처럼 현재 매핑을 표시한다. Core/Lite 선택 ID는 유지하며, 관리자 설정 변경의 `config_update`로 새 매핑을 반영한다. 전송 provider 접두사만 생략하고 실제 upstream 모델을 추정하지 않는다. 구현·검증: `packages/frontend/src/components/layout/model-display.ts`, `model-display.test.ts`, `packages/frontend/src/components/agents/AgentsPanel.tsx`.

### Packaged Core route and retired Smartest

The packaged session default and medium/high/extra-high/max/ultra/background policies use `litellm-responses/gpt-6.1-sol`. The exact `smartest` route is disabled and no longer selectable, including stale registry entries. Historical explicit `smartest` session choices normalize to `preset/core`; this does not rewrite persisted sessions or retire the distinct `smartest-long` route. Compaction recovery without model metadata uses the current session default rather than a hard-coded Smartest ID. Tests: `config.test.ts`, `session-alias.test.ts`, and `engines/__tests__/pi-engine.test.ts`.

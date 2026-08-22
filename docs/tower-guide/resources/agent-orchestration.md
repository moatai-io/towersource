# Tower Agent Orchestration Guide Resource

This resource is loaded on demand by Pi via `guide_read` when exact Tower subagent, persistent agent-worker, session spawn, send/list/readback, quota, and report-contract details are needed. Keep the system prompt short; keep autonomous-spawn safety invariants in core.

## Subagents — 복잡한 업무 위임

- Tower에는 지원 AI를 **subagent**로 띄우는 Agent Session 도구가 있다. 사용자가 아주 복잡하거나, 조사/검토/구현/리뷰처럼 명확히 나눌 수 있는 일을 맡기면 "필요하면 서브에이전트도 쓸 수 있다"는 점을 짧게 알려줘도 된다.
- 꼭 필요한 경우에는 사용자에게 매번 묻지 않고도 **1~3개 정도의 subagent**를 스스로 사용할 수 있다. 단순 작업, 빠른 답변, 파일 몇 개 수정 수준에는 쓰지 말고, 병렬 검토/독립 조사/리스크 리뷰처럼 품질이 실제로 좋아지는 경우에만 사용한다.
- subagent를 만들기 전에는 먼저 **전달 가능한 맥락 패키지**가 있는지 확인한다. 최소한 관련 파일 경로, 현재 판단/가정, 수정 중인 코드나 diff 범위, 읽어야 할 결정문서·로그·자료 링크, 금지사항, 기대 산출물을 짧게 묶어 줄 수 있어야 한다.
- 맥락 패키지를 만들 수 없다면 subagent를 쓰지 않는다. 부모가 필요한 자료를 먼저 읽고 정리한 뒤 위임하거나, 그냥 부모 세션에서 계속 처리한다. 새 subagent가 맥락을 처음부터 재구성하게 만들면 변수와 토큰 비용이 커지고 검토 품질도 흔들린다.
- 사용자가 명시적으로 더 많은 병렬 위임을 요청하면 최대 **10개 active subagent**까지 사용할 수 있다. 6개 이상은 반드시 사용자의 명시 요청이 있을 때만 사용하고, 미션을 서로 독립적으로 쪼개며, 같은 파일/리소스를 동시에 수정하게 하지 않는다.
- 기본 경로는 `persistent_agent_create`다. 모든 subagent는 지속 가능한 Agent Session이다. 한 번만 필요한 일도 새 subagent에 bounded task를 주고, 이후 재사용하지 않으면 된다. 기존 subagent 후속 지시는 `persistent_agent_send`를 쓴다.
- **보고 계약**: subagent는 맡은 일이 완료/실패/막힘 상태가 되면 반드시 부모 supervisor에게 보고해야 한다. 기본 동작은 report-and-resume(wake)이며, 부모가 잠들어 있어도 보고가 오면 깨어나 이어서 판단한다.
- `on_complete`는 예외 조정용이다. 기본값을 쓰면 보고 후 부모가 자동 재개된다. `on_complete: "inject"`는 보고만 남기고 자동 재개하지 않는 예외, `none`은 거의 쓰지 않는 muted/background 예외다.
- subagent에게는 작고 검증 가능한 미션을 준다: 목표, 범위, 금지사항, 산출물 형태, 읽기 전용/수정 가능 여부를 분명히 적는다. destructive action, 배포, 외부 전송, 비용 큰 반복 작업은 subagent에게 위임하지 않는다.
- subagent 지시에는 부모가 정리한 맥락 패키지와 기대하는 제약조건·성공 기준을 명시한다. "깊은 분석은 backing session/파일에 남기고, 부모에게는 결론·근거·산출물 경로·리스크를 간결히 보고하되, 도움이 될 때만 DETAIL_ARTIFACTS·READ_IF_NEEDED·PARENT_NEXT 힌트를 덧붙이라"고 요구한다.
- 부모 assistant가 supervisor다. subagent의 "완료" 답변만 믿지 말고, 실제 diff/test/log/render/evidence를 확인한 뒤 사용자에게 종합해서 보고한다. 빈 응답, stuck 상태, 증거 없는 완료 주장은 성공으로 보지 않는다.
- 부모 컨텍스트를 아끼기 위해 subagent의 긴 조사 내용·툴콜 흔적·중간 메모를 부모 메시지에 그대로 붙이지 않는다. 필요할 때만 backing session, `persistent_agent_status`, 산출물 파일 경로를 열어 상세를 확인한다.
- 컨텍스트 오염을 줄이려면 재사용할 가치가 있는 장기 역할은 기존 subagent로 이어가고, 새 관점/독립 검토가 필요하면 새 subagent를 만든다.
- 사용자가 "서브에이전트 써", "병렬로 맡겨", "리뷰어 붙여"처럼 말하면 agent-worker 기반 subagent를 우선 사용한다. legacy Pi in-process `agent`는 퇴역 경로이며 사용하지 않는다.

근거: `workspace/decisions/2026-06-14-subagent-requests-route-to-persistent-workers.md`, `workspace/decisions/2026-06-14-unify-agent-sessions.md`

---

## 세션 spawn & orchestration — 정책

`mcp__tower-spawn__*` 6개 도구로 다른 세션과 협업 가능: 자식을 띄우고 (spawn_session), 후속 메시지를 보내고 (send_to_spawned_session), 임의 세션에 끼어들고 (send_to_session), 자식 결과 텍스트를 읽고 (get_spawned_response), 자식 목록 조회하고 (list_spawned_sessions), 정리 (delete_spawned_session).

### ⚠️ 사용 정책 — AI 자율 호출 금지 (5도구 모두)

- **자기 판단으로 어느 spawn 도구도 호출하지 마세요.** "병렬로 분석하면 좋겠다", "다른 세션에도 알려야겠다" 같은 *AI 의 자기 편의* 로 호출 X — 사용자 사이드바를 잡음으로 채우고 다른 세션 흐름을 망칩니다.
- 호출 허용 조건은 둘 중 하나뿐:
  1. **사용자 명시 요청** — "사이드바에 새 세션 띄워서 ~", "그 자식 세션에 ~ 도 물어봐줘", "어제 작업하던 X 세션에 ~ 알려줘", "spawn / send 해줘" 류 직접 트리거.
  2. **활성 스킬 명시 호출** — 스킬 SKILL.md 가 도구를 흐름의 일부로 박아둔 경우 (예: `/research`, `/best-of-n`).

배포 같은 외부 변경과 동일하게 사용자 명시 요청이 필요한 정책입니다.

### 도구 선택

- **복잡하지만 부모 assistant가 감독하는 위임/검토/조사** → 위 `Subagents` 정책의 agent-worker 기반 `persistent_agent_create` / `persistent_agent_send` 를 사용한다.
- **사용자가 보거나 / 끼어들거나 / 인용해야 하는 별도 대화 세션** → `spawn_session` (새로 띄움) 또는 `send_to_session` (기존 세션).
- **자식과 후속 대화** → `send_to_spawned_session` (자기 자식 한정).
- **다른 사용자 세션에 끼어들기** → `send_to_session` 의 admin 권한. 신중히 — 그 세션 사용자가 자기 흐름이 끊어진 걸 봅니다.

### 자식 정리 / 조회

- report를 응답에 통합한 후 자식이 더 필요 없으면 `delete_spawned_session` (soft-delete, 데이터 보존).
- 사용자가 "남겨둬" 한 경우는 지우지 말 것.
- 자식 목록은 `list_spawned_sessions` — 상태 (running/idle/archived) + 마지막 메시지 시각.

### 보고 + 재개 정책

- 기본은 **report-and-resume(wake)** 이다. 다른 세션/자식/워커에게 일을 맡기면 결과는 원칙적으로 돌아오며, 부모 세션은 자동으로 깨어나 이어서 판단한다.
- **inject** 는 내부적으로 report-only 예외다. 답은 부모 세션에 남기지만 부모 AI를 자동 재개하지 않는다. 사용자가 명시적으로 "보고만 남겨", "조용히 수집"에 가까운 요청을 할 때만 쓴다.
- **none** 은 muted/background 예외다. 정말 결과를 안 받아도 되는 경우에만 쓴다. 일반 delegation/spawn/send에는 쓰지 않는다.
- **send 받은 메시지**: 대상 세션에 *user message* 로 (`_(<caller-name> 에서)_: ...`).
- **get_spawned_response** (fan-in): 부모가 능동으로 자식 답 텍스트 조회 → 여러 자식 결과 비교/종합/인용 시 사용.

### 가드레일 (인프라 강제)

- child/support session 동시 active: parent/supervisor session당 10개 — SPAWN_QUOTA_EXCEEDED
- spawn depth: 3 — SPAWN_DEPTH_EXCEEDED
- send 받는 측 rate: 분당 10회 — SEND_RATE_LIMIT
- send ping-pong loop: 5초 내 직전 sender 에 reply 차단 — SEND_LOOP
- send 받는 측이 streaming 중이면 거부 — TARGET_STREAMING
- send_to_session 권한: 자기 user 의 세션 OR admin — SEND_PERMISSION_DENIED
- 자율 wake chain: 한 부모가 연속 auto-wake 받을 수 있는 cap 10. 초과 시 자동 정지 + 사용자 알림. 사용자가 부모에 메시지 보내면 reset.
- Persistent worker 통신은 wake/report-and-resume를 정상 경로로 사용한다. inject/none은 일반 worker API에서 선택하지 않으며 legacy low-level spawn 호환 경로에서만 허용된다.
- wake는 기본 보고 전달 방식이다. 다만 새 spawn/send 도구 호출 자체는 여전히 사용자 명시 요청 또는 스킬 흐름이 있을 때만 한다.

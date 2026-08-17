---
name: task-schedule
description: >
  Tower 의 스케줄 Job Registry 생성·조회·수정 진입점. 기존 Task/칸반 예약,
  legacy schedules, 새 automations 를 흡수하는 사용자-facing 스케줄 시스템을
  관리한다. 새 예약/반복 작업은 사용자의 자연어 요청을 바로 등록하지 말고,
  필요한 질문을 한 뒤 automations 에 생성한다. Trigger: /task-schedule,
  /create-kanban-task legacy alias, 태스크 만들어, 할일 추가, 작업 등록,
  스케줄 등록, 예약해줘, 매일 9시, 매주 월요일, 반복 실행, 정기 실행,
  태스크 목록, 스케줄 보여줘.
argument-hint: "<natural language request> | list | migrate-dry-run | migrate-apply"
version: 3.0.0
---

# /task-schedule — Tower 스케줄 Job Registry 진입점

## 핵심 원칙

- 사용자는 내부 구현을 알 필요가 없다. `automations`, `API`, `토큰`, `Claude`, `SDK`, `cronConfig` 같은 말을 기본 답변에 꺼내지 않는다.
- 새 예약/반복 작업은 Tower 스케줄로 정리한다. Runtime Box / shell / script 안에 별도 crontab, systemd timer, node-cron 을 만들지 않는다.
- 사용자 요청을 즉시 등록하지 말고, 부족한 정보만 짧게 묻는다. 특히 “무엇을/언제/어느 프로젝트에 묶을지/어떤 경우에 보고할지”를 확인한다.
- 기본 보고 방식은 `auto`다. 즉, 실행할 때마다 무조건 알리는 것이 아니라 AI/러너가 “사람에게 말 걸 가치가 있는지” 판단한다.
- 프로젝트가 있는 스케줄의 기본 보고 위치는 해당 프로젝트의 `townhall` 채널이다. 없으면 생성/ensure 하는 방향으로 안내한다.
- 같은 실행 맥락을 계속 쓸지, 매번 새 실행으로 볼지는 기본 `auto`다. 모니터링·변화 감지는 이어지는 세션, 독립 보고·고빈도 체크는 새 실행이 기본적으로 더 적합하다.
- 도구 호출 전 “프로젝트 톤/지침을 확인하겠습니다”, “절대경로로 다시 확인하겠습니다”, “가능한 범위에서 테스트하겠습니다” 같은 내부 진행 문장을 말하지 않는다. 필요한 경우 질문이나 결과만 말한다.
- 채팅에서 `mcp__schedule__create_ai_schedule` 도구가 있으면, 사용자 확인 후 그 도구로 AI prompt 스케줄을 생성한다. API 토큰/curl을 사용하거나 언급하지 않는다.
- 등록 도구가 없으면 기술 원인 설명 없이 “현재 채팅에서는 바로 저장까지는 안 되고, 아래 설정으로 스케줄 탭에서 만들 수 있어요”라고 짧게 말한다.

## 생성 대화 플로우

사용자가 “이거 매일 돌려줘”, “스케줄 등록”, “태스크 만들어”라고 하면 다음 순서로 진행한다.

1. 의도 확인
   - 무엇을 실행할지
   - 언제 / 얼마나 자주 실행할지
   - 어느 프로젝트에 묶을지
   - 보고한다면 어느 채널에 남길지 — 기본은 프로젝트 `townhall`
   - **어떤 경우에 사람에게 알려줄지** — 기본은 “AI가 중요하다고 판단할 때만”
   - 이전 실행 맥락을 이어갈지 / 매번 새로 판단할지 — 기본은 `auto`
2. 부족한 정보만 짧게 질문한다. 한 번에 너무 많은 질문을 던지지 않는다.
3. 등록 전 요약을 보여준다.
4. 실제 등록 도구 `mcp__schedule__create_ai_schedule`가 있으면 사용자 승인 후 등록한다.
5. 실제 등록 도구가 없으면 내부 사유를 길게 설명하지 말고, 사용자가 스케줄 탭에 그대로 넣을 수 있는 설정값만 준다.

## 보고 정책과 실행 맥락

스케줄의 “보고 위치”와 “보고 여부”는 분리한다.

### 보고 위치

- 프로젝트 스케줄 기본값: 해당 프로젝트 `townhall` 채널
- 사용자가 원하면 프로젝트 내 다른 채널 지정 가능
- 시스템/비프로젝트 스케줄은 `general`에 자동으로 흘리지 말고, 프로젝트/채널을 고르게 유도

### 보고 여부

사용자에게는 내부 enum을 그대로 말하지 않고 쉬운 표현으로 설명한다.

| 내부 정책 | 사용자 표현 | 의미 |
|---|---|---|
| `auto` | AI가 중요할 때만 알려줌 | 기본값. 실행 결과를 보고 사람에게 말 걸 가치가 있으면 보고 |
| `always` | 매번 알려줌 | 테스트, 브리핑, 감사 로그처럼 매 실행을 봐야 할 때 |
| `on_change` | 변화가 있을 때만 알려줌 | 뉴스/가격/상태 감시 |
| `on_error` | 실패했을 때만 알려줌 | 백업, 동기화, 헬스체크 |
| `silent` | 따로 알리지 않음 | 캐시 갱신, 내부 정리 |

새 스케줄을 만들 때는 가능하면 한 문장 `reportCondition`을 남긴다.

예시:
- “중요한 뉴스가 새로 발견되면 알려줘.”
- “5개 이상 세션이 동시에 실행되는 순간만 알려줘.”
- “실패하거나 확인이 필요할 때만 알려줘.”
- “매번 요약해서 알려줘.”

### 실행 맥락 / 세션 연속성

기본값은 `auto`다.

- 이어지는 세션이 적합한 경우: 모니터링, 변화 비교, 이전 실행과 비교해야 하는 작업, 메일/뉴스/가격 감시
- 새 실행이 적합한 경우: 독립적인 일일 보고서 생성, 매번 같은 포맷 산출, 고빈도 체크, 이전 맥락이 오히려 오염이 되는 작업
- 기존 사용자 세션에 직접 주입하는 방식은 기본값이 아니다. 사용자가 명시적으로 “이 세션에 계속 넣어줘”라고 할 때만 쓴다.

## 등록 실행

도구가 있을 때는 다음 매핑으로 호출한다.

- `name`: 사용자가 알아볼 짧은 이름
- `description`: 목적/기대 결과 한 문장
- `prompt`: 예약 시 실행할 AI 지시문
- `triggerType`: `cron`, `once`, `manual`
- `cronConfig`: 매일/평일/매주/간격 실행 정보
- `resultTarget`: 결과를 남길 위치를 쉬운 말로. 프로젝트 스케줄이면 기본적으로 “해당 프로젝트 townhall 채널, 단 AI가 중요하다고 판단할 때만 보고”처럼 적는다.

도구 호출 후에는 “등록됐습니다” + 이름/주기/내용만 짧게 확인한다. 도구 이름이나 id는 사용자가 묻지 않으면 말하지 않는다.

## 등록 가능 여부 말하기

좋은 말:

```text
이 설정으로 만들면 됩니다.

- 이름: 매일 아침 브리핑
- 주기: 평일 오전 9시
- 내용: 이 프로젝트의 어제 작업, 오늘 할 일, 막힌 점 요약
- 결과: 이 프로젝트 세션에 남김

현재 채팅에서는 저장 버튼까지 대신 누르지는 못해서, 스케줄 탭에서 위 값으로 만들면 됩니다.
```

나쁜 말:

```text
API 토큰이 없습니다. Runtime Box에 TOWER_API_TOKEN이 없습니다. Claude 기본 schedule과 충돌합니다...
```

### 명령/스크립트 실행형 스케줄

일반 사용자는 AI에게 “무엇을 해줘”라고 예약하는 방식이 기본이다. 프로젝트 파일을 실제로 고치거나 명령을 실행하는 예약은 위험할 수 있으므로, 사용자가 명확히 원할 때만 짧게 확인한다.

## 시간 표현

사용자에게는 쉬운 말로만 말한다.

- “매일 오후 6시”
- “평일 오전 9시”
- “매주 월요일 오전 10시”
- “30분마다”

사용자에게는 다음 기준으로 요약한다.

- 다가오는 실행
- 등록한 스케줄
- 실패/꺼짐/위험도 높은 job
- 프로젝트별 job

## 수정 — 친절한 상담 모드

사용자가 스케줄 탭에서 **AI 수정**을 눌렀거나, “`OOO` 스케줄 고쳐줘”처럼 스케줄 이름만 말하면 이 모드로 동작한다.

### 말투 원칙

- 사용자에게 `enabled`, `triggerType`, `cronConfig`, `PATCH`, `definitionJson`, `job_type` 같은 내부 용어를 말하지 않는다.
- 내부 값을 보여줘야 할 때는 쉬운 말로 바꾼다.
  - `enabled: true` → “현재 켜져 있어요”
  - `enabled: false` → “현재 꺼져 있어요”
  - `triggerType: cron` → “정해진 시간마다 자동 실행돼요”
  - `triggerType: once` → “한 번만 실행돼요”
  - `triggerType: manual` → “자동 실행 없이, 필요할 때 직접 실행하는 설정이에요”
  - `cronConfig: { type: 'weekdays', hour: 9, minute: 0 }` → “평일 오전 9시에 실행돼요”
  - `jobType: shell/script` → “프로젝트 안의 명령/스크립트를 실행해요”
  - `riskLevel: high` → “실제 파일이나 시스템에 영향을 줄 수 있어서 적용 전 확인이 필요해요”
- “enabled true 로 바꿔드릴까요?” 대신 “이 스케줄을 켜둘까요?”라고 묻는다.
- “PATCH 하겠습니다” 대신 “이대로 반영할까요?”라고 묻는다.
- 첫 답변은 5줄 안팎으로 짧게: 현재 상태 요약 → 바꿀 수 있는 선택지 → 질문.
- 사용자가 명확히 말하면 다시 질문을 늘리지 말고, 적용 요약을 보여준 뒤 승인받는다.

### 이름만 받은 경우

사용자가 “아침 브리핑 스케줄 바꿔줘”처럼 이름만 말하면:

1. `/api/automations` 로 등록된 스케줄을 조회한다.
2. 이름이 비슷한 후보를 찾는다.
3. 하나만 확실하면 바로 쉬운 말로 요약한다.
4. 여러 개면 “어느 스케줄을 말씀하시는 걸까요?” 하고 후보 2~5개만 보여준다.

후보 표시 예시:

```text
비슷한 스케줄을 2개 찾았어요.
1. 매일 아침 브리핑 — 평일 오전 9시, 현재 켜짐
2. 매일 아침 프로젝트 브리핑 — 평일 오전 9시, 현재 꺼짐

어느 쪽을 바꿀까요?
```

### 수정 대화 예시

좋은 응답:

```text
이 스케줄은 “매일 아침 브리핑”이고, 현재 평일 오전 9시에 자동 실행되도록 켜져 있어요.
하는 일은 프로젝트의 어제 작업과 오늘 할 일을 요약하는 것입니다.

바꿀 수 있는 건 보통 ① 실행 시간 ② 실행 요일 ③ 켜기/끄기 ④ 실행 내용 ⑤ 어느 채널에 남길지 ⑥ 어떤 경우에 알려줄지 ⑦ 이전 실행 맥락을 이어갈지예요.
어떤 방향으로 바꿔볼까요?
```

나쁜 응답:

```text
현재 enabled=true, triggerType=cron, cronConfig.type=weekdays 입니다.
PATCH로 enabled=false를 적용할까요?
```

### 적용 직전 확인

실제 수정 전에는 사용자가 이해할 수 있는 한 문장 요약으로 승인받는다.

```text
정리하면, 이 스케줄을 “평일 오전 9시”에서 “매일 오전 8시 30분”으로 바꾸고, 계속 켜둡니다.
이대로 반영할까요?
```

승인 후에만 `PATCH /api/automations/:id` 를 사용한다. 내부 API payload 는 기술적으로 작성하되, 사용자에게는 쉬운 말로 결과를 보고한다.

```bash
curl -s -X PATCH "$BASE/automations/<id>" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{ "enabled": false }'
```

보고 예시:

```text
반영했어요. 이제 이 스케줄은 꺼져 있어서 자동으로 실행되지 않습니다.
```

## Legacy migration

외부 자체 호스팅 서버의 기존 예약 태스크 migration은 일반 Project Runtime Box 작업이 아니라 operator 작업이다. `/fleet` 진입점과 운영 runbook을 사용하며, 일반 사용자 세션에서 host source 경로나 migration script를 직접 실행하지 않는다.

```text
operator-only: /fleet legacy schedule migration <customer>
```

절차:

1. dry-run
2. proposed automation 검토
3. 사용자/운영자 승인
4. apply — automation 생성 후 legacy task `schedule_enabled=0`
5. 스케줄 탭 검증
6. active legacy scheduled task 가 0 이 되면 legacy tick 비활성화 검토

## 관련 문서

- `~/workspace/decisions/2026-06-20-task-schedule-reporting-and-run-context.md`
- `~/workspace/decisions/2026-06-03-schedule-replaces-legacy-tasks.md`
- `~/workspace/decisions/2026-06-02-schedule-automation-dashboard-prd.md`
- Operator source tree의 `docs/legacy-task-to-schedule-migration-runbook.md` — `/fleet` 작업에서만 참조

---
name: search
description: |
  Tower의 과거 대화, 세션, session-memory card를 찾아 현재 작업에 필요한 맥락과 근거를 회수한다.
  Use when: search, 과거 대화 찾아, 저번에 말한 거, 기억나, search sessions, conversation-search, knowledge-search.
  NOT for: 빠른 연속성 힌트만 필요할 때는 memory_search, 웹 검색은 WebSearch, 새 인계 문서 작성은 handoff.
argument-hint: "<keyword> | recent [N] | session <name> | stats | memory <keyword>"
version: 1.1.5
---

# /search — conversation-search / 과거 대화 맥락 검색

Tower의 PostgreSQL 검색 API를 사용해 `session_memory_cards`, 세션 이름/요약, 메시지 본문을 함께 탐색한다. 제품/프롬프트 설명에서는 이 스킬을 **conversation-search**라고 부른다. 명령어 이름은 호환성을 위해 `/search`를 유지한다.

현재 검색 서비스의 실제 구현은 `packages/backend/services/workspace/search.ts` 기준이다.

- Primary path: PostgreSQL `tsvector` + GIN index (`simple` config, `websearch_to_tsquery`).
- Fallback: session 또는 message 섹션의 `tsvector` 결과가 없을 때 해당 섹션만 `pg_trgm`/`ILIKE`로 보완한다. memory card는 현재 `tsvector` 전용이다.
- 검색 섹션: `work` → `memory_card` → `session` → `message`.
- `work`는 canonical `work_ledger_records`에서 TodoWrite, Work Summary, Process Map, schedule/agent run의 제목·결과·Todo·산출물·남은 일을 검색한다.
- Work Ledger 원본 행은 유지하고, AI 출력에서 같은 workstream/run과 같은 세션의 가까운 TodoWrite·Work Summary만 대표 업무로 묶는다.
- 기본 범위: archived/history 세션은 제외. 필요할 때 `includeArchived=1`을 명시한다.
- 주의: 이 스킬은 **대화/세션 검색**이다. 워크스페이스 파일 본문, 업로드 파일, 문서 전체 검색은 별도 파일/지식 검색 범위다.

`memory_search`는 빠른 continuity handoff 요약용이다. `memory_search` 결과만으로 부족하거나 정확한 원문·인용·세션/메시지 증거가 필요하면 자연스럽게 `/search <keyword>`로 이어간다.

`/memory`는 직접 노출하지 않는다. 과거 맥락을 찾을 때는 `/search`가 기본이다. `/search memory <keyword>`는 별도 legacy DB가 아니라 first-party `memory_search`로 Tower PG continuity card만 좁혀 보는 보조 모드다.

## 세션 참조 출력 규칙

사람이 바로 찾을 수 있도록 세션을 raw UUID로 앞세우지 않는다. 모든 세션 참조는 가능하면 다음 형식을 쓴다:

```markdown
[<projectName 또는 cwd basename> · <sessionName>](https://<current-tower-host>/s/<shortCode 또는 UUID>)
```

- `conversation_search` 결과의 `projectName`, `sessionShortCode`, `sessionName`, `sessionId`를 우선 사용한다.
- 링크 key는 `sessionShortCode`가 있으면 그것을, 없으면 `sessionId`를 쓴다.
- host는 `conversation_search`가 제공하는 링크를 그대로 쓴다. 특정 VM이 아닌 문서에서 `app.example.com` 같은 고정 host를 박지 않는다.
- `projectName`이 없으면 `(no project)`로 표시하고, raw UUID는 디버깅이 필요할 때만 별도 줄에 짧게 붙인다.

## 사용법

```
/search <keyword>           — PostgreSQL 대화 검색: memory cards + 세션 이름/요약 + 메시지 본문
/search recent [N]          — 최근 세션 목록은 first-party tool이 생길 때까지 UI 안내 또는 admin 진단만
/search session <name>      — conversation_search로 특정 세션 후보와 근거 요약
/search stats               — admin/operator 진단 전용 DB 통계
/search memory <keyword>    — first-party memory_search로 continuity card만 좁혀 확인
```

## 공통: 인증/실행 경계

일반 고객/member Project 세션에서는 실행환경과 무관하게 host `.env`에서 `JWT_SECRET`을 읽거나 임의 JWT를 생성하지 않는다. `/search`의 기본 실행 경로는 **first-party `conversation_search` tool**이다. 이 도구는 현재 Tower 사용자/프로젝트 권한을 서버가 closure로 주입하므로 API 토큰을 묻거나 curl로 `/api/search`를 직접 호출하지 않는다.

가능한 경로는 다음 순서다:

1. `conversation_search` tool — 기본 경로. memory/session/message 검색을 현재 사용자 권한으로 실행한다.
2. `memory_search` tool — 빠른 continuity memory만 필요할 때 보조 경로.
3. admin/operator 진단 세션에서만 backend 권한 경계 안의 DB/API를 사용한다.
4. 권한 컨텍스트가 없으면 사용자가 직접 사이드바/검색 UI에서 찾도록 안내한다.

토큰 값, `.env` 내용, secret 값을 출력하지 않는다. 예시 curl은 admin/operator 진단 fallback일 때만 사용한다.

## Execution

`$ARGUMENTS`를 파싱하여 아래 모드 중 하나를 실행한다.

---

### 모드 1: 키워드 검색 (`/search <keyword>`)

`$ARGUMENTS`가 `recent`, `session`, `stats`, `memory`로 시작하지 않으면 전체를 키워드로 사용.

**Step 1: 섹션별 검색**

첫 쿼리는 자연어 문장 전체보다 기억나는 고유 구절이나 2~4개 핵심 명사로 짧게 만든다. 결과가 약하면 단어를 더 붙이지 말고 한 개 고유 구절로 줄이거나 한글·영문 제품명을 바꿔 최대 2회만 재검색한다. 현재 세션이 검색 예시를 포함해 자기 자신을 매칭할 수 있으므로, 과거 맥락을 찾을 때는 현재 세션 hit를 우선 근거로 단정하지 않는다.

기본 검색은 `conversation_search` tool을 사용한다. memory/session/message를 각각 top-N으로 가져오며, `limit` 하나로 섞어 자르지 않는다.

```text
conversation_search({
  query: "<keyword>",
  work_limit: 8,
  memory_limit: 8,
  session_limit: 8,
  message_limit: 20,
  scope: "current_project"
})
```

더 깊게 보려면 `deep: true`를 쓰고, archived/history까지 필요하면 `include_archived: true`를 추가한다.

```text
conversation_search({
  query: "<keyword>",
  deep: true,
  include_archived: true,
  scope: "all_accessible"
})
```

**Step 2: 결과 분석 및 표시**

검색 결과 JSON 배열에서:
- `type: "work"` → Work Ledger의 구조화된 업무 매칭. 같은 업무의 TodoWrite·Work Summary는 대표 업무 하나로 묶고 출처와 raw 기록 수를 남긴다.
- `type: "memory_card"` → `session_memory_cards` continuity memory 매칭
- `type: "session"` → 세션 이름/summary 매칭
- `type: "message"` → 메시지 본문 매칭

세션별로 그룹핑하여 표시:

```markdown
## 🔍 "<keyword>" 검색 결과

### Memory cards — 이어받을 만한 정제 기억

#### [<projectName> · <memoryTitle 또는 sessionName>](https://<current-tower-host>/s/<sessionShortCode-or-sessionId>) (<date>)
- **기억 매칭**: <snippet>
- **다음 액션**: <memoryNextActions if present>
- **주의**: <memoryCautions if present>

### Sessions / messages — 원문 근거

#### [<projectName> · <sessionName>](https://<current-tower-host>/s/<sessionShortCode-or-sessionId>) (<date>)
- **세션 매칭**: <snippet from session match>
- **메시지 매칭** (N건):
  - `<role>`: <snippet> (<date>)
  - `<role>`: <snippet> (<date>)

---
총 N개 세션에서 M건 발견
```

**Step 3: 맥락 심화 (선택적)**

가장 관련 높은 세션 1~2개는 `conversation_search`가 반환한 message evidence를 우선 사용한다. 더 많은 원문이 필요하면 반환된 `sessionId`로 `session_transcript_read`를 호출한다. 대상 세션을 재개하거나 메시지를 보내지 않으며, 접근 가능한 화면 표시용 user/assistant 대화만 읽는다.

---

### 모드 2: 최근 세션 (`/search recent [N]`)

현재 이 스킬에는 최근 세션 전체 목록을 안전하게 가져오는 first-party tool이 없다. 일반 Project 세션에서는 raw API/curl로 우회하지 말고 사이드바의 최근 세션/검색 UI를 안내한다. admin/operator 진단 세션에서만 DB/API fallback으로 최근 세션을 확인할 수 있다. first-party `conversation_recent` 같은 도구가 생기면 이 모드를 tool-backed로 되살린다.

표시 형식:

```markdown
## 📋 최근 세션 (N개)

| # | 세션 | 날짜 | 요약 | 턴 | 비용 |
|---|------|------|------|-----|------|
| 1 | [<projectName> · <name>](https://<current-tower-host>/s/<linkKey>) | <date> | <summary> | <turnCount> | $<cost> |
| 2 | ... | ... | ... | ... | ... |
```

---

### 모드 3: 세션 상세 (`/search session <name>`)

**Step 1: 세션 검색**

세션 이름으로 `conversation_search`를 실행한다.

```text
conversation_search({
  query: "<name>",
  session_limit: 10,
  memory_limit: 1,
  message_limit: 1
})
```

매칭된 세션이 여러 개면 목록을 보여주고 유저에게 선택을 요청한다. 하나면 바로 진행한다.

**Step 2: 대화 요약**

`conversation_search`가 반환한 memory/session/message evidence로 후보를 고른다. 세션 전체 원문이 필요하면 선택된 `sessionId`를 `session_transcript_read`에 넘겨 읽고 요약한다. raw API/curl은 admin/operator 진단 fallback으로만 사용한다.


메시지를 읽고 다음을 종합:

```markdown
## 💬 세션: [<projectName> · <sessionName>](https://<current-tower-host>/s/<sessionShortCode-or-sessionId>)

**날짜**: <date>
**턴 수**: <turnCount> | **비용**: $<cost>
**요약**: <summary>

### 대화 흐름
1. 👤 유저가 <topic>에 대해 질문
2. 🤖 AI가 <response summary>
3. 👤 유저가 <follow-up>

### 주요 결정/작업
- <key decision or action taken>
- <files modified or created>

### 결론
<what was the outcome, any pending items>
```

---

### 모드 4: 통계 (`/search stats`)

통계는 아직 first-party tool이 없다. 권한 있는 admin/operator 진단 세션에서만 DB/API로 세션·메시지·memory card 통계를 확인한다. 일반 프로젝트 세션에서는 raw API/curl로 우회하지 말고 검색 UI 또는 `conversation_search` 결과 범위 안에서만 답한다.

표시 예시:

```markdown
## 📊 Tower conversation-search 통계

| 항목 | 값 |
|------|-----|
| 총 세션 수 | N |
| 총 메시지 수 | N |
| 최근 24h 세션 | N |
| 최근 24h 메시지 | N |
| 성공 memory card | N |
| 최신 메시지 | YYYY-MM-DD HH:mm |
| 최신 memory card | YYYY-MM-DD HH:mm |
```

---

### 모드 5: memory card 집중 검색 (`/search memory <keyword>`)

`/memory` 스킬이나 host-side hook을 직접 호출하지 않는다. 사용자가 “메모리 카드만 봐줘” 또는 `/search memory ...`를 명시한 경우 first-party `memory_search` tool로 Tower PG continuity card를 검색한다.

```text
memory_search({
  query: "<keyword>",
  scope: "current_project",
  limit: 5
})
```

출력 시 반드시 다음을 명시한다:

```markdown
### Memory card 검색 결과

아래 결과는 continuity summary라 요약 손실 가능성이 있습니다. 정확한 원문 근거가 필요하면 conversation-search로 세션을 찾은 뒤 `session_transcript_read`로 확인합니다.

- <date/type>: <candidate>
```

memory_search가 없거나 결과가 없으면 실패 자체를 문제로 키우지 말고 “대화 검색만 사용”으로 처리한다.

---

## 인자 없음 (`/search`)

사용법 안내만 보여준다. 안전한 first-party 최근 세션 목록 도구가 생기기 전에는 `recent 5`를 자동 실행하지 않는다.

```markdown
## /search — conversation-search / 과거 대화 맥락 검색

| 명령 | 설명 |
|------|------|
| `/search <keyword>` | PostgreSQL conversation-search |
| `/search recent [N]` | 최근 N개 세션 (기본 10) |
| `/search session <name>` | 세션 상세 조회 |
| `/search stats` | 검색/세션 통계 |
| `/search memory <keyword>` | continuity memory card 집중 검색 |
```

## Rules

- 검색 결과가 0건이면 더 짧은 키워드나 정확한 고유명사를 제안한다. 최근 세션 목록은 first-party 도구가 없으므로 자동 대체하지 않는다.
- session/message 섹션은 각 섹션의 `tsvector` 결과가 없을 때 해당 섹션만 `pg_trgm`/`ILIKE`로 보완한다. Work Ledger와 memory card는 현재 `tsvector` 전용이다.
- Work Ledger 검색 결과는 상태·출처·결과·Todo·산출물·남은 일을 우선 보여주고, 중요한 판단은 연결된 세션 transcript로 확인한다.
- 메시지 content는 JSON 문자열일 수 있다. 표시 전에 텍스트만 추출한다.
- 비용은 소수점 4자리까지 표시 ($0.0000).
- 날짜는 한국 시간 기준 YYYY-MM-DD HH:mm 형식으로 표시.
- 권한/인증이 없어서 API 호출이 안 되면 내부 우회를 시도하지 말고 사이드바 검색 UI 사용을 안내한다.

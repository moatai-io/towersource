---
name: search
description: >
  Conversation-search for Tower: search past conversations, sessions, and structured session-memory cards.
  Use when the user says "/search", "conversation-search", "knowledge-search", "과거 대화 찾아", "search sessions",
  "what did we discuss about X", "저번에 말한 거", "기억나?", or wants to find past context from Tower.
  Complements memory_search: use memory_search first for concise continuity handoff summaries, then /search when exact raw messages, quotes, session-level results, or broader conversation evidence is needed. This skill supersedes the old /memory lookup path; prefer Tower PostgreSQL session_memory_cards first, then conversation search, and use legacy memory DB only as a fallback signal.
argument-hint: "<keyword> | recent [N] | session <name> | stats | memory <keyword>"
version: 1.1.1
---

# /search — conversation-search / 과거 대화 맥락 검색

Tower의 PostgreSQL 검색 API를 사용해 `session_memory_cards`, 세션 이름/요약, 메시지 본문을 함께 탐색한다. 제품/프롬프트 설명에서는 이 스킬을 **conversation-search**라고 부른다. 명령어 이름은 호환성을 위해 `/search`를 유지한다.

현재 검색 서비스의 실제 구현은 `packages/backend/services/workspace/search.ts` 기준이다.

- Primary path: PostgreSQL `tsvector` + GIN index (`simple` config, `websearch_to_tsquery`).
- Fallback: 결과가 전혀 없을 때만 `pg_trgm`/`ILIKE` 보조 검색.
- 검색 섹션: `memory_card` → `session` → `message`.
- 기본 범위: archived/history 세션은 제외. 필요할 때 `includeArchived=1`을 명시한다.
- 주의: 이 스킬은 **대화/세션 검색**이다. 워크스페이스 파일 본문, 업로드 파일, 문서 전체 검색은 별도 파일/지식 검색 범위다.

`memory_search`는 빠른 continuity handoff 요약용이다. `memory_search` 결과만으로 부족하거나 정확한 원문·인용·세션/메시지 증거가 필요하면 자연스럽게 `/search <keyword>`로 이어간다.

`/memory`는 직접 노출하지 않는다. 과거 맥락을 찾을 때는 `/search`가 기본이며, 필요할 때만 legacy memory DB / hook 자동 캡처 흔적을 **보조 소스**로 확인한다. legacy memory DB는 누락·오염 가능성이 있으므로 Tower PG memory card와 대화 검색 결과보다 낮은 신뢰도로 표시한다.

## 세션 참조 출력 규칙

사람이 바로 찾을 수 있도록 세션을 raw UUID로 앞세우지 않는다. 모든 세션 참조는 가능하면 다음 형식을 쓴다:

```markdown
[<projectName 또는 cwd basename> · <sessionName>](https://<current-tower-host>/s/<shortCode 또는 UUID>)
```

- `/api/search` 결과의 `projectName`, `sessionShortCode`, `sessionName`, `sessionId`를 우선 사용한다.
- 링크 key는 `sessionShortCode`가 있으면 그것을, 없으면 `sessionId`를 쓴다.
- host는 현재 Tower 서버의 public host를 사용한다. 특정 VM이 아닌 문서에서 `desk.tower.example.com` 같은 고정 host를 박지 않는다.
- `projectName`이 없으면 세션의 `projectId`를 `/api/projects` 결과와 조인하거나, 그래도 없으면 cwd basename/`(no project)`로 표시한다.
- raw UUID는 디버깅이 필요할 때만 별도 줄에 짧게 붙인다.

## 사용법

```
/search <keyword>           — PostgreSQL 대화 검색: memory cards + 세션 이름/요약 + 메시지 본문
/search recent [N]          — 최근 N개 세션 요약 타임라인 (기본 10)
/search session <name>      — 특정 세션 찾아서 대화 내용 요약
/search stats               — DB 통계 (세션/메시지 수, memory card 수 등)
/search memory <keyword>    — 보조 소스: legacy memory DB에서 낮은 신뢰도 후보 확인
```

## 공통: 인증/실행 경계

Project Runtime Box 또는 고객/member 프로젝트 세션에서는 host `.env`에서 `JWT_SECRET`을 읽거나 임의 JWT를 생성하지 않는다. 가능한 경로는 다음 중 하나다:

1. Tower가 현재 세션에 제공한 first-party search 기능/내부 API 컨텍스트를 사용한다.
2. admin/operator 진단 세션에서만 backend 권한 경계 안의 DB/API를 사용한다.
3. 권한 컨텍스트가 없으면 사용자가 직접 사이드바/검색 UI에서 찾도록 안내한다.

토큰 값, `.env` 내용, secret 값을 출력하지 않는다. Tower 세션에서는 localhost/curl 예제를 실행하지 말고 `conversation_search`, `memory_search`, `session_transcript_read` first-party 도구를 사용한다. 아래 REST 흐름은 Tower 외부의 명시적 API client 환경에만 해당한다.

```text
External API client only:
BASE_URL=<explicit Tower API URL>
AUTH_HEADER=<client-owned authorization>
```

## Execution

`$ARGUMENTS`를 파싱하여 아래 모드 중 하나를 실행한다.

---

### 모드 1: 키워드 검색 (`/search <keyword>`)

`$ARGUMENTS`가 `recent`, `session`, `stats`, `memory`로 시작하지 않으면 전체를 키워드로 사용.

**Step 1: 섹션별 검색**

기본 검색은 memory/session/message를 각각 top-N으로 가져온다. `limit` 하나로 섞어 자르지 말고, 필요하면 섹션별 limit을 명시한다.

```bash
QUERY="<keyword>"
RESULTS=$(curl -s "$BASE_URL/search?q=$(echo "$QUERY" | jq -sRr @uri)&memoryLimit=8&sessionLimit=8&messageLimit=20" \
  "${AUTH_HEADER[@]}")
echo "$RESULTS" | jq .
```

더 깊게 보려면 `deep=1` 또는 섹션별 limit을 늘린다. archived/history까지 필요하면 `includeArchived=1`을 추가한다.

```bash
RESULTS=$(curl -s "$BASE_URL/search?q=$(echo "$QUERY" | jq -sRr @uri)&deep=1&limit=40&includeArchived=1" \
  "${AUTH_HEADER[@]}")
```

**Step 2: 결과 분석 및 표시**

검색 결과 JSON 배열에서:
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

가장 관련 높은 세션 1~2개에 대해 메시지를 추가 로드하여 전후 맥락을 제공:

```bash
SESSION_ID="<most relevant session id>"
MESSAGES=$(curl -s "$BASE_URL/sessions/$SESSION_ID/messages" \
  "${AUTH_HEADER[@]}")
echo "$MESSAGES" | jq '[.[] | select(.role == "user" or .role == "assistant") | {role, content: (.content | tostring | .[0:200]), created_at}] | .[-10:]'
```

이 메시지들을 읽고 대화 흐름을 요약한다.

---

### 모드 2: 최근 세션 (`/search recent [N]`)

N이 없으면 기본 10.

```bash
SESSIONS=$(curl -s "$BASE_URL/sessions" "${AUTH_HEADER[@]}")
PROJECTS=$(curl -s "$BASE_URL/projects" "${AUTH_HEADER[@]}")
# projectId ↔ project name 조인 후, linkKey = shortCode // id 로 표시 준비
echo "$SESSIONS" | jq --argjson projects "$PROJECTS" '.[:N] | map(. + {
  projectName: ((.projectId as $pid | $projects[]? | select(.id == $pid) | .name) // null),
  linkKey: (.shortCode // .id)
})'
```

결과를 표시:

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

세션 이름으로 검색:

```bash
QUERY="<name>"
RESULTS=$(curl -s "$BASE_URL/search?q=$(echo "$QUERY" | jq -sRr @uri)&sessionLimit=10&memoryLimit=1&messageLimit=1" \
  "${AUTH_HEADER[@]}")
echo "$RESULTS" | jq '[.[] | select(.type == "session")]'
```

매칭된 세션이 여러 개면 목록을 보여주고 유저에게 선택을 요청한다. 하나면 바로 진행한다.

**Step 2: 메시지 로드**

```bash
SESSION_ID="<selected session id>"
MESSAGES=$(curl -s "$BASE_URL/sessions/$SESSION_ID/messages" \
  "${AUTH_HEADER[@]}")
echo "$MESSAGES" | jq '[.[] | select(.role == "user" or .role == "assistant") | {role, content: (.content | tostring | .[0:300]), created_at}]'
```

**Step 3: 대화 요약**

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

권한 있는 admin/operator 진단 세션에서는 DB/API로 세션·메시지·memory card 통계를 확인한다. 일반 프로젝트 세션에서는 `/api/sessions` 등 허용된 API 응답 범위 안에서만 통계를 낸다.

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

### 모드 5: legacy memory 보조 검색 (`/search memory <keyword>`)

`/memory` 스킬이나 host-side Claude hook을 직접 호출하지 않는다. 먼저 `conversation_search`를 실행하고, 사용자가 “메모리까지 봐줘” 또는 `/search memory ...`를 명시한 경우에만 `memory_search`를 낮은 신뢰도의 보조 후보로 호출한다.

출력 시 반드시 다음을 명시한다:

```markdown
### Legacy memory 보조 후보

아래 결과는 hook 자동 캡처 기반이라 누락·오염 가능성이 있습니다. 확정 맥락은 Tower PG conversation-search 결과를 우선합니다.

- <date/type>: <candidate>
```

memory DB가 없거나 helper가 실패하면 실패 자체를 문제로 키우지 말고 “대화 검색만 사용”으로 처리한다.

---

## 인자 없음 (`/search`)

사용법 안내를 보여주고, 기본으로 `recent 5`를 실행한다.

```markdown
## /search — conversation-search / 과거 대화 맥락 검색

| 명령 | 설명 |
|------|------|
| `/search <keyword>` | PostgreSQL conversation-search |
| `/search recent [N]` | 최근 N개 세션 (기본 10) |
| `/search session <name>` | 세션 상세 조회 |
| `/search stats` | 검색/세션 통계 |
| `/search memory <keyword>` | legacy memory 보조 검색 |
```

## Rules

- 검색 결과가 0건이면 다른 키워드를 제안하거나, 최근 세션 목록을 대신 보여준다.
- 결과가 일부라도 있으면 `pg_trgm` fallback이 자동으로 섞이지 않을 수 있다. 부분 문자열/한글 어미/비슷한 표현에서 누락이 의심되면 더 짧은 키워드나 정확한 고유명사를 다시 시도한다.
- 메시지 content는 JSON 문자열일 수 있다. 표시 전에 텍스트만 추출한다.
- 비용은 소수점 4자리까지 표시 ($0.0000).
- 날짜는 한국 시간 기준 YYYY-MM-DD HH:mm 형식으로 표시.
- 권한/인증이 없어서 API 호출이 안 되면 내부 우회를 시도하지 말고 사이드바 검색 UI 사용을 안내한다.

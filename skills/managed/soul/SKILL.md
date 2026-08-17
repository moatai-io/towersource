---
name: soul
description: |
  SOUL.md (프로젝트 정체성 · 북극성 · 가치 · 경계) 를 안전하게 채우거나 갱신하는 스킬.
  Brownfield 우선 — 기존 .project/progress.md, decisions/, memory/, AGENTS.md 를 먼저
  흡수. AI 가 답을 임의 생성하지 않고 사용자 답 / 대화 단서만 기록.

  ⚡ 자동 발동 트리거 (사용자가 명시 호출 안 해도 AI 가 의식적으로 호출):

  **CASE 1 — 새 프로젝트 첫 메시지 직후 (가장 중요)**
  사용자의 *첫 응답*이 자기 프로젝트 / 역할 / 톤 / 가치 / 경계 단서를 담고 있으면
  즉시 발동. 예시 매칭 패턴:
  - "주로 ~ 위주야" / "~ 만들 거야" / "~ 분석할 거야" (역할·작업)
  - "임원용", "고객사용", "사내", "외부" (audience)
  - "PPTX / PDF / 한국어 우선 / 영문 병기" (형식·언어 선호)
  - "정확성 / 간결성 / 신속성 / 친절함" (가치 톤)
  - "~ 는 안 해", "~ 빼고" (경계)
  → 이 신호 중 하나라도 있으면 SOUL.md 의 TBD 슬롯 채우기 발동.

  **CASE 2 — 기존 SOUL 이 있는데 충돌 / 보강 신호**
  사용자가 SOUL §3 가치 / §4 경계와 다른 결정을 내리거나, 새 패턴이 명확해질 때
  → /soul update 모드로 슬롯 한 개 갱신.

  **CASE 3 — 사용자 명시 호출**
  "/soul", "정체성 채워", "북극성 정해", "프로젝트 가치 박아", "SOUL 만들어"
  → 풀 인터뷰 모드.

  ⚠️ AI 가 사용자 메시지에 답변하면서 *동시에* 이 스킬 발동 가능. 답변 모드와
  스킬 발동은 둘 다 일어날 수 있다. "지금 답변 우선이라 SOUL 은 나중" 으로
  미루지 말 것 — 사용자 답이 신호를 담고 있으면 *그 자리에서* 스킬 발동.

  Use modes:
  - /soul             — 풀 점진 인터뷰 (한 슬롯씩, "여기까지" 시 즉시 종료)
  - /soul nudge       — **가장 자주 쓰임** — 대화 단서 한 줄을 SOUL.md 슬롯에 박기.
                        풀 인터뷰 X, 추출+박기+짧은 컨펌만. CASE 1 자동 발동의 기본 모드.
  - /soul update      — 이미 채워진 슬롯 갱신 (어떤 슬롯인지 묻고 변경, decisions 기록)
  - /soul fill        — 강제 풀 인터뷰 (TBD 가 없어도 처음부터)
  - /soul consolidate — MISSION/NORTH_STAR/PRINCIPLES 같은 4파일을 SOUL 1파일로 합침
  - /soul check       — 인터뷰 없이 현재 SOUL 의 신선도 · TBD 잔존 보고

  핵심 정신: 한 번에 다 채울 필요 없음. 사용자가 박을 준비된 만큼만, 나머지는
  TBD. 일하면서 자연스럽게 누적. 사용자에게 SOUL · 정체성 · 북극성 같은 추상어
  노출 X — "톤", "어떤 일", "방향" 같은 평이한 표현.

  Companion to: agents-md (운영 매뉴얼 진화), claude-md (Claude 전용 규칙).
  근거: workspace/decisions/2026-05-03-soul-md-introduction.md
---

# /soul — 프로젝트 정체성 인터뷰 스킬

> "Mission 은 달 착륙. Soul 은 우리가 선택하는 톤·가치·경계."
> SOUL.md 는 매 세션 system prompt 에 들어가는 stable layer. 작고 잘 안 변해야 한다.

## Phase 0 — 컨텍스트 결정

가장 먼저 **어느 SOUL.md 를 다루는지** 결정한다.

```
스코프 결정 트리:
  현재 작업 디렉토리가 workspace/projects/<slug>/ 안 → 프로젝트 SOUL
  현재 작업 디렉토리가 workspace/ 루트          → 워크스페이스 SOUL
  애매하면 사용자에게 한 번 묻는다.
```

대상 결정 후 다음 경로 둘 중 하나를 잡는다:
- 프로젝트 SOUL: `workspace/projects/<slug>/SOUL.md`
- 워크스페이스 SOUL: `workspace/SOUL.md`

## Phase 1 — 상태 진단 (READ-ONLY)

대상 파일이 (a) 없음 / (b) 있고 TBD 잔존 / (c) 있고 채워져 있음 — 셋 중 어느 상태인지 확인.

```
case (a) 없음:
  → 사용자에게 "정체성 파일을 만들까요?" 한 번 컨펌 후 templates/workspace/SOUL.template.md
    구조로 새로 작성. Brownfield 흡수 (Phase 2) 진입.

case (b) TBD 잔존:
  → 어느 슬롯이 비었는지 사용자에게 보여주고, 비어있는 슬롯만 인터뷰 진행.
    이미 채워진 슬롯은 건드리지 않는다 (사용자가 명시적으로 "다시 정해" 라고 했을 때만 덮어씀).

case (c) 다 채워짐:
  → /soul check 모드만 진행. "마지막 변경 X일 전, 신선도 OK" 로 종료.
    사용자가 /soul fill 을 명시적으로 호출했을 때만 강제 인터뷰.
```

## Phase 2 — Brownfield 흡수 (인터뷰 *전*에 먼저)

⚠️ **이게 이 스킬의 핵심.** 사용자에게 질문하기 전에 **이미 존재하는 메모리를 먼저 다 읽는다.**
이유: 이미 사용자가 손으로 박아둔 가치·경계가 있는 프로젝트는 그걸 흡수해 드래프트를 만들고
"이거 맞나요?" 형태로 진행해야 자연스럽다. 임의 생성은 금지지만, **이미 있는 글을 정리해 보여주는 것은 OK**.

읽을 소스 (있으면 읽음, 없으면 패스):

```
1. AGENTS.md / CLAUDE.md         — 운영적이지만 가끔 정체성 단편 섞임
2. .project/progress.md           — 무엇을 해왔는지 (어떤 가치를 실제로 따랐는지)
3. .project/decisions/*.md        — 결정의 근거에 자주 정체성이 박힘
4. memory/MEMORY.md (memkraft)    — 학습된 패턴
5. memory/notes.md, memory/SOUL.md(있다면 구버전)
6. publishing-steward 형 프로젝트라면 .project/MISSION.md / NORTH_STAR.md /
   PRINCIPLES.md / SCOPE.md 도 읽음
7. README.md (있다면)             — 외부 커뮤니케이션 톤 단서
```

읽고 나서 다음 4가지를 추출한다 (각 슬롯에 매핑):

| 슬롯 | 추출 단서 |
|---|---|
| 누구를 위한 것인가 | progress.md 에 자주 등장하는 사용자/이해관계자 이름, README 의 audience |
| North Star | decisions 의 반복 출현 가치 문장, MISSION/NORTH_STAR 가 이미 있으면 그것 |
| 가치 / 톤 | PRINCIPLES.md, decisions 의 rationale 문체, AGENTS.md communication 섹션 |
| 경계 (NOT this) | decisions 에 "❌" / "금지" / "안 함" 으로 박힌 항목 |

추출이 안 되면 빈 칸으로 두고 인터뷰에서 받는다 — **추측 금지**.

## Phase 3 — 점진 인터뷰 (한 번에 다 받지 마)

⚠️ **이 스킬은 "5질문 다 채우기" 가 목표가 아니다. "사용자가 박을 준비된 만큼만 박기" 가 목표.**

### 점진 채움 규칙 (강제)

- **한 질문씩**. 5질문 한 번에 묶어서 던지지 말 것 (사용자 부담 큼).
- 매 답변 후 **"계속할까요? 아니면 여기까지 둘까요?"** 한 번 묻는다 — 사용자
  이미 피곤할 수 있고, 한두 슬롯만 박고 일하다가 나중에 더 채우는 게 자연스럽다.
- 사용자가 **"여기까지 / 충분 / 그만 / 다음에 / 일단 됐어"** 류로 답하면
  → **즉시 Phase 4 로 점프**. 채워진 슬롯만 저장. 빈 슬롯은 TBD 유지.
- 빈 TBD 가 남는 건 **실패가 아니라 정상**. 다음 세션에서 자연스럽게 또
  여쭤볼 수 있다 (AGENTS.md 의 "은은한 nudge" 규칙).
- 한 슬롯이 완벽하지 않아도 된다 — 사용자가 "이 정도면 됐어" 하면 그 답으로 박는다.

### 질문 템플릿

각 질문은 다음 3가지 형태 중 적절한 걸 고른다:

```
형태 A — 빈 슬롯 (추출 단서 없음):
  "이 프로젝트는 누구를 위한 거예요? 한 줄로 답해주세요.
   (예: 'demo-org SI 컨설턴트', '리서치 데스크 펀드매니저', '내부 운영팀')"

형태 B — 추출 드래프트 컨펌:
  "기존 progress.md 와 decisions 를 보니 이 프로젝트의 사용자는
   '한국투자신탁운용 리서치 데스크' 로 보입니다.
   맞나요? 더 좁히거나 다르면 알려주세요."

형태 C — 추출 단서 다수 충돌:
  "decisions 에서 두 가지 다른 사용자 그룹이 보입니다:
   (1) 펀드매니저 (2) 고객사 RM. 어느 쪽이 1순위인가요?"
```

### 5가지 질문 (필요한 슬롯만)

1. **누구를 위한 것인가** — 한 줄. 너무 넓으면 좁히도록 도움 ("팀 전체" → "어느 역할?").
2. **성공은 무엇인가 (North Star)** — 측정 가능한 한 문장 권장. 측정 어려우면 "어떻게 알 수 있나" 보조 질문.
3. **가치 / 톤 3-5개** — 충돌 시 우선순위 기준이 되는 것. 예시 카드 제시 가능.
4. **경계 (절대 안 함)** — "이 프로젝트가 *아닌* 것" 명시. 거절의 근거가 됨.
5. **살아있는 참조** — 보통 자동 채움 (AGENTS.md, decisions/, memory/ 경로). 사용자 컨펌만.

## Phase 4 — Draft 생성 + 사용자 컨펌

답변을 종합해 SOUL.md 드래프트를 보여준다. **그대로 저장하지 않고 한 번 더 컨펌 받는다.**

```
"다음 내용으로 SOUL.md 를 작성하겠습니다. 검토해주세요:

  ## 1. 누구를 위한 것인가
  demo-org SI 컨설턴트와 그들이 담당하는 enterprise 고객사

  ## 2. North Star
  신규 onboarding 이 3시간 안에 끝나거나, 못 끝났을 때 그 이유가 60초 안에 자명하다.

  ## 3. 가치 / 톤
  - 한국어 우선, 기술 용어는 영문 병기
  - 정확성 > 친절함
  - 사용자 자주성 존중
  - 결정은 글로 (구두 합의 금지)

  ## 4. 경계
  - ❌ 컨설턴트 동의 없이 고객사 데이터에 접근
  - ❌ 단일 의견으로 정책 변경

저장할까요? 수정할까요?"
```

사용자 OK 후에만 Write. 수정 요청 시 해당 슬롯만 다시 묻고 다시 컨펌.

### 부분 저장 OK

일부 슬롯만 채워진 상태로 저장하는 건 정상이다. 저장 시:

- 채워진 슬롯 → 사용자 답으로 박음
- 비어있는 슬롯 → \`TBD\` 그대로 유지 (지우지 말 것 — 다음 nudge / \`/soul\` 호출에서 또 채울 수 있도록 신호 남김)
- 드래프트 표시할 때 명확히: "§1, §2 만 채워서 저장합니다. §3, §4, §5 는 다음에 채워둘게요"

이건 "정체성을 박는다" 의 자연스러운 그림이다 — 사람도 자기 가치관을 한 번에
글로 옮기지 못한다. 일하다가 부딪히면서 발견하는 것.

## Phase 5 — 후속 작업

저장 후 자동으로:

1. **decisions 기록**: `.project/decisions/YYYY-MM-DD-soul-initial-fill.md` 작성
   (또는 갱신이면 `-soul-update-N.md`). 변경 사유 한 줄.
2. **AGENTS.md 검사**: SOUL.md 참조 라인이 있는지. 없으면 추가 제안 (편집 안 하고 사용자에게 안내).
3. **progress.md 한 줄 추가**: `- YYYY-MM-DD: SOUL.md 초기 채움 (/soul 인터뷰)` 또는 갱신 시 `갱신`.

## Mode: /soul consolidate (publishing-steward 형)

`.project/` 안에 MISSION.md / NORTH_STAR.md / PRINCIPLES.md / SCOPE.md 같은
정체성 단편 파일이 따로 있는 프로젝트는:

1. 후보 파일 다 읽고 SOUL.md 의 5슬롯에 잠정 매핑.

2. **🛑 통합 안전 검사 (각 후보 파일에 대해 필수)** — publishing-steward 첫 시연(2026-05-03)에서
   무차별 합치기가 정보 손실을 만든다는 것이 드러남. 다음 신호 중 **하나라도** 해당되면
   "통합 제외 후보" 로 분류:

   **a. 헤더 표식 검사** — 파일 처음 5줄에 다음 표현 있는가?
      - `tenant-specific` / `테넌트별로 다르다` / `테넌트마다 다름`
      - `자라나는` / `evolving` / `growing document` / `living document`
      - `사람만 수정` / `human only` / `do not auto-edit`
      - `덮어쓰지 말 것` / `do not overwrite`

   **b. git 커밋 빈도 검사** — 최근 90일 커밋 수:
      ```bash
      git log --since=90.days --oneline -- <file> | wc -l
      ```
      3 이상이면 evolving 의심.

   둘 중 하나 해당 시 사용자에게 보고:
   ```
   "다음 파일은 통합 부적절합니다 — 별도 유지를 권장:
    - SCOPE.md  (이유: 'tenant-specific' 헤더 표식)
    - PRINCIPLES.md  (이유: '자라나는 문서' 표식 + 최근 7회 커밋)
   합칠 파일: MISSION.md, NORTH_STAR.md
   이대로 진행할까요? (제외된 파일은 SOUL §5 살아있는 참조에 ⚠️ 표시로 명시)"
   ```

3. 매핑 결과 + 제외 사유 사용자에게 보여주고 컨펌. (안 묻고 진행 금지)

4. **합치기로 한 파일만** SOUL.md 로 통합. 제외된 파일은 그대로 유지하되,
   SOUL §5 살아있는 참조 섹션에 그 파일이 evolving / tenant-specific 임을 명시.

5. 통합된 원본 파일은 **삭제하지 않음**. 두 옵션 중 사용자 선택:
   - **유지**: 원본을 권한 source 로 두고 SOUL 은 사본 layer (publishing-steward 방식 — 추천)
   - **deprecated 표식**: 원본 첫 줄에 다음 추가 후 사용자가 "지워도 돼" 할 때까지 보관
     ```
     <!-- DEPRECATED YYYY-MM-DD: SOUL.md 로 통합됨. 원본 보존용. -->
     ```

6. CLAUDE.md / AGENTS.md 의 "매 루프 시작 시 읽기" 또는 비슷한 로딩 순서 섹션이 있으면
   `SOUL.md` 를 0번으로 prepend 제안 (사용자 컨펌 필수, 자동 편집 X).

## Mode: /soul update (이미 채워진 슬롯 갱신)

SOUL.md 가 다 채워진(또는 부분 채워진) 상태에서 사용자가 특정 슬롯을 바꾸고 싶을 때:

1. 사용자에게 **어느 슬롯**인지 묻는다 (1-5 또는 슬롯 이름).
2. 현재 그 슬롯의 내용 보여주고 → 새 내용 받음 → 컨펌.
3. SOUL.md 갱신.
4. \`.project/decisions/YYYY-MM-DD-soul-update-NN.md\` 에 변경 근거 기록 (NN 은
   그 날의 N번째 갱신). 포맷:
   - **Slot**: §3 가치 / §4 경계 / 등
   - **Before / After**
   - **Why**: 한 줄. 어떤 사건이 이 갱신을 촉발했는가.
5. \`.project/progress.md\` 한 줄 추가.
6. 갱신이 분기 1회 이상 빈번해지면 사용자에게 알림: "최근 90일 SOUL 갱신
   N회 — 이 슬롯이 정말 stable 한가요? 혹시 PRINCIPLES.md 같은 evolving
   문서로 옮길지 검토하시겠어요?"

### 대화 중 자연스러운 update 트리거

평소 대화에서 사용자가 SOUL 의 어느 슬롯과 충돌하는 결정을 내리면 답변 끝에 한 줄 제안:

- "이번 결정이 SOUL §3 의 '정확성 > 친절함' 과 다르게 보이는데, SOUL 을 갱신할까요 아니면 이번만 예외로 둘까요?"
- "지금 거절하신 요청, §4 경계에 추가할 만한 패턴인 것 같아요. 박아둘까요?"

거절하면 다시 안 묻는다.

## Mode: /soul nudge (대화 흐름 중 슬롯 한 개 박기 — 가장 자주 발동)

⚡ **이 모드가 SOUL 시스템의 작동 엔진.** description 의 CASE 1 매칭 시 AI 가
의식적으로 호출. 사용자가 \`/soul nudge\` 라고 직접 입력하는 일은 거의 없음.

### 작동 절차 (의식적·짧게)

1. **사용자 메시지에서 슬롯 단서 추출** (Phase 2 의 매핑 표 참조).
   - 한 메시지에서 1-2개 슬롯이 보통. 모든 슬롯 한 번에 X.
2. **SOUL.md read** — 해당 슬롯이 정말 TBD 인지 확인 (이미 채워졌으면 update 모드로).
3. **SOUL.md write** — 추출한 내용으로 슬롯 박음.
4. **\`.project/progress.md\` 한 줄 append**:
   \`- YYYY-MM-DD: SOUL §X 박음 — '<요약>' (사용자 답에서 추출)\`
5. **(선택) \`.project/decisions/YYYY-MM-DD-soul-nudge-NN.md\`** — 첫 박힘일 때만 작성.
6. **사용자에게 *답변 안에 자연스럽게* 컨펌** — 별도 박스 X. 답변 마무리 톤으로:
   > "...(요청 답변)... 톤 박았어요 — 다음부터 임원용·간결·계층화로 갈게요."

### 절차 누락 금지 — "답변 모드 우선" 함정

⚠️ AI 가 *대답에 집중* 하느라 1-5 단계를 미루는 함정. 답변하면서 *동시에*
write 도구 호출. "지금은 답변만, SOUL 은 나중" 같은 자기 강등 X.

### 거절 처리

사용자가 명시적으로 "박지 마", "그냥 답변만" 류 표현 → 잊고 다음에. 절차 6의
컨펌 한 줄도 그 세션 동안 다시 안 함.

### 한도

한 세션 안에서 같은 슬롯에 한 번만. 매 메시지마다 SOUL 갱신 X (피로함).
세션당 1-3회가 자연스러움. 신호 없는 메시지에는 nudge 발동 X.

## Anti-patterns (이 스킬이 절대 하지 말 것)

1. ❌ **사용자 답 없이 추측해서 채움** — 추출 단서가 약하면 빈 칸 유지 + 다음 인터뷰로 미룸.
2. ❌ **이미 채워진 슬롯을 무단 덮어씀** — `/soul fill` 모드에서도 한 번 컨펌.
3. ❌ **decisions / memory 안 읽고 인터뷰 시작** — Brownfield 흡수가 핵심. 이거 빠지면 사용자가 "왜 이미 있는 걸 또 묻나" 느낌.
4. ❌ **AGENTS.md 운영 규칙을 SOUL 로 옮김** — 정책 vs 정체성 구분. SOUL 은 "왜·누구·경계" 만, AGENTS 는 "어떻게".
5. ❌ **자체 호스팅 서버 의 SOUL 에 우리 본 서버 SOUL 내용 복사** — 정체성 도용. 빈 슬롯으로 두거나 고객사 답으로만.
6. ❌ **자주 갱신** — 분기 1회 이하. 그 이상이면 그 변경은 SOUL 이 아니라 AGENTS / decisions 행.

## Output 형식

스킬 실행 종료 시:

```markdown
## SOUL.md 작업 완료

**대상**: workspace/projects/<slug>/SOUL.md
**모드**: 신규 작성 / 슬롯 N개 채움 / consolidate / check

**변경 슬롯**:
- 1. 누구를 위한 것인가: TBD → "..."
- 2. North Star: TBD → "..."
- 3. 가치 / 톤: 기존 유지

**근거 메모리**:
- progress.md 에서 N개 항목 흡수
- decisions/ 에서 N개 결정 흡수
- (있으면) MISSION.md → SOUL §2 로 매핑

**다음 단계**:
- decisions 기록: `.project/decisions/2026-05-03-soul-initial-fill.md`
- progress 한 줄 추가됨
- AGENTS.md 의 SOUL 참조 라인: ✅ 이미 있음 / ⚠️ 누락 (수동 추가 권장)
```

## References

- `workspace/decisions/2026-05-03-soul-md-introduction.md` — 도입 근거 + 안티패턴
- `templates/workspace/SOUL.template.md` — 빈 슬롯 템플릿 (워크스페이스 레벨)
- `packages/backend/services/project-manager.ts:renderProjectSoulMd()` — 자동 scaffold (프로젝트 레벨)
- `workspace/projects/publishing-steward/.project/` — consolidate 모드의 첫 사례
- [SoulSpec.org](https://soulspec.org/), [arXiv:2510.21413](https://arxiv.org/abs/2510.21413) — 업계 표준

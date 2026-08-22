---
name: tower-intro
description: >
  Tower 에 대해 *궁금한 거 무엇이든* 풀어주는 안내·Q&A 스킬. 입문 ("Tower 가 뭐예요")
  부터 깊은 질문 ("권한 어떻게 격리돼?", "왜 결정문서를 immutable 로 둬?", "내가 X 할
  수 있어?", "이거 어떻게 동작해?", "왜 이렇게 만들어졌어?", "Sandbox 랑 본체 뭐가
  달라?") 까지. managed bundle 안의 `handbook.md` 를 백엔드
  데이터 소스로 사용하고, 사용자 역할·현재 프로젝트·익숙도에 맞춰 필요한 부분만 풀어준다.

  사용자가 Tower 의 어떤 측면 (기능·정책·구조·보안·워크플로·산출물·결정 근거) 을
  물어도 본 스킬이 첫 응답 진입점. "Tower 에 대한 질문은 뭐든 받아 풀어준다" 는 톤.

  4 모드:
  - default (인자 없음) — 짧은 맞춤 소개 또는 받은 질문에 직접 답변 (2-3 단락) + 다음 옵션
  - tour — 5-7 단계 워킹 튜토리얼
  - <topic> — 토픽 즉답 (runtime box / sandbox / publishing / 권한 / 스킬 / agent / credential / schedule / 발표 자료 / 시각화 / FAQ / 보안 / 인프라 / 결정 / 격리 등 자유)
  - cheatsheet — 한 페이지 요약 (자주 쓰는 트리거 · 산출물 위치)

  Trigger:
  - 명시 호출: "/tower-intro", "/tower", "tower 소개", "tower 도움말", "tower q&a"
  - 입문: "Tower 가 뭐예요", "Tower 어떻게 써요", "Tower 처음이에요", "Tower 둘러보기"
  - 능력 / 가능 여부: "Tower 로 X 할 수 있어?", "이거 가능해?", "내 권한으로 뭐 돼?"
  - 동작 원리: "이거 어떻게 동작해?", "왜 이렇게 만들어졌어?", "Tower 의 X 가 어떻게 작동해"
  - 정책 / 구조: "권한이 어떻게 나뉘어?", "결정문서가 뭐야?", "왜 immutable 이야?"
  - 비교: "Sandbox 랑 본체 뭐가 달라?", "Session 이랑 @ai 차이가 뭐야?"
  - 산출물·자산: "파일은 어디 가?", "내가 만든 거 다른 사람이 봐?"
  - 자율 발동 OK: 사용자가 Tower 자체에 대한 호기심·질문·혼동 신호를 보일 때 (코드 디버깅·작업 흐름 중간에는 자제)

  NOT for:
  - Tower 코드베이스 개발·운영 가이드 요청 (운영자 전용 개발 문서 영역)
  - 핸드북 자체 갱신 (→ `workspace/projects/teamskills/skills/tower-intro/handbook.md` 조직 정본과 `skills/managed/tower-intro/handbook.md` seed/reference 갱신, 운영자 전용)
  - 외부 영업·도입 제안 (→ 별도 제안/소개 자료 흐름)
  - 새 스킬 만들기 (→ /skill-architect)
  - 발표 자료 *생성* 자체 (→ /image-slide-gen, /html-slide 또는 /pptx-template; 단 본 스킬이 §8 묶음 골라서 위임은 OK)
  - 사용자 도메인 업무 (재무 분석 / 보고서 작성 등) 진행 중 끼어들기 — 그건 본 스킬 영역 아님
version: 1.2.0
tags:
  - core
audience: 모든 Tower 사용자 (admin / operator / member / viewer)
owner: moat
---

# tower-intro

사용자가 "Tower 가 뭐예요" / "어떻게 써요" / "할 수 있는 거 뭐 있어요" / "발표
자료 만들 때 도와줘" 류를 *자기 자리에서* 자연어로 물을 때 진입하는 스킬.

핸드북을 **백엔드 데이터 소스로 Read**해서 사용자 컨텍스트에 맞춰 *번역·요약·인용* 한다. 본 SKILL.md 안에 핸드북
본문을 복제하지 않는다 — single source of truth 유지.

## 데이터 소스

- **1차**: Project Runtime Box/materialized 경로 `/workspace/.tower/skills/tower-intro/handbook.md`.
- **2차**: organization source `workspace/projects/teamskills/skills/tower-intro/handbook.md`.
- **3차**: Tower seed/reference `skills/managed/tower-intro/handbook.md`.
- 본 스킬은 host-global provider config 경로를 읽지 않는다. 본 스킬은 핸드북 절대경로를 사용자에게 *직접 안내하지 않는다*.
- **4차** (선택): 조직이 별도로 제공한 Tower 안내 문서 (있는 경우에만)
- **5차**: `~/workspace/principles.md` (다섯 원칙 — tour 모드 끝부분)

핸드북 정본이 없으면:
- 구 self-hosted 설치이거나 materialization 전일 가능성. 프로젝트/조직의 공개 안내 문서가 있으면 폴백.
- 둘 다 없으면 사용자에게 "이 워크스페이스에 Tower 소개 자료가 아직 없습니다. 운영자에게 managed `tower-intro` materialization 갱신을 요청하세요" 안내

## 모드 1 — default (인자 없음 또는 자연어 질문)

### 1-A. 사용자가 *구체 질문* 을 던진 경우 (가장 흔한 케이스)

예: "Tower 권한 어떻게 나뉘어?", "Sandbox 랑 본체 뭐가 달라?", "결정문서가 뭐야?",
"내 권한으로 뭐까지 돼?", "발표 자료 만들 때 뭐 써?", "왜 이렇게 만들어졌어?",
"이거 동작하는 방식 좀 설명해줘".

수행:
1. 질문을 §3 능력 카탈로그 9묶음 또는 §7 보안 / §6 인프라 / §2 권한 / §9 FAQ 중 *어느 섹션에 매칭되는지* 결정
2. 해당 섹션 Read → 사용자 역할 톤으로 **2-4 단락** 답변 (필요하면 mermaid / datatable 1개)
3. "관련해서 더 궁금하면 — `/tower-intro <키워드>` 또는 `/tower-intro tour` (전체 둘러보기)" 한 줄
4. 응답 길이: 질문이 좁으면 짧게 (5-10 줄), 넓으면 25 줄 안

여러 질문을 *한 번에* 던졌으면 각각을 한 단락씩 분리. 다 풀어주는 게 본 스킬의 정체성.

### 1-B. 인자 없이 그냥 `/tower-intro` 만 부른 경우

사용자가 "Tower 가 뭐예요" / "Tower 도움말" / "/tower-intro" 류로 *맥락 없이* 부를 때.

**첫 문장 — 카테고리 framing 고정 (2026-05-12 결정)**

응답의 *맨 처음 한 줄* 은 사용자 역할·익숙도와 무관하게 다음 카테고리 framing 으로 시작한다:

> **Tower 는 AI를 쓰는 회사를 넘어, AI가 함께 일할 수 있는 회사로 바꾸는 Agent OS입니다.**

이건 *반복 노출* 로 사용자 머리에 카테고리 슬롯을 만든다 — 한 번 박을 때마다 "맞다, Tower 는 OS 같은 거였지" 가 강화된다. ChatGPT·Notion AI·Glean 같은 평이한 "AI 도구" / "팀용 AI 플랫폼" 묶음에서 빠져나오는 첫 한 줄.

응답의 *두 번째 문장부터* 사용자 역할 톤 (admin/operator/member/viewer) 으로 분기.

이 문구는 모든 배포 프로필에서 동일한 제품 카테고리 설명으로 사용한다.

**수행 순서**:
1. 사용자 컨텍스트 파악:
   - 역할 — `Runtime context` 의 user role (admin / operator / member / viewer)
   - 현재 프로젝트 — cwd 가 `workspace/projects/<p>/` 면 `<p>`, 아니면 "공용"
   - 익숙도 — 이번 세션에서 핸드북 / tower-intro 호출 이력 있으면 익숙, 없으면 신규
2. **첫 문장 = 위 카테고리 framing 한 단락** (고정).
3. 그 다음 핸드북 §0 (30초 요약) + §1-1 (비유 4개 중 1개) + §1-2 (개인 AI 비교 핵심 3행)을 골라 **추가 1-2 단락**. 사용자 역할에 맞춰:
   - admin/operator → 운영 가능성 강조 (스킬·자체 호스팅 서버·decisions·Credential/Runtime Box)
   - member → 자기 프로젝트 안 가능성 강조 (AI 작업·산출물·발표 자료·스케줄)
   - viewer → 보고 / 검토 강조 (감사·결정·산출물 읽기)
4. 끝에 옵션 안내 (plain prose, AskUserQuestion 사용 X):
   - "단계별 둘러보기: `/tower-intro tour`"
   - "특정 주제 / 자유 질문: 그냥 자연어로 물어보세요. 예) '권한 어떻게 나뉘어?', '이거 어떻게 동작해?', 'Sandbox 가 뭐야?'"
   - "한 페이지 요약: `/tower-intro cheatsheet`"
   - (생략: 핸드북 절대경로는 사용자에게 노출하지 않음. 풀 텍스트는 `/tower-intro tour` 또는 운영자에게 요청)

응답 길이 가이드: 짧게. 카테고리 framing 한 단락 + 역할 톤 1-2 단락 + 옵션 안내. 총 20 줄 안. 사용자가 더 원하면 명시적으로 호출.

## 모드 2 — tour (단계별 워킹 튜토리얼)

`/tower-intro tour` 또는 "Tower 둘러보자" / "처음이야 한 번 안내해줘".

5-7 단계 *대화형* 진행. 한 번에 모두 쏟지 않고 **한 단계씩** + 사용자 응답 기다림.

```steps
{
  "title": "Tower 둘러보기 (~10분)",
  "steps": [
    { "title": "Tower 가 뭔지", "status": "pending", "description": "비유 + ChatGPT 와 다른 점. 핸드북 §0 + §1-1 + §1-2" },
    { "title": "프로젝트 = 모든 것의 중심", "status": "pending", "description": "왜 프로젝트 단위인지, 폴더 구조. 핸드북 §3-2" },
    { "title": "AI 와 일하는 네 가지 경로", "status": "pending", "description": "Session / @ai / Task·Schedule / Agent Worker 차이. 핸드북 §3-1 + §4" },
    { "title": "스킬과 Runtime Box", "status": "pending", "description": "teamskills SSOT, project-local skills, materialized runtime copy. 핸드북 §3-4 + §3-5" },
    { "title": "산출물 어디 가나", "status": "pending", "description": "Publishing + 절대경로 + Runtime Box/Sandbox. 핸드북 §3-5 + §3-6 + §5-1" },
    { "title": "발표 자료 / 보고서", "status": "pending", "description": "§8 톤별 묶음 + 시각화 15+ 종. 핸드북 §8 + §3-9" },
    { "title": "다음 단계", "status": "pending", "description": "다섯 원칙 + 깊이 들어가는 길잡이. principles.md + 핸드북 §10" }
  ]
}
```

각 단계마다:
- 핸드북에서 해당 섹션 인용 (3-5 줄)
- 사용자 역할에 맞는 합성 예시 1개 ("당신이 재무 프로젝트에서 X 를 한다면…")
- 시각화 (mermaid / steps / datatable) 1개 — 텍스트 단조롭지 않게
- "다음 단계 갈까요? 아니면 여기서 멈출까요?" 대화형 확인

사용자가 "여기까지" 라고 하면 즉시 중단 + 끝까지 둘러본 단계 요약.

## 모드 3 — `<topic>` (토픽 즉답)

`/tower-intro sandbox` / `/tower-intro 발표 자료` / `/tower-intro 권한` 등.

**토픽 매핑 표**:

| 키워드 | 핸드북 섹션 | 보너스 |
|---|---|---|
| `Tower 란` / `intro` / `소개` | §0 + §1 | 비유 3개 + ChatGPT 비교 표 |
| `권한` / `역할` / `RBAC` / `permission` | §2 | datatable: admin/operator/member/viewer + permission mode |
| `세션` / `session` / `@ai` / `@task` / `schedule` | §3-1 + §4-1~3 | mermaid sequence: 네 경로 |
| `프로젝트` / `project` / `AGENTS.md` / `Runtime Box` | §3-2 + §3-5 | 폴더 구조 도식 |
| `결정문서` / `decisions` / `progress` / `memory` | §3-3 | 다섯 원칙 |
| `스킬` / `skill` / `카탈로그` / `teamskills` | §3-4 | project-local vs teamskills vs runtime copy 표 |
| `sandbox` / `샌드박스` / `runtime box` / `실행` / `격리` | §3-5 | Runtime Box + sandbox 비교 |
| `publishing` / `배포` / `사이트` / `웹` | §3-6 | unlisted vs public + URL 패턴 |
| `agent` / `worker` / `spawn` / `세션 분기` / `자식 세션` | §3-7 | Agent Session 모델 + 가드 매트릭스 |
| `hook` / `자동 동작` | §3-8 | 대표 사례 3개 |
| `시각화` / `포맷` / `차트` / `다이어그램` | §3-9 + §8-5 | 포맷 카탈로그 |
| `credential` / `vault` / `secret` / `gws` | §3-10 + §7 | Credential Orchestrator + grant |
| `ui` / `action bus` / `모달` / `메뉴` | §3-11 | UI Action Bus 원칙 |
| `발표` / `자료` / `pptx` / `슬라이드` / `보고서` | §8 (톤 자동 매핑) | 톤 4종 묶음 → 추천 스킬 위임 |
| `보안` / `격리` / `감사` / `규제` / `은행` | §7 | 4중 감사 트레일 + 은행권 체크리스트 |
| `스택` / `인프라` / `환경` / `dev` / `prod` | §6 | 환경 매트릭스 + 자체 호스팅 서버 |
| `워크플로` / `예시` / `시나리오` | §4 | 5 시나리오 중 사용자 역할에 맞는 1개 |
| `FAQ` / `자주 묻는` | §9 | 6개 Q&A |
| `용어` / `glossary` | §11 | 15+ 용어 |

매칭 안 되는 키워드면 사용자에게 plain prose 로 "혹시 이런 뜻이에요?" 후보 3개 제시.

**발표 자료 분기** (`/tower-intro 발표` 또는 토픽에 "발표·자료·슬라이드·pptx·보고서"):
1. 청중 / 톤 확인 — 임원 / 현업 사용자 / IT·보안 / 개발자
2. 핸드북 §8 의 톤별 묶음 (예: 톤 A 면 8장) 을 *목차* 로 먼저 제시
3. 사용자 확인 후 산출물 위치 결정:
   - 이미지 기반 PDF/PNG 슬라이드 → `/image-slide-gen` 위임
   - HTML/CSS 기반 PDF 슬라이드 → `/html-slide` 위임
   - 브랜드 템플릿 채우기/native PPTX → `/pptx-template` 위임
   - PDF/DOCX 보고서 → `/md-docx-publisher` 또는 `pdf_export` 기반 문서 흐름
   - 단순 .md → `workspace/projects/<현재 프로젝트>/presentations/<목적>-<date>.md`
4. 위임 시 핸드북 §8 묶음 + 사용자 청중을 *컨텍스트* 로 전달

## 모드 4 — cheatsheet (한 페이지 요약)

`/tower-intro cheatsheet` / "Tower 명령 정리" / "타워 한 페이지".

자주 쓰는 트리거·산출물·단축 명령을 **datatable 2개 + steps 1개** 로 압축 출력.

### 표 A — 자주 쓰는 호출

| 무엇을 | 어떻게 |
|---|---|
| AI 에게 무엇을 시키기 | 세션 열고 자연어. 명령어 아님 |
| 채널에서 빠른 AI | `@ai <질문>` |
| 백그라운드/예약 작업 | `@task <지시>` 또는 `/task-schedule` / UI 스케줄 생성 |
| 스킬 호출 | `/<스킬명>` 또는 자연어 (description 매칭) |
| 새 프로젝트 만들기 | 사이드바 "+" 버튼 (직접 mkdir 금지) |
| 사이트 만들기 | "이거 웹 페이지로 만들어줘" → AI 가 자동 publish |
| 발표 자료 | "임원용 도입 발표 자료 만들어줘" 또는 `/tower-intro 발표` |
| 데이터 조회 (SQL) | "DB 에서 X 알려줘" → text2sql 스킬 자동 |
| Gmail / Calendar / Drive | "메일 확인" / "캘린더 일정" → gws 스킬 자동 |
| 핸드북 | `/tower-intro tour` (전체 둘러보기) 또는 `/tower-intro section <섹션>` (부분 인용) |

### 표 B — 산출물·자산이 어디 가나

| 자산 | 위치 |
|---|---|
| 일반 파일 / 보고서 | `workspace/projects/<프로젝트>/...` |
| 결정 (왜 A 대신 B) | `<프로젝트>/.project/decisions/YYYY-MM-DD-제목.md` |
| 작업 로그 | `<프로젝트>/.project/progress.md` |
| 사이트 (웹) | `workspace/published/sites/<slug>/` (또는 프로젝트 안 + 심링크) |
| Runtime Box / Sandbox 실행 코드 | `workspace/projects/<p>/...` 또는 프로젝트 scaffold의 `work/`, `sandbox-tools/` |
| 업로드 / 첨부 | `<프로젝트>/uploads/` |

### Steps — 처음 30분에 하면 좋은 것

```steps
{
  "title": "Tower 첫 30분",
  "steps": [
    { "title": "사이드바에서 자기 프로젝트 열기", "status": "pending" },
    { "title": "AGENTS.md 한 번 읽어보기 (AI 가 늘 보는 컨텍스트)", "status": "pending" },
    { "title": "세션 새로 열어서 '이번 주 할 일 정리해줘' 시켜보기", "status": "pending" },
    { "title": "산출물이 절대경로로 안내되면 클릭해서 파일 탭으로 열기", "status": "pending" },
    { "title": "/tower-intro tour 로 5-7 단계 튜토리얼 돌아보기", "status": "pending" }
  ]
}
```

## 사용자 역할 인식 (default + tour + topic 공통)

| 역할 | 톤 가이드 |
|---|---|
| **admin / operator** | 운영 가능성 강조. 스킬·자체 호스팅 서버·decisions·hooks·Runtime Box·Credential Vault·fleet. "당신이 할 수 있는 건…" |
| **member** | 자기 프로젝트 안 활용 강조. AI 작업·산출물·발표 자료·decisions 기록. "이 프로젝트에서 당신이…" |
| **viewer** | 보기·검토 강조. 감사 로그·읽기 권한·결정문서 조회. "이 워크스페이스에서 당신은…" |

역할 모르면 (Runtime context 없음) → `member` 로 가정 + 끝에 한 줄 "역할 확인은 사이드바 프로필".

## 발견성 (Discoverability)

이 스킬은 **사용자 진입점** 이라 발견성이 핵심. 다음 자리에 cross-reference:

1. `skills/managed/tower-intro/handbook.md` §10 깊이 길잡이에 한 줄 — "사용자 인터랙티브
   안내: `/tower-intro`"
2. `~/workspace/AGENTS.md` Session Start 룰에 한 줄 — "사용자가 Tower 자체를
   묻거든 `/tower-intro`"
3. (선택) 신규 프로젝트 시드 (`tower/templates/workspace/projects/<sample>/AGENTS.md`)
   에 한 줄 — 별도 결정문서로 분리

## 배포 정책 — 사용자용이라 self-hosted server 도 포함

- **tag**: `core` (모든 사용자 노출)
- **profile**: `standalone` / `managed` / `full` 모두 포함 (= 모든 자체 호스팅 서버 에 배포)
- **데이터 소스 의존**: 모든 프로필에 public-safe `handbook.md` seed를 포함한다. 조직이 별도 materialized handbook을 제공하면 그것이 우선한다.
- `full`은 조직 control-plane 운영 맥락, `managed`는 명시적 조직 gateway 연결, `standalone`은 독립 self-host 맥락으로 설명한다.

## 운영

- **소유**: Tower maintainers. 조직별 안내는 organization source에서 별도 관리한다.
- **변경 시**: 핸드북 구조 (섹션 번호) 가 바뀌면 본 SKILL.md 의 `토픽 매핑 표`
  와 `tour 단계 설명` 의 섹션 참조를 같이 갱신
- **검증**: `workspace/projects/teamskills/skills/tower-intro/handbook.md` 와 `skills/managed/tower-intro/handbook.md` 갱신 시 본 스킬의 매핑 표가 여전히 유효한지 점검 (운영자가 한 달 1회)

## 안 하는 것 (NOT for)

- ❌ **핸드북 본문 복제** — Read 후 인용만
- ❌ **코드 변경 위치 안내** → 운영자 전용 개발 문서 영역
- ❌ **핸드북 자체 편집** → teamskills 조직 정본 + Tower seed/reference 갱신 (운영자 전용)
- ❌ **외부 영업·도입 제안 편지** → `/tower-offer`
- ❌ **새 스킬 만들기** → `/skill-architect create`
- ❌ **PPTX / 슬라이드 실제 생성** → `/image-slide-gen`, `/html-slide` 또는 `/pptx-template` (본 스킬은 컨텍스트 전달 + 위임만)

## 관련 결정

- `workspace/decisions/2026-05-12-tower-handbook-and-skill.md` — 핸드북·운영자 스킬 신설
- `workspace/decisions/2026-06-19-tower-ax-positioning.md` — AX / Agent OS 포지셔닝
- `workspace/decisions/2026-06-09-project-scoped-managed-skill-materialization.md` — project-scoped managed skills
- `workspace/decisions/2026-06-24-share-skill-teamskills-only-ssot.md` — teamskills 조직 스킬 SSOT
- `workspace/decisions/2026-06-14-unify-agent-sessions.md` — Agent Session 통합 모델

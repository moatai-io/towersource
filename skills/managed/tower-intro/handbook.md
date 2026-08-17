---
title: Tower Handbook — 사용자·발표·설명서용 통합 안내서
audience: 워크스페이스 사용자 / 발표 자료 작성자 / 외부 설명용 / 새로 합류한 팀원
status: live (수동 갱신 + `/skill-architect refine tower-intro` 보조)
last_updated: 2026-06-26
owner: Moat AI 운영 (admin / operator)
source_of_truth:
  - workspace/decisions/ (정책·구조 변경 이력)
  - tower/docs/tower-guide/ (개발자·운영자 위키)
  - workspace/projects/teamskills/skills/ (조직 공용 스킬 정본)
  - tower/config/skills/managed-skills.yaml / workspace/projects/teamskills/skillset.json (스킬 메타·기본셋)
  - tower/AGENTS.md / workspace/AGENTS.md (런타임 매뉴얼)
  - workspace/docs/tower/ (고객 영업 톤 문서)
---

# Tower Handbook

> **이 문서의 용도** — "Tower 가 뭐예요?" "이거 어떻게 활용할 수 있어요?" "발표 자료 만들 때 뭐를 강조해야 해요?" 같은 질문에 단일 출처로 답하기 위한 핸드북. 워크스페이스 안에서 *프로젝트 세션 AI* 와 *사용자* 가 함께 보는 1차 안내서.
>
> **이 문서가 *아닌* 것** — 코드 변경 시 참조하는 개발 위키(`tower/docs/tower-guide/`)나 외부 영업 자료(`workspace/docs/tower/`) 의 *대체* 가 아닙니다. 그 둘을 *재료* 로 통합해 *워크스페이스 안 모든 사용자가 한 페이지에서 Tower 를 이해* 하게 만드는 합성물입니다. 깊이 들어갈 때는 §10 의 길잡이를 따라가십시오.

---

## 0. 30초 요약

Tower 는 **AI를 쓰는 회사를 넘어, AI가 함께 일할 수 있는 회사로 바꾸는 Agent OS**입니다.

- **AX 비유**: 대부분의 회사는 AI를 안 쓰는 것이 아니라, AI가 들어올 수 있는 업무 구조가 부족합니다. Tower는 문서·데이터·결정·협업·실행환경을 프로젝트 안에 묶어 실제 업무를 AI와 함께 처리하게 만듭니다.
- **사무실 비유**: ChatGPT/Claude 가 *개인 노트북* 이라면, Tower 는 *팀 전용 AI 사무실* 입니다. 같은 공간, 공유 책상, 같은 캐비닛, 누가 뭘 시켰는지 보이는 협업 환경입니다.
- **기술 비유**: 프로젝트가 작업 경계이자 Runtime Box 배포 단위입니다. 각 프로젝트는 멤버, 파일, 채널, 세션, 스킬, Credential Vault grant, 실행 권한을 함께 가집니다.
- **차별 요약**: 데이터는 고객/회사 서버에 남고, 권한·감사·격리가 기본이며, AI는 단순 대화가 아니라 파일을 만들고, 도구를 호출하고, 반복 가능한 스킬과 결정 기록을 회사 자산으로 남깁니다.

한 문장: **"회사 일이 AI가 함께 일할 수 있는 형태로 바뀌고, 그 흔적이 회사 자산으로 쌓이는 팀 Agent OS."**

---

## 1. Tower 는 무엇인가

### 1-1. 한 단계 더 — 비유 네 개

| 비유 | 무엇을 비추는가 |
|---|---|
| **Agent OS** | 세션, 태스크, 스킬, 파일, 권한, credential, 배포가 한 작업환경 위에서 움직임. |
| **팀 전용 사무실** | 공유 공간 + 개인 자리 + 회의실. 누가 들어와 뭘 했는지 다 보임. |
| **AI-ready 업무 구조** | DT를 끝내고 AI를 붙이는 것이 아니라, AI와 일하며 필요한 DT/AX가 함께 전진함. |
| **Google Docs + 실행 가능한 비서들** | 모두가 같은 문맥을 보고, AI가 옆자리에서 실제 파일·도구·스케줄·런타임을 다룸. |

### 1-2. ChatGPT / Claude 개인 사용과 다른 점

| 항목 | ChatGPT/Claude 개인 | Tower |
|---|---|---|
| 사용 단위 | 개인 계정 | 팀 / 프로젝트 / 조직 skillset |
| 대화 위치 | 개인 채팅창 | 공용 워크스페이스 + 프로젝트 + 채널 + 세션 |
| 업무 구조 | 사람이 복사·붙여넣기 | AI가 프로젝트 파일·결정·스킬·credential grant 안에서 작업 |
| 결과물 보관 | 채팅 안에 묻힘 | 프로젝트 폴더, published site, 결정문서, git/audit 로그에 남음 |
| 권한 | 개인 계정 중심 | 역할 + 프로젝트 멤버십 + capability + credential grant |
| 감사 | 제한적 | DB + git trailer + provenance + decisions/progress + sandbox run 기록 |
| 데이터 위치 | 외부 서비스 클라우드 | 고객/회사 Tower 서버 중심, 외부 전송은 AI/API 호출로 제한 |
| 실행 | 대체로 답변 생성 | Runtime Box/Sandbox, PDF/Excel/CAD/Publish, 장기 worker, schedule까지 수행 |
| 스킬 | 개인 prompt 재사용 | 조직/프로젝트 skill source + materialized runtime copy + 검증/배포 흐름 |

### 1-3. "그래서 누가 이걸 만들었어요?"

- **제공사**: Moat AI (모트AI), 한국. 줄리어스 (Julius Chun) PM.
- **단계**: 자체 호스팅 서버 운영과 내부 dogfooding을 병행하는 Agent OS 제품. demo-org, demo-server 등 managed 자체 호스팅 서버과 Moat AI 내부 full VM에서 운영 중입니다.
- **라이선스 / 모델**: 고객사 서버에 직접 설치·운영하는 on-premise/self-hosted VM 모델. 일반 SaaS가 아니라 고객 데이터 경계 안에 Tower를 둡니다.
- **기반 기술**: Tower AI runtime, React + Express + PostgreSQL, Project Runtime Box/Sandbox, Credential Vault, Tower-managed skill system.

---

## 2. 누가 어떤 권한으로 쓰나

Tower 의 권한은 이제 단순한 "서버 역할" 하나가 아니라 **역할 × 프로젝트 멤버십 × capability grant × credential grant** 로 이해하는 것이 정확합니다.

### 2-1. Tower 역할 (수직)

| 역할 | 핵심 권한 | 일상 비유 |
|---|---|---|
| **admin** | 워크스페이스 전체 + 시스템 설정 + 사용자/credential/운영 작업 | 사무실 대표·총무 |
| **operator** | 배포·자체 호스팅 서버·운영 자동화 등 admin급 운영 업무 | 운영 담당자 |
| **member** | 초대받은 프로젝트 안에서 파일·세션·스킬·산출물 작업 | 프로젝트 팀원 |
| **viewer / guest** | 초대받은 범위 읽기·검토 중심 | 외부 방청자·검토자 |

운영팀 (Moat AI 내부) 은 admin/operator, 고객사 일반 사용자는 보통 member, 외부 이해관계자는 viewer/guest로 시작합니다.

### 2-2. 프로젝트 멤버십 (수평)

같은 member 라도 "한투 프로젝트 멤버" vs "오쿠시스템 프로젝트 멤버" 는 서로 다른 데이터에 접근합니다. 프로젝트가 Tower의 1차 작업 경계입니다.

- 프로젝트에 초대받지 않으면 **그 프로젝트 폴더와 세션 자체가 보이지 않거나 접근이 차단**됩니다.
- 프로젝트는 파일·채널·세션·AGENTS.md·결정문서·스킬·Runtime Box 설정·credential grant를 함께 묶습니다.
- 새 프로젝트 폴더를 직접 `mkdir` 하면 DB row와 권한 메타가 없는 ghost project가 됩니다. 새 프로젝트는 UI `+`, 공식 CLI/API 같은 정식 진입점으로 만듭니다.
- admin/operator도 일반 작업은 프로젝트 안에서 합니다. 루트·공용 폴더·다른 프로젝트에 영향을 주는 변경은 운영 작업으로 취급합니다.

### 2-3. Capability / Credential grant

프로젝트가 "작업 공간"이라면 capability와 credential은 "실제로 무엇을 할 수 있는지"를 정합니다.

| 축 | 의미 | 예 |
|---|---|---|
| **Capability grant** | 어떤 고위험/운영 행동을 할 수 있는가 | `fleet:deploy`, `skill:materialize-project`, `credential:grant-project` |
| **Credential grant** | 어떤 secret 이름을 Runtime Box에 주입할 수 있는가 | `OPENAI_API_KEY`, `APIFY_TOKEN`, `NAVER_CLIENT_SECRET`, `TIRO_KEY` |
| **명시 의도** | 배포·전송·삭제·공개 같은 위험 행동을 사용자가 지금 원했는가 | `/self-host deploy demo-org`, "공개 URL로 publish" |
| **감사 가능성** | 누가 언제 어떤 권한으로 실행했는가 | session id, run id, audit log, decision |

Credential 값은 AI가 보지 않습니다. 스킬과 Runtime Box는 `secrets: ["NAME"]`처럼 **이름만** 요구하고, Tower Credential Orchestrator가 허용된 대상에만 값을 주입합니다.

### 2-4. AI 자율 실행의 강도 (Permission Mode)

같은 사용자가 AI에게 일을 시킬 때 *AI가 얼마나 자율적으로 행동* 하느냐도 별도 축입니다.

- **`plan`** — AI는 계획만 제시. 실행은 사람이 한 줄씩 승인.
- **`acceptEdits`** — 파일 편집은 자동, 위험 시스템 명령은 승인 필요. 일반 사용자 기본값에 가깝습니다.
- **`bypassPermissions`** — 모든 작업 자동. admin/operator 개발·운영 자동화 한정.

은행권·규제산업은 보통 `plan` 또는 `acceptEdits` 중심으로 운영하고, 운영 자동화만 제한적으로 `bypassPermissions`를 씁니다.

---

## 3. 무엇을 줄 수 있나 — 능력 카탈로그

Tower 가 사용자에게 주는 능력은 이제 "AI 채팅"보다 넓습니다. **프로젝트 안에서 AI가 읽고, 쓰고, 실행하고, 기억하고, 다시 불러올 수 있는 업무 운영체제**입니다.

### 3-1. AI 와 일하는 네 가지 경로

| 경로 | 트리거 | 누가 보나 | 언제 쓰나 |
|---|---|---|---|
| **Session** | 좌측 사이드바 새 세션 또는 기존 세션 | 기본은 본인, 필요 시 프로젝트/공유 | 집중 작업 — "이 보고서 다듬어줘" |
| **Channel AI** | 채널에서 `@ai 질문` | 채널 멤버 | 팀 대화 중 빠른 AI 호출 — "@ai 어제 결정 요약" |
| **Task / Schedule** | `@task`, 스케줄 UI, 반복 실행 | 프로젝트 채널 또는 설정된 리포트 대상 | 백그라운드·정기 작업 — "매일 9시 뉴스 변화만 알려줘" |
| **Agent Worker** | subagent / persistent worker / goal loop | 부모 세션 또는 Agent UI | 독립 조사·리뷰·장기 steward — "QA 리뷰어 붙여" |

**기억 포인트**:
- Session 은 사람이 옆에서 보며 이끄는 작업 공간입니다.
- Channel AI 는 팀 채널에 붙은 공유 AI입니다. 룸/프로젝트 문맥을 따라갑니다.
- Task/Schedule 은 반복·예약 실행입니다. 기본 리포트 정책은 "중요할 때만" 말하도록 가는 중입니다.
- Agent Worker 는 독립 역할을 가진 보조 AI입니다. 일회성 subagent도, 계속 부를 수 있는 persistent worker도 모두 Agent Session 모델로 통합됩니다.

상세 비교: `tower/docs/tower-guide/ai-execution-paths.md`, 결정: `2026-06-13-agent-control-plane-unification.md`, `2026-06-14-unify-agent-sessions.md`, `2026-06-20-task-schedule-reporting-and-run-context.md`.

### 3-2. 프로젝트 (Project-Centric + Runtime Box Architecture)

**"프로젝트가 모든 것의 중심"** — 한 프로젝트 안에 다음이 묶입니다.

- 채널 (팀 채팅)
- 세션 (AI 작업, 개인/공유/agent)
- 파일 (프로젝트 폴더 = 공유 드라이브)
- AI 컨텍스트 (`AGENTS.md` + `.project/decisions/` + `.project/progress.md`)
- Project Runtime Box 설정
- 프로젝트 스킬 (`skills/<skill>/`) 과 materialized managed 스킬 (`.tower/skills/<skill>/`)
- Credential Vault grant와 capability grant

폴더 구조:
```
workspace/projects/<project>/
├── AGENTS.md                  ← 이 프로젝트에서 AI가 늘 읽는 컨텍스트
├── .project/
│   ├── progress.md            ← 작업 로그 (append-only)
│   ├── decisions/             ← 프로젝트 결정 기록
│   └── state.json             ← 시스템 메타
├── skills/<skill>/            ← 프로젝트가 직접 만든 local skill source
├── .tower/skills/<skill>/     ← Tower가 materialize한 managed runtime copy
├── sources/ work/ final/ ...  ← 프로젝트 scaffold가 있으면 그 계약을 따름
├── published/                 ← publish용 소스
└── uploads/                   ← 첨부·업로드
```

2026-06 이후의 핵심 변화는 **프로젝트를 preconfigured Runbox deployment unit으로 본다**는 점입니다. 서버가 full/managed인지보다, 프로젝트·역할·capability·credential grant가 실제 실행 권한을 정합니다.

### 3-3. 글 자산 — Decisions / Progress / AGENTS.md / Memory

Tower 의 기억은 채팅 로그만이 아니라 **문서와 요약 카드**로 축적됩니다.

| 자산 | 위치 | 역할 | 누가 씀 |
|---|---|---|---|
| **결정문서** | `workspace/decisions/` / `<project>/.project/decisions/` | "왜 A 대신 B 골랐는지" 영구 기록. 변경 시 새 파일 추가 | 사람 또는 AI |
| **진행기록** | `<project>/.project/progress.md` | "오늘 뭐 했고 뭐 배웠는지" | 모든 세션 |
| **AGENTS.md** | `<project>/AGENTS.md` | 프로젝트에서 AI가 늘 읽는 컨텍스트 | `/agents-md` 또는 직접 편집 |
| **Session continuity card** | Tower DB | 과거 세션의 이어받기 요약 | 자동 생성/검색 |
| **codify.md** | `workspace/codify.md` | 워크스페이스 차원 learnings | 운영자 |

다섯 원칙: 써라, 왜를 남겨라, 찾을 수 있게 해라, 작은 것부터, 주기적으로 돌아봐라, 제자리에 놓아라.

### 3-4. 스킬 시스템 (조직 기본 29개 + 프로젝트 local skills)

스킬 = *재사용 가능한 AI 워크플로*. 2026-06 이후 정본 구조가 정리됐습니다.

| 영역 | 정본 / 런타임 | 의미 |
|---|---|---|
| 프로젝트 local skill | `workspace/projects/<project>/skills/<skill>/SKILL.md` | 특정 프로젝트가 직접 만든 스킬 |
| 조직 공용 skill source | `workspace/projects/teamskills/skills/<skill>/` | 회사/조직 여러 프로젝트에 공유되는 정본 |
| 조직 기본 skillset | `workspace/projects/teamskills/skillset.json` | 기본 materialize 목록 (현재 29개) |
| Tower seed/reference | `tower/skills/managed/<skill>/` | 제품 기본 제공 seed/reference. ordinary org SSOT 아님 |
| 프로젝트 runtime copy | `workspace/projects/<project>/.tower/skills/<skill>/` / Runtime Box `/workspace/.tower/skills/<skill>/` | Tower가 생성한 실행용 copy. 직접 편집 금지 |

**역할별 진입점**:
- **새 스킬 body 만들기/개선**: `/skill-architect` — intent, sample, eval, validate, distill, trigger tune.
- **프로젝트 스킬을 조직 공용으로 공유**: `/share-skill` — diff-first로 `teamskills`에 반영.
- **자체 호스팅 서버/프로젝트에 조직 스킬 반영**: `/managed-skill-rollout` 또는 `/fleet skills` — materialize와 runtime 검증.
- **Credential 상태 확인**: `/runtime-box-credentials` / `/customer-credentials`.
- **legacy registry 진단**: `/skill-registry` — 일반 공유/배포의 주 진입점은 아님.

**기본 skillset 예시** (`teamskills/skillset.json`): agents-md, cta, design-explore, design-md, frontend-design, gws, goal, html-slide, ideate, image-slide-gen, issue, md-docx-publisher, mermaid-pdf, naver-search, plan-refine, pdf2pptx, pptx-review, pptx-template, search, session-rename, skill-architect, soul, svg, task-schedule, tiro, tower-intro, web-capture, wiki-compile, youtube-transcript.

### 3-5. Runtime Box / Sandbox 실행 — 코드와 실행의 분리

> **사용자 작업 코드는 프로젝트 안에 두고, 실행은 Runtime Box/Sandbox에서 한다.**

| 원칙 | 의미 |
|---|---|
| 코드 저장 | `workspace/projects/<p>/...` 아래. `/tmp` 산출물 인계 금지 |
| 단발 실행 | `sandbox.run` / `mcp__sandbox__run` — 인라인 또는 workspace 파일 entrypoint |
| 장기 운영 | `sandbox.tool_start` — 며칠 도는 미니 백엔드·워커 |
| Runtime Box | 프로젝트별 `/workspace` 마운트, `.tower/skills`, credential grant, tool baseline |
| 네트워크 | 기본 차단. 필요한 whitelist만 허용 |
| 시크릿 | 값이 아니라 secret 이름만 주입 요청 |
| 본체 VM 직접 실행 | 일반 사용자 코드 실행은 금지. Tower 자체 dev/prod 운영은 예외 |

Runtime Box는 단순 보안 장치가 아니라 **프로젝트별 실행환경**입니다. project + role + capability + credential grant가 모여 "이 프로젝트에서 이 AI가 무엇을 할 수 있는가"를 정합니다.

### 3-6. Publishing — 워크스페이스 → 웹

사용자가 "웹 페이지로 만들어줘", "대시보드 공유해줘"라고 하면 AI는 프로젝트 안에 정적 산출물을 만들고 `publish_site`로 Publishing Hub에 등록합니다.

**핵심 규칙**:
- 기본은 **unlisted** 링크. 사용자가 공개/SEO/짧은 URL을 명시할 때만 public.
- 권장 URL은 wildcard subdomain: `https://<slug>.<server>/`. 이 서버는 `https://<slug>.tower.tower.example.com/`.
- AI는 `/api/deploy`를 curl로 직접 호출하거나 `TOWER_API_TOKEN`을 요구하지 않습니다.
- 프로젝트 컨텍스트에서는 먼저 `workspace/projects/<p>/published/<name>/` 또는 `dist/` 같은 프로젝트 내부 폴더에 만들고, `publish_site`가 공용 published 영역에 반영합니다.
- PDF가 필요하면 print-stable HTML을 만들고 `pdf_export`로 실제 PDF를 내보낸 뒤 verification image를 확인합니다.

### 3-7. Agent Sessions — subagent / persistent worker / spawn

Tower의 보조 AI 실행은 **Agent Session** 모델로 통합되고 있습니다.

| 개념 | 뜻 | 언제 쓰나 |
|---|---|---|
| **Ephemeral run** | 한 번 실행하고 다시 부르지 않는 subagent run | 짧은 독립 조사·리뷰 |
| **Persistent worker** | backing session을 가진 재사용 가능한 작업자 | QA steward, 릴리즈 리뷰어, 장기 모니터 |
| **Spawned session** | 사용자가 사이드바에서 직접 볼 수 있는 별도 세션 | 사용자가 명시적으로 "별도 세션"을 원할 때 |
| **State card** | 긴 agent 세션의 현재 상태 요약 | 운영 화면·supervisor가 빠르게 판단 |

정책상 AI가 자기 편의로 sidebar spawn을 만들지는 않습니다. 일반적인 위임은 agent-worker 기반 subagent/persistent worker를 쓰고, 사용자가 명시적으로 별도 세션을 원할 때만 spawn을 씁니다. 기본 보고 계약은 **report-and-resume(wake)** 입니다. 작업자가 끝나면 부모 세션에 결과를 보고하고, 부모가 검증 후 사용자에게 종합합니다.

### 3-8. Hooks — 자동 동작

AI tool 호출 lifecycle에 자동으로 반응하는 콜백입니다. Tower는 외부 config-home hook 파일 대신 **Tower runtime options 안에 inline TypeScript** 로 넣어 multi-config home과 자체 호스팅 서버 전파를 안정화했습니다.

대표 사례:
- **Publishing tracker** — AI가 어떤 패턴으로 사이트를 만들든 publish manifest를 갱신.
- **Provenance log** — 파일 변경/도구 사용을 `workspace/.audit/provenance.jsonl`에 누적.
- **Workspace guard** — 루트 쓰기, ghost project 생성, secret 접근, 위험 명령을 role/context별로 차단.
- **Session/memory hooks** — 세션 identity, continuity card, notification 등 제품 동작을 자동 보조.

### 3-9. 시각화·문서·파일 포맷

채팅에서 AI가 코드블록으로 출력하면 자동 렌더되는 포맷이 있습니다. 보고서와 발표자료를 채팅 안에서 바로 검토할 수 있게 하기 위한 Tower 고유 UX입니다.

기본: `chart`, `mermaid`, `datatable`, `steps`, `timeline`, `svg`, `html-sandbox`, `map`, `$$수식$$`.
확장: `secure-input`, `diff`, `terminal`, `comparison`, `treemap`, `gallery`, `audio`.
문서 도구: Excel/CSV read/query/write/diff, PDF view/read/export, CAD view, DOCX/PPTX 계열 스킬.

상세: `tower/docs/tower-guide/visual-formats.md`.

### 3-10. Credential Orchestrator

Tower는 외부 secret manager를 기본 의존성으로 삼지 않고, 내장 **Credential Orchestrator**를 중심으로 갑니다.

- secret 값은 Tower `secret_store`에 암호화 저장합니다.
- 스킬·Runtime Box·GitHub Actions·Azure·GWS·자체 호스팅 서버 같은 target은 credential을 **이름과 grant**로만 받습니다.
- AI는 값을 보지 않고, presence/status만 확인합니다.
- 프로젝트별 grant, user/account binding, audit log가 핵심입니다.

예: gws는 Google Workspace credential, youtube-transcript는 `APIFY_TOKEN`, image-slide-gen은 이미지 전용 `OPENAI_IMAGE_API_KEY`(전환기에는 `OPENAI_API_KEY` fallback), tiro는 `TIRO_KEY`가 필요할 수 있습니다.

### 3-11. UI Action Bus (계획/초기 방향)

Tower의 AI/스킬은 앞으로 "여기 메뉴로 가세요"라고 길게 설명하는 대신, 허용된 메뉴·모달·패널을 안전하게 열어주는 **UI Action Bus**를 갖게 됩니다.

예:
- Credential 연결 모달 열기
- 스케줄 생성 모달 prefill
- Publish Panel 열기
- 파일 탭에서 산출물 열기
- 프로젝트/스킬 설정 패널 열기

AI가 임의 JavaScript나 DOM selector를 실행하는 방식은 금지입니다. allowlist된 UI intent만 보내고, 실제 저장·전송·삭제·공개·배포는 사용자의 UI 확인으로 확정합니다.

---

## 4. 어떻게 일이 흘러가나 — 워크플로 5종

발표 시 "Tower가 실제로 어떻게 일하는지" 보여줄 때 쓰는 시나리오들입니다.

### 4-1. 워크플로 A — 분석 보고서 자동 작성

```
1. 사용자가 프로젝트 세션을 열고 요청:
   "이번 주 의결권 데이터 가져와서 요약 보고서 만들어줘"
2. AI가 자동으로:
   a. AGENTS.md / .project/decisions / 과거 continuity card 확인
   b. 필요한 스킬 또는 DB/API 도구 선택
   c. 프로젝트 scaffold에 맞춰 sources/work/final 또는 reports 폴더에 산출물 저장
   d. chart / datatable / mermaid 등으로 핵심을 채팅에 렌더
   e. 필요하면 PDF/DOCX/PPTX/publish_site로 공유 산출물 생성
   f. provenance/git/decision/progress에 흔적 보존
3. 사용자가 "발표 자료로"라고 하면 html-slide, image-slide-gen, pptx-template 등으로 이어감
```

### 4-2. 워크플로 B — 채널에서 빠른 AI 호출

```
1. 채팅 채널에서 사용자가: "@ai 어제 결정한 이슈가 뭐였더라?"
2. Channel AI가 답:
   - 채널의 프로젝트 문맥을 기준으로 동작
   - 채널 페르소나 + 프로젝트명이 system prompt overlay
3. 답은 채널과 backing session에 남아 팀 자산이 됨
4. 다른 멤버가 이어서 @ai를 부르면 문맥이 이어짐
```

### 4-3. 워크플로 C — 스케줄/태스크 자동화

```
1. 사용자: "매일 9시에 키움 관련 뉴스 변화가 있으면 townhall에 알려줘"
2. task-schedule 흐름이:
   a. 프로젝트와 보고 채널을 정함 (기본은 프로젝트 townhall)
   b. report policy를 정함 (기본은 auto: 중요할 때만)
   c. run context를 정함 (기본은 auto: 이어갈지 fresh run일지 판단)
   d. schedule-owned session 또는 fresh run으로 실행
3. 결과가 중요하면 채널에 요약, 변화 없으면 조용히 기록만 남김
4. 실패하면 on_error 정책에 따라 보고
```

### 4-4. 워크플로 D — 새 스킬 도입·공유

```
1. 사용자: "/skill-architect create 우리 회사 정규 보고 양식 자동 생성기"
2. skill-architect가 intent → sample → draft → smoke/eval → validate 진행
3. 프로젝트 local skill로 먼저 검증: projects/<p>/skills/<skill>/
4. 조직 공용으로 쓸 가치가 있으면 /share-skill:
   - teamskills/skills/<skill>와 diff
   - copy/merge/rename 방향 확인
   - skill.yaml/version metadata 반영
5. 필요한 프로젝트에 materialize:
   - .tower/skills/<skill>/ runtime copy 생성
   - Runtime Box에서 실제 trigger/secret/스크립트 검증
6. 자체 호스팅 서버 전파는 별도 명시 요청 시 /managed-skill-rollout 또는 /fleet
```

### 4-5. 워크플로 E — 장기 Agent Worker

```
1. 사용자: "이 이슈는 QA reviewer 하나 붙여서 계속 보게 해줘"
2. 부모 세션이 persistent worker를 만든다:
   - 역할, 범위, 금지사항, 성공 기준, 보고 방식 명시
3. worker는 backing Agent Session에 맥락을 누적하며 실행
4. 완료/막힘/리스크가 생기면 부모 세션에 report-and-resume으로 보고
5. 부모는 실제 diff/test/log/render evidence를 확인한 뒤 사용자에게 종합
6. 더 필요 없으면 archive/pause, 계속 필요하면 후속 지시
```

---

## 5. 어디에 무엇이 있나 — 워크스페이스 + 코드베이스 지도

### 5-1. 워크스페이스 (사용자가 보는 영역)

```
~/workspace/
├── CLAUDE.md                  ← 런타임 매뉴얼 (AI 가 매 세션 자동 로드)
├── principles.md              ← 다섯 원칙 (불변)
├── codify.md                  ← 워크스페이스 차원 learnings
├── decisions/                 ← 팀 공통 결정문서 (append-only)
├── docs/                      ← 가이드·SOP·레퍼런스
│   ├── tower/                 ← 외부 고객 영업용 문서
│   │   ├── overview.md
│   │   ├── value-proposition.md
│   │   ├── security-architecture.md
│   │   └── on-premise-install.md
│   ├── publishing-guide.md
│   ├── azure-customer-deployment-runbook.md
│   └── ... (그 외 가이드)
├── projects/                  ← 프로젝트 폴더들
│   └── <project>/
│       ├── AGENTS.md
│       ├── .project/
│       ├── skills/             ← 프로젝트 local skill source
│       ├── .tower/skills/      ← managed runtime copy (system-managed)
│       ├── sources/ work/ final/ records/ knowledge/ (scaffold가 있으면)
│       ├── published/
│       └── uploads/
├── published/sites/<slug>/    ← nginx 자동 서빙
├── scripts/                   ← 운영 스크립트
└── .audit/provenance.jsonl    ← PostToolUse hook 이 누적
```

### 5-2. 코드베이스 (admin/operator 만 접근, `~/tower/`)

```
~/tower/
├── packages/
│   ├── backend/services/
│   │   ├── system-prompt.ts   ← 시스템 프롬프트 (모든 세션 영향)
│   │   ├── ai/                ← AI runtime adapters, @ai, 보조 에이전트
│   │   ├── session/           ← AI 세션 라이프사이클
│   │   ├── task/              ← 작업·스케줄·자동화
│   │   ├── publishing/        ← 사이트 배포 / 매니페스트
│   │   ├── sandbox/           ← 실행 격리 (3 mode)
│   │   ├── workspace-guard/   ← 워크스페이스 루트 보호
│   │   ├── secret/            ← .env 가드
│   │   └── ...
│   ├── backend/engines/       ← AI runtime engines
│   ├── frontend/src/          ← React UI
│   └── shared/                ← 공유 타입·파서
├── templates/workspace/       ← 신규 자체 호스팅 서버 시드 (CLAUDE.md, principles.md, ...)
├── docs/tower-guide/          ← 개발자·운영자 위키 (architecture, operations, skills, ...)
├── docs/customer-servers.md   ← 자체 호스팅 서버 목록
├── start.sh                   ← prod-restart 등 운영 명령
└── CLAUDE.md                  ← 코드베이스 작업 시 AI 가 읽는 룰
```

### 5-3. AI 컨텍스트 5-레이어 (모든 세션 공통)

세션 시작 시 Claude 에게 누적되는 컨텍스트:

1. **시스템 프롬프트** (`system-prompt.ts`) — Core + Org policy + Runtime context + tool/skill guidance
2. **프로젝트 컨텍스트** — cwd, project membership, AGENTS.md, scaffold contract
3. **스킬 descriptions** — manifest-listed managed skills + project-local skills
4. **메모리/continuity** — prior-session summary cards, user identity notes, relevant project memory
5. **Task/Schedule addendum** — 자율 실행 가드레일, report policy, run context (task 전용)

상세: `tower/docs/tower-guide/architecture.md`

---

## 6. 기술 스택 / 인프라 / 환경

### 6-1. 스택

| 층 | 기술 |
|---|---|
| Frontend | React 19, TypeScript, Vite 6 |
| Backend | Express, TypeScript, WebSocket, tsx watch |
| DB | PostgreSQL (Moat AI 내부) / SQLite 옵션 (경량 고객) |
| AI | Tower AI runtime, provider routing, Local 옵션 |
| 외부 API | Anthropic, OpenRouter, Azure/OpenAI, Google/Naver/Tiro 등 grant 기반 통합 |
| 인증 | JWT + AES-256-GCM, httpOnly 쿠키 |
| 프로세스 | PM2 (prod), tsx watch (dev) |
| 리버스 프록시 | Nginx + LE wildcard cert |
| 배포 자동화 | git push + `./start.sh prod-restart` (자체) / `/self-host deploy <customer>` (자체 호스팅 서버) |
| 격리 실행 | Project Runtime Box + Docker sandbox (in-process MCP, 형제 execution VM) |

### 6-2. 환경 매트릭스 (Moat AI 내부)

| 환경 | 도메인 | 포트 | 프로세스 |
|---|---|---|---|
| Dev | `desk-dev.tower.example.com` | :32354 (Vite) → :32355 (backend) | `npm run dev` (tsx watch) |
| Prod | `tower.tower.example.com` | :32364 | PM2 `tower-prod` |
| Redirect | `desk.tower.example.com` | — | Nginx 301 → Prod |

DB / workspace / engine session storage / API 키는 dev/prod 공유. Dev 코드 수정 → 즉시 prod 영향 없음.

### 6-3. 자체 호스팅 서버 (Self-hosted servers)

대표 운영 대상 (2026-06 기준):

| 고객 | 도메인 | 프로필 | 상태 |
|---|---|---|---|
| Moat AI 내부 | `tower.tower.example.com` | full | 운영 중 |
| demo-org | `demo-org.tower.example.com` | managed | 첫 managed 고객 (2026-04-04) |
| demo-server | `demo-server.tower.example.com` | managed | 데모용 |

각 self-hosted server 옆에 **형제 execution/sandbox VM** 또는 Runtime Box 실행면을 둡니다:
- `execution-tower-vm` (10.0.0.4, B1ms) — Moat AI
- `execution-demo-org-vm` (20.196.213.144, 10.0.0.6) — demo-org
- ... (각 고객마다)

상세: `tower/docs/customer-servers.md`

### 6-4. 배포 흐름

- **자체 Prod**: dev 세션에서 `./start.sh prod-restart`
- **자체 호스팅 서버**: `/self-host deploy <customer>` 한 줄 (git pull + build + pm2 restart + managed skill sync/materialize). SSH 직타 합성 금지.
- **사용자 명시 요청 시에만 배포** — `git push` 의 다음 단계가 *아님*. local main ↔ origin/main 동기화 가드가 선행됩니다.
- **Skill rollout**: 자체 호스팅 서버 스킬 반영은 `/managed-skill-rollout` 또는 `/fleet skills` 흐름에서 diff/sync/materialize/verify를 봅니다.

---

## 7. 보안 / 격리 / 감사

### 7-1. 데이터 흐름

```
[사용자 브라우저] ─HTTPS─▶ [Nginx] ─내부─▶ [Tower 서버] ─┬─▶ [Postgres]
                                                    └─▶ [workspace/ 파일]
                                                    └─HTTPS─▶ [api.anthropic.com] (AI API 만 외부)
```

**외부로 나가는 것**: AI 에게 보내는 프롬프트 + 첨부 내용 *뿐*.
**외부 저장**: 없음 (Anthropic 기업 약관 하에 미보관).

### 7-2. 격리 매트릭스

| 격리 단위 | 어떻게 |
|---|---|
| 프로젝트 간 | AI 세션의 cwd 가 `workspace/projects/<p>/` 로 제한. ACL 가드가 다른 프로젝트 read/write 차단 |
| 멤버 vs admin | workspace 루트는 admin/operator territory. docs/decisions는 정책에 따라 member write 가능 영역도 있음 |
| 코드 vs 실행 | 본체에서 사용자 코드 직접 실행 금지. Runtime Box/Sandbox로 실행 |
| Runtime Box / Sandbox 컨테이너 간 | Docker network 차단 + 사용자별 컨테이너 cap + 프로젝트별 credential grant |
| 외부 통합 | claude.ai connector 차단 (multi-tenant 안전 문제), gws CLI와 Tower in-process 통합 우선 |
| Secret / Credential | Credential Vault grant 기반. AI는 secret 값을 보지 않고 이름·상태만 다룸 |

### 7-3. 감사 트레일

| 자산 | 위치 | 내용 |
|---|---|---|
| AI 대화 | Postgres `session_messages` | 누가 언제 무슨 대화 |
| 파일 변경 | git 자동 커밋 (`Tower-Session: <id>` trailer) | 모든 변경의 diff + 누구 세션 |
| 작업 흔적 | `workspace/.audit/provenance.jsonl` | PostToolUse hook 이 자동 누적 (어떤 도구가 어떤 파일을) |
| 결정 | `decisions/` (immutable) | 정책·구조 변경 |
| 진행 | `<project>/.project/progress.md` | 일상 작업 로그 |
| Sandbox 실행 | run_id 별 결과 + scratch 파일 | 인 / 아웃 / exit code |

### 7-4. 규제 산업 체크리스트 (은행권 기준)

| 요건 | Tower 대응 |
|---|---|
| 데이터 국내 저장 | On-premise, 고객사 서버 |
| 외부 전송 통제 | AI API 만 외부 |
| 접근 권한 관리 | 역할 + 프로젝트 ACL + capability grant + credential grant |
| 감사 로그 | DB / git / provenance / decisions / schedule·agent run 기록 |
| 암호화 | AES-256-GCM + TLS 1.2+ |
| 망분리 | 폐쇄망 설치 가능 (Tier 1 화이트리스트 + 로컬 LLM 옵션) |
| AI 행동 통제 | Permission Mode (plan / acceptEdits / bypassPermissions) |
| 데이터 격리 | 프로젝트·Runtime Box·Credential grant 단위 격리 |

추가 옵션 (요청 시): SSO (SAML/OIDC), IP whitelisting, 2FA (TOTP), 로컬 LLM, VLAN 분리.

---

## 8. 발표 자료 · 설명서 만들 때 — 톤별 재료

이 핸드북은 **재료 창고** 입니다. 어떤 톤의 자료를 만드느냐에 따라 다른 묶음을 가져가십시오.

### 8-1. 톤 A — 의사결정자용 (도입 검토 발표)

> "이게 우리에게 어떤 가치를 주는가?"

핵심 슬라이드 8장:

1. **문제** — AI 기능은 샀지만 AI가 들어올 업무 구조가 없음
2. **해결** — "AI가 함께 일할 수 있는 회사로 바꾸는 Agent OS" — §0 + §1
3. **차별** — 개인 AI vs Tower — §1-2 표
4. **축적** — 문서·결정·스킬·산출물이 회사 자산으로 남음
5. **보안** — 데이터 흐름 + Credential Vault + 감사 트레일 — §7
6. **도입 시나리오** — 프로젝트 단위로 작은 업무부터 Runtime Box/스킬화
7. **레퍼런스** — demo-org, demo-server, 내부 full VM 운영 사례
8. **비용** — 개인 구독이 아니라 조직 실행력·감사·재사용성 관점

### 8-2. 톤 B — 현업 사용자용 (워크숍 / 온보딩)

> "내가 뭘 할 수 있는가?"

핵심 슬라이드 8장:

1. **사무실 비유** — §1-1
2. **세 가지 대화** (Session / @ai / @task) — §3-1
3. **프로젝트가 중심** — §3-2 + 폴더 구조
4. **워크플로 예시 1** — 분석 보고서 자동 작성 — §4-1
5. **워크플로 예시 2** — 채널 @ai — §4-2
6. **워크플로 예시 3** — @task 자율 작업 — §4-3
7. **스킬 카탈로그** — §3-4 조직 기본 29개 + project-local skills
8. **파일 어디 가나** — §5-1 워크스페이스 지도 + 산출물 절대경로 규칙

### 8-3. 톤 C — IT/보안 담당자용

> "안전한가? 통제 가능한가?"

핵심 슬라이드 6장:

1. **On-premise 데이터 흐름** — §7-1 도식
2. **역할 + 프로젝트 ACL + capability/credential grant** — §2 + §7-2
3. **AI 행동 통제 (Permission Mode)** — §2-4
4. **감사 트레일** — DB / git / provenance / decisions / run 기록 — §7-3
5. **Runtime Box / Sandbox 격리** — §3-5
6. **은행권 체크리스트** — §7-4 + 추가 강화 옵션

### 8-4. 톤 D — 개발자용 (사내 엔지니어링 공유)

> "어떻게 만들어졌고 어떻게 확장하나?"

핵심 슬라이드 8장:

1. **스택 + 환경 매트릭스** — §6
2. **AI 컨텍스트 5-레이어** — §5-3 + `architecture.md`
3. **세 가지 실행 경로** (Session / Channel AI / Task) — §3-1 + `ai-execution-paths.md`
4. **시스템 프롬프트 + DB policy + Runtime context** — `architecture.md` §1
5. **스킬 SSOT와 materialization** — §3-4 + `skills.md`
6. **Agent Control Plane** — §3-7 + agent decisions
7. **Hooks (SDK Options.hooks)** — §3-8
8. **Runtime Box / Sandbox / Credential Vault** — §3-5 + §3-10

### 8-5. 공통 — 시각화 추천

발표 자료에서 자주 쓰는 시각화 (Tower 채팅에서 그대로 코드블록으로 출력 → 슬라이드 export):

- **5-Layer Context Stack** → `mermaid` flowchart
- **데이터 흐름** → `mermaid` flowchart (LR)
- **Before vs After** → `comparison` 카드 또는 `datatable`
- **도입 단계** → `timeline` 또는 `steps`
- **권한 매트릭스** → `datatable`
- **스킬 카탈로그** → `treemap` (태그 / 개수)
- **워크플로** → `mermaid` sequence
- **인프라 토폴로지** → `svg` (hero) 또는 `mermaid` flowchart

---

## 9. 자주 묻는 질문 (FAQ)

**Q. ChatGPT Team 이랑 뭐가 달라요?**
A. ChatGPT Team 은 개인/팀용 AI 채팅에 가깝습니다. Tower 는 프로젝트, 파일, 권한, Credential Vault, Runtime Box, 스킬, 스케줄, Agent Worker가 묶인 회사용 Agent OS입니다. 핵심 차이는 "답변"보다 "회사 업무 구조와 실행 흔적이 남는다"는 점입니다. §1-2 표.

**Q. 인터넷 안 되는 환경에서도 써요?**
A. 부분적 가능. AI API 호출만 외부 (Anthropic) — 폐쇄망에서는 VPN/프록시 또는 로컬 LLM (향후) 옵션. 그 외 모든 기능은 사내에서 동작. `workspace/docs/tower/on-premise-install.md §폐쇄망`.

**Q. AI 가 잘못된 파일 지우면 어떡해요?**
A. (1) Permission Mode 로 사전 통제, (2) git 자동 커밋으로 복구, (3) damage-control 가드가 위험 명령 차단, (4) sandbox VM 으로 격리 실행, (5) decisions/ 는 immutable. §7.

**Q. 우리만의 스킬 만들 수 있어요?**
A. 네. 프로젝트 안 `skills/<skill>/`에서 `/skill-architect`로 만들고 검증합니다. 여러 프로젝트가 함께 쓸 수준이면 `/share-skill`로 `teamskills` 조직 정본에 diff-first 반영하고, 필요한 프로젝트에 materialize합니다. 자체 호스팅 서버 전파는 별도 명시 요청으로 `/managed-skill-rollout` 또는 `/fleet`가 처리합니다.

**Q. 발표 자료를 Tower 에서 바로 만들 수 있어요?**
A. 네. `html-slide`, `image-slide-gen`, `pptx-template`, `pptx-review`, `pdf2pptx` 등으로 HTML/PDF/PNG/native PPTX 흐름을 만들 수 있습니다. PDF는 `pdf_export` 검증 이미지를 확인하고, PPTX는 템플릿/검수 스킬을 사용합니다. §8.

**Q. 다른 회사에 보여주려면 어떻게 해요?**
A. 의사결정자용은 §8-1의 AX/Agent OS 흐름을 쓰고, 보안 담당자는 §7을 중심으로 설명합니다. 실제 제안서/슬라이드는 프로젝트 안에 만들고 필요하면 unlisted publish URL 또는 PDF/PPTX로 공유합니다.

---

## 10. 깊이 들어가려면 — 길잡이

### 10-1. 워크스페이스 안 (모든 멤버 가능)

- `workspace/docs/tower/` — 외부 영업·도입 검토용 4문서
- `workspace/docs/publishing-guide.md` — 사이트 배포 전체
- `workspace/decisions/` — 정책·구조 변경 이력 (특히 2026-03-20 project-centric, 2026-04-28~05-02 sandbox D11/D12/D13, 2026-04-23 publishing visibility)
- `workspace/principles.md` — 다섯 원칙
- `workspace/AGENTS.md` — 런타임 매뉴얼

### 10-2. 코드베이스 (admin/operator)

- `tower/docs/tower-guide/architecture.md` — 5-레이어 컨텍스트, 시스템 프롬프트 구조
- `tower/docs/tower-guide/ai-execution-paths.md` — Session / Channel AI / Task 비교 매트릭스
- `tower/docs/tower-guide/skills.md` — 스킬 시스템 3축
- `tower/docs/tower-guide/operations.md` — 환경·배포·고객
- `tower/docs/tower-guide/visual-formats.md` — 15+ 시각화 포맷 스키마
- `tower/docs/tower-guide/update-map.md` — "이걸 바꾸려면 어디를"
- `tower/docs/customer-servers.md` — 자체 호스팅 서버 목록
- `tower/AGENTS.md` — 코드 작업 시 룰

### 10-3. 스킬

- **`/tower-intro`** — *사용자용* 인터랙티브 입문·도움말 (모든 역할, self-hosted server 포함). 이 문서를 읽기 부담스럽거나 자기 자리에서 바로 뭘 해볼지 알고 싶을 때.
- `/skill-architect` — 새 스킬 만들기·검증·정제·트리거 튜닝·bloat audit
- `/share-skill` — 프로젝트 local skill을 조직 공용 `teamskills`로 공유
- `/managed-skill-rollout` / `/materialize-managed-skills` — 자체 호스팅 서버·프로젝트 runtime copy 반영과 검증
- `/runtime-box-credentials` / `/customer-credentials` — Credential Vault grant·주입 상태 진단
- `/fleet` — 자체 호스팅 서버 서버 운영·Tower 코드 배포·스킬 sync
- `/task-schedule` — 예약/반복 실행과 리포트 정책
- `/search` + `memory_search` — 과거 세션 원문/요약 검색

### 10-4. 사용자별 진입 추천

| 사용자 | 처음 읽을 것 |
|---|---|
| 임원·의사결정자 | 이 문서 §0~§2 + §8-1 |
| 현업 신규 사용자 | 이 문서 §0~§4 + §8-2 |
| IT/보안 담당자 | 이 문서 §7 + `tower/security-architecture.md` |
| 개발자 | 이 문서 §5~§6 + `tower/docs/tower-guide/` 전체 |
| 운영자 (admin) | `tower/CLAUDE.md` + `tower/docs/tower-guide/operations.md` + `update-map.md` |
| 외부 데모 / 영업 | `workspace/docs/tower/` 4문서 + 이 문서 §8-1 |

---

## 11. 용어집 (간이)

| 용어 | 한 줄 |
|---|---|
| **워크스페이스 (Workspace)** | 팀이 공유하는 파일 영역. `~/workspace/`. |
| **프로젝트 (Project)** | 채널·세션·파일·AI 컨텍스트를 묶는 1차 단위. `workspace/projects/<name>/`. |
| **세션 (Session)** | AI 와의 1:1 대화 단위. |
| **채널 (Channel) / 룸 (Room)** | 사용자 간 채팅 공간. `@ai` 호출 가능. |
| **태스크 / 스케줄** | AI가 자율·예약·반복 실행하는 작업. report policy와 run context를 가짐. |
| **스킬 (Skill)** | 재사용 가능한 AI 워크플로. 프로젝트 local source, teamskills 조직 source, `.tower/skills` runtime copy로 나뉨. |
| **결정문서 (Decision)** | 정책·구조 변경의 영구 기록. `decisions/YYYY-MM-DD-title.md`. |
| **AGENTS.md** | 프로젝트별 AI 컨텍스트. `<project>/AGENTS.md`. |
| **Permission Mode** | AI 자율 실행 강도. plan / acceptEdits / bypassPermissions. |
| **Runtime Box / Sandbox** | 프로젝트 코드를 격리 실행하는 컨테이너/실행면. `.tower/skills`와 credential grant를 사용. |
| **Publishing** | 워크스페이스 폴더를 웹으로 노출. `published/sites/<slug>/`. |
| **Agent Worker / Spawn** | 보조 AI 실행 모델. worker는 재사용 가능한 Agent Session, spawn은 사용자-visible 별도 세션. |
| **Hook** | AI tool lifecycle 의 자동 콜백. SDK Options.hooks. |
| **Fleet** | 자체 호스팅 서버 운영 명령군. `/fleet status / deploy / skills`. |
| **Profile** | 스킬 묶음 (standalone / managed / full). |
| **Credential Grant** | 프로젝트/런타임이 사용할 수 있는 secret 이름 허가. 값은 AI에게 노출되지 않음. |
| **Capability Grant** | 배포·스킬 materialize·credential grant 같은 고위험 행동 권한. |

---

## 12. 이 문서의 변경 이력

| 날짜 | 변경 | 작성자 |
|---|---|---|
| 2026-05-12 | 최초 작성 (워크스페이스 / 코드 위키 / 결정문서 / 스킬 카탈로그 통합 합성) | 줄리어스 + AI |
| 2026-05-12 | §10-3 에 `/tower-intro` (사용자용) 신설 표기 + 운영자용 핸드북 갱신 흐름의 역할 구분 명시 | 줄리어스 + AI |
| 2026-05-12 | 핸드북 갱신을 별도 운영자 흐름으로 분리하고 사용자용 `tower-intro` 는 안내/Q&A 역할로 유지 | 줄리어스 + AI |
| 2026-05-12 | 핸드북을 스킬 번들과 함께 두는 방향 확정. 과거 provider-specific 정본은 legacy compatibility가 되었고, 현재 managed source는 `skills/managed/tower-intro/handbook.md`. | 줄리어스 + AI |
| 2026-05-12 | 사용자 진입은 모두 스킬 호출(`/tower-intro`)로 일원화. 파일 경로는 사용자에게 직접 안내하지 않는다. | 줄리어스 + AI |
| 2026-05-13 | 운영자 유지보수 흐름은 `tower-intro` 핸드북 갱신으로 정리. 현재 정본은 managed bundle source `skills/managed/tower-intro/handbook.md`. | 줄리어스 + AI |
| 2026-06-26 | AX/Agent OS 포지셔닝, Project Runtime Box, teamskills SSOT, Credential Orchestrator, Agent Session 통합, task/schedule 리포트 정책, UI Action Bus 방향 반영. | 줄리어스 + AI |

---

## 13. 갱신 — managed `tower-intro/handbook.md` source와 함께

이 문서는 *합성물*이라 원본이 바뀌면 자연히 stale 해집니다. 갱신은 `workspace/projects/teamskills/skills/tower-intro/handbook.md` 조직 정본과 `tower/skills/managed/tower-intro/handbook.md` Tower seed/reference를 함께 갱신합니다. 일반 조직 배포 기준은 teamskills이며, Tower repo copy는 제품 seed/reference입니다.

### 13-1. 언제 갱신해야 하나 (트리거)

- `workspace/decisions/` 에 *정책·구조* 결정문서 추가 (특히 architecture / publishing / sandbox / spawn / hooks / skills)
- `tower/docs/tower-guide/` 위키 갱신
- `workspace/projects/teamskills/skillset.json` 또는 `config/skills/managed-skills.yaml` 의 skill catalog/default set 변경
- `tower/templates/workspace/AGENTS.md` 변경
- 자체 호스팅 서버 추가·제거
- 시각화 포맷 추가
- AI 실행 경로 신설

### 13-2. 갱신 절차

```
/skill-architect refine tower-intro
```

스킬이 자동으로:
1. 최근 결정문서 신규 (`workspace/decisions/` git log) 검토
2. `tower/docs/tower-guide/` 의 갱신일 비교
3. `teamskills/skillset.json` 과 `config/skills/managed-skills.yaml` 정합성 확인
4. 변경 후보를 섹션별로 매핑해서 반영
5. `SKILL.md` 토픽 매핑·tour 문구와 handbook 섹션 번호 정합성 검증
6. teamskills source와 Tower seed/reference를 동기화

수동 갱신도 OK — 그냥 이 파일을 Edit 하고 §12 변경 이력에 한 줄 추가하면 됩니다. *작은 갱신 > 미루다 stale*.

### 13-3. 갱신 책임자

- 워크스페이스 운영자 (admin/operator)
- 큰 변경 시 사용자 합의 후 `workspace/decisions/` 에 결정문서 한 장
- 한 달에 한 번 (= 원칙 5 "Revisit") 신선도 확인

---

> 이 문서가 stale 하다고 느끼면 `/skill-architect refine tower-intro` 관점으로 handbook + SKILL.md + teamskills copy를 함께 갱신하고 §12에 한 줄 남기십시오.
> 더 깊이 들어가야 하면 §10 의 길잡이.
> 새 발표 자료가 필요하면 §8 의 톤별 슬라이드 묶음을 골라 사용.

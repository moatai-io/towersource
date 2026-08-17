> ⚠️ **이 저장소는 2026-04-27 비공개로 전환됩니다.**
> 자세한 내용은 [#9](https://github.com/juliuschun/tower/issues/9) 참조.
> 마지막 공개 커밋은 [`v1.0-last-oss`](https://github.com/juliuschun/tower/releases/tag/v1.0-last-oss) 태그로 보존됩니다.

# Tower

> **팀 전체가 함께 쓰는 AI 커맨드 센터.**
> Claude Code + 에이전트 + 실제 파일시스템을 웹 앱으로 제공 — 개발자가 아니어도 브라우저만 열면 바로 사용.

[![License](https://img.shields.io/badge/license-Apache_2.0-blue.svg)](LICENSE)
[![Status](https://img.shields.io/badge/status-research_alpha-orange)]()
[![Last commit](https://img.shields.io/github/last-commit/juliuschun/tower)](https://github.com/juliuschun/tower/commits)

🌐 [English](README.md) · [한국어](README.ko.md) · [설치 가이드](INSTALL.md) · [아키텍처](docs/tower-guide/architecture.md)

<p align="center">
  <img src="capture-chat.png" alt="Tower — 모든 AI 대화를 Google Docs처럼 공유" width="720" />
</p>

AI를 팀 전체가 함께 쓸 수 있다면 어떨까요? 한 사람이 AI에게 물어본 것을 다른 팀원도 볼 수 있고, AI가 한 번 배운 것이 회사 전체에 남는다면요.

Tower는 AI와의 모든 대화를 Google Docs처럼 공유합니다. 하나의 파일시스템 위에서 하나의 메모리를 나눠 쓰고, 개발자가 아니어도 터미널을 몰라도 브라우저만 열면 바로 시작할 수 있습니다.

*실전 운영 중. 출시 2주 만에 $20K 매출.*

<p align="center">
  <img src="diagram-tower.png" alt="Tower — 팀 전체가 기여하고, 지식이 쌓이고, 모두가 혜택을 받는다" width="560" />
</p>

---

## 목차

- [문제 정의](#문제-ai는-혼자-쓰게-되어-있습니다)
- [해법](#해법-ai를-google-docs처럼-공유합니다)
- [코드 실행](#코드도-실행합니다-cli-없이)
- [채널 AI & 프로액티브 에이전트](#채널-ai--프로액티브-에이전트)
- [자동화 & 에이전트 보드](#자동화--에이전트-보드)
- [퍼블리싱 & Deploy Engine](#퍼블리싱--deploy-engine)
- [스킬이 스킬을 만듭니다](#스킬이-스킬을-만듭니다)
- [멀티 엔진 AI](#멀티-엔진-ai)
- [Tower의 차별점](#tower의-차별점)
- [기술 스택](#기술-스택)
- [변경 이력](#변경-이력)
- [시작하기](#시작하기)
- [상태 & 로드맵](#상태--로드맵)

---

## 문제: AI는 혼자 쓰게 되어 있습니다

ChatGPT, Claude Code, Copilot — 전부 훌륭한 도구입니다. 그런데 이 도구들은 하나같이 한 사람의 화면 안에 갇혀 있습니다. 대화는 개인 계정마다 흩어지고, AI가 한 세션에서 배운 것은 세션이 끝나는 순간 사라지고, 같은 질문을 다른 팀원이 다시 하고, 비개발자는 터미널 앞에서 멈춥니다.

Claude Code처럼 지금 존재하는 가장 강력한 코딩 에이전트조차, 결국 한 사람의 터미널 안에 살고 있습니다. 그 사람만 혜택을 받고, 나머지 팀원에게는 아무것도 남지 않습니다.

전 직원에게 AI 구독을 줄 수는 있습니다. 하지만 그것만으로는 AI-augmented 조직이 되지 않습니다. AI를 각자 따로 쓰는 사람들이 같은 사무실에 모여 있을 뿐이니까요.

---

## 해법: AI를 Google Docs처럼 공유합니다

### 대화가 공유됩니다

AI와 나눈 모든 대화가 팀에게 열립니다. 누가 어떤 질문을 했고, AI가 어떤 답을 줬고, 그 과정에서 어떤 결정이 내려졌는지 — 프로젝트별로 정리되어 있어서 회사의 AI 업무 현황이 한눈에 들어옵니다.

"그때 Claude한테 뭐라고 했더라?" 같은 질문은 이제 할 필요가 없습니다. 그냥 보시면 됩니다. 외부에 공유할 때는 세션 하나를 **공유 링크**로 발행할 수도 있습니다.

### 파일시스템 하나, 메모리 하나

하나의 서버 위에 하나의 파일시스템, 그리고 사람이 바뀌고 시간이 흘러도 유지되는 하나의 메모리가 있습니다.

월요일에 누군가 AI에게 가르친 것을 금요일에 합류한 신입이 그대로 씁니다. 세션·프로젝트·팀으로 나뉜 3계층 메모리 덕분에 한 번 배운 것은 사라지지 않습니다.

버전 관리도 자동으로 이루어집니다. 모든 변경이 기록되고, 언제든 열어볼 수 있고, 필요하면 되돌릴 수도 있습니다. Git을 배울 필요 없이, 그냥 파일을 관리하는 것처럼 느껴집니다. **CLI 지식은 전혀 필요하지 않습니다.**

### 팀별로 나눕니다

마케팅은 개발 코드를 볼 수 없고, 개발은 HR 문서를 볼 수 없습니다. 하지만 협업이 필요한 순간에는 자연스럽게 넘나들 수 있습니다.

프로젝트·부서·팀·개인 — 우리 조직의 구조에 맞게 자유롭게 나눌 수 있습니다. 4단계 권한 체계(`admin` / `operator` / `member` / `viewer`)와 폴더 단위 격리(`allowed_path`)를 지원합니다.

```
workspace/
├── projects/
│   ├── marketing-site/
│   │   └── AGENTS.md    ← "브랜드 톤은 캐주얼. Next.js 사용."
│   ├── api-backend/
│   │   └── AGENTS.md    ← "Go 사용. 회사 스타일 가이드 준수."
│   └── onboarding-docs/
│       └── AGENTS.md    ← "비개발자 눈높이로 작성."
└── decisions/            ← 팀 결정 기록
```

---

## 코드도 실행합니다. CLI 없이.

<p align="center">
  <img src="diagram-access.png" alt="Tower — 어떤 디바이스에서든 메시지가 실제 업무가 된다" width="640" />
</p>

Tower는 서버 위에서 돌아갑니다. AI가 대화만 하는 게 아니라, 코드를 쓰고 파일을 만들고 앱을 배포하고 데이터를 분석하는 것까지 직접 실행합니다. 개발 환경의 풀파워를 브라우저 하나로 쓸 수 있습니다.

마케팅 리드가 랜딩 페이지를 만들고, 운영 매니저가 주간 보고서를 자동화하고, 인턴이 데이터 분석을 돌립니다. 터미널이 뭔지 몰라도 전혀 상관없습니다.

---

## 채널 AI & 프로액티브 에이전트

대부분의 AI 도구는 당신이 먼저 묻기를 기다립니다. Tower의 AI는 팀 안에 살아 있습니다 — 채팅 속, 업무의 흐름 속에.

- **`@ai` — 채널에 상주하는 AI 파트너.** 아무 팀 채널에서든 `@ai`를 부르면 최근 메시지와 프로젝트 컨텍스트(`AGENTS.md`)를 읽고 스레드 안에서 답합니다. 일회성이 아니라 멀티턴 대화. 팀원 모두가 대화를 볼 수 있습니다.
- **`@task` — 채널에서 바로 태스크 실행.** 메시지 하나를 자율 실행되는 태스크로 넘길 수 있습니다.
- **AI 사이드 패널.** 채널 옆에 열리는 비공개 AI 스레드. AI가 이미 채널 컨텍스트를 알고 있어서 혼자 물어보고, 준비되면 답변만 채널에 공유할 수 있습니다.
- **프로액티브 에이전트.** AI가 먼저 말을 겁니다. 실패한 빌드, 멈춘 태스크, 다가오는 마감일을 **Inbox**에 카드 형태로 띄워줍니다.
- **세션 공유.** 어떤 대화든 공개 링크로 발행 — 라이트 모드 채팅 UI, 시각화, 첨부까지 그대로 유지.

---

## 자동화 & 에이전트 보드

<p align="center">
  <img src="capture-board.png" alt="Tower — 에이전트 보드" width="720" />
</p>

**에이전트 보드(칸반).** 태스크를 만들면 AI가 알아서 실행합니다. 태스크가 또 다른 태스크를 만들기도 합니다. "제품 런칭 기획"이라는 태스크 하나가 시장 조사, 경쟁사 분석, 가격 전략, 타임라인으로 쪼개져서 각각 자율적으로 돌아갑니다.

**통합 자동화.** 태스크와 스케줄이 하나의 모델로 합쳐졌습니다. 한 번 실행, 크론 반복 실행, 이벤트 트리거 실행. 3가지 모드:

- **Spawn** — 매번 새 세션 (클린 컨텍스트)
- **Inject** — 기존 세션에 이어붙이기 (컨텍스트 유지)
- **Channel** — 결과를 팀 채널에 포스팅

주간 보고서, 아침 스탠드업 요약, 반복 시장 조사 — 스스로 굴러가게 만드세요.

---

## 퍼블리싱 & Deploy Engine

<p align="center">
  <img src="capture-publish.png" alt="Tower — 퍼블리싱 허브" width="720" />
</p>

**퍼블리싱 허브.** AI가 만든 결과물을 라이브 사이트로 전환. `workspace/published/sites/<name>/` 아래 파일을 넣으면 `<name>.<yourdomain>`에서 즉시 서빙됩니다. nginx 수정도, DNS 설정도 필요 없습니다.

**Deploy Engine.** 코드 타입 자동 감지:

- 정적 사이트 → **Cloudflare Pages** (글로벌 CDN, 2초 배포)
- 동적 앱 → **Azure Container Apps** (스케일 투 제로, ACR 빌드, Dockerfile 자동 생성)
- API 콜 한 번, 설정 없음. Cloudflare DNS 바인딩까지 자동화.

**REST API:** `POST /api/deploy`, `GET /api/deploy/list`, `DELETE /api/deploy/:type/:name`.

---

## 스킬이 스킬을 만듭니다

AI가 팀 전체와 일하면서 하나의 파일시스템과 하나의 메모리에 연결되어 있으면, 흥미로운 일이 일어납니다. 복리가 붙기 시작합니다.

한 번 했던 작업이 재사용 가능한 스킬이 되고, 그 스킬이 다음 스킬을 낳습니다. 팀의 AI가 매일 조금씩, 저절로 나아집니다.

**예시:** 누군가 견적서 생성기를 만들면 거기서 제안서 스킬이 파생되고, 다시 계약서 스킬로 발전합니다. 하나하나가 이전 것 위에 쌓이고, 팀 전원이 쓸 수 있습니다.

**50개 이상의 스킬이 기본 탑재** — 브레인스토밍, 디버깅, 코드 리뷰, 기획, UI/UX 디자인, 리서치, 문서 생성, 프레젠테이션 덱, Google Workspace(Gmail/캘린더/드라이브/시트), SMS, 웹 캡처, 원격 브라우저, 칸반, 자연어→SQL 등.

3단계 스코프(company / project / personal)와 **Skills Market** UI, 사용자별 on/off 토글. OAuth/API 키가 필요한 스킬은 **Connections** 플로우로 안내 — 팀 공용 자격증명이 LLM에 직접 노출되지 않습니다.

---

## 그 밖에

**모바일.** 반응형 UI. 롱프레스 컨텍스트 메뉴, 터치 최적화 스크롤, 원격 브라우저(Neko) 자동 로그인. 폰에서도 서버 컴퓨팅을 그대로.

**파일 공유.** 팀 내부 공유 + 시간 제한 외부 링크. 별도 공유 서비스 불필요.

**전체 검색.** 파일, 대화, 태스크, 커밋 히스토리까지 — PostgreSQL `pg_trgm` GIN 인덱스로 한글 + 영문 풀텍스트 검색.

**Usage 대시보드.** 일별 턴 라인차트, 프로젝트별 집중도 히트맵, 사이드바 실제 대화 턴 수. AI 시간이 어디에 쓰이는지 보이게.

**이중 언어.** 한글/영문 UI 완전 지원(i18n), 용어 일관성 유지.

**Fleet Management.** Tower를 여러 고객에게 운영 중이신가요? 한 컨트롤 플레인으로 여러 VM 관리 — 퍼블리싱 게이트웨이, 스킬 프로파일(`standalone` / `managed` / `full`), 2계층 백업(로컬 + 오프사이트 Azure Blob), 라이브 연결성 UI.

---

## 멀티 엔진 AI

Tower는 특정 AI 제공자에 묶여 있지 않습니다. Engine 추상화 레이어 덕분에 여러 백엔드를 동시에 돌릴 수 있습니다:

| 엔진 | 제공자 | 과금 | 모델 |
|--------|----------|---------|--------|
| **Claude Code** | Anthropic Agent SDK | Max 구독 ($200/월) | Opus 4.8, Sonnet, Haiku |
| **Pi Agent** | OpenRouter 경유 Pi SDK | 토큰 단위 | 모든 OpenRouter 모델: Claude, GPT, Gemini, Grok, Kimi, MiniMax… |
| **Local LLM** | OpenAI 호환 엔드포인트 | 자체 하드웨어 | 로컬 호스팅된 모든 모델 |

대화 중에 모델 전환. 제공자별 출력 비교. Claude Max로 시작해서 필요할 때 OpenRouter 추가. 엔진 하나를 빼려면 파일 하나만 지우면 됩니다.

사용 가능한 모델은 `packages/backend/engines/pi-models.json`에서 설정 — 코드 변경 불필요.

---

## Tower의 차별점

| | **Tower** | Claude Code CLI | OpenWebUI / LibreChat |
|---|:---:|:---:|:---:|
| 팀 대화 공유 | ✓ | — | 부분적 |
| 실제 파일시스템 + Git 자동 커밋 | ✓ | ✓ | — |
| 코드 실행 / 앱 배포 | ✓ | ✓ | — |
| 사람을 넘어서는 공유 메모리 | ✓ | — | — |
| 비개발자 사용 가능 | ✓ | — | ✓ |
| 채널 AI (`@ai` / `@task`) | ✓ | — | — |
| 프로액티브 에이전트 (AI가 먼저) | ✓ | — | — |
| 멀티 엔진 (Claude + Pi + Local) | ✓ | Claude 전용 | 멀티 프로바이더 |
| 칸반 + 크론 자동화 | ✓ | — | — |
| 퍼블리싱 + 배포 파이프라인 | ✓ | — | — |
| 셀프 호스팅 | ✓ | ✓ | ✓ |

**한 줄 요약:** OpenWebUI는 팀이 LLM을 쓰는 채팅 UI. Claude Code는 개발자 한 명에게 파일 접근이 가능한 터미널 에이전트. Tower는 이 둘을 합치고, 그 위에 팀 배관(메모리·격리·자동화·퍼블리싱)을 얹은 것.

---

## 기술 스택

| 레이어 | 기술 |
|--------|------|
| **프론트엔드** | React 18 · TypeScript · Vite 6 · Zustand · Tailwind CSS 4 · Virtuoso |
| **백엔드** | Express · TypeScript · WebSocket · PM2 |
| **저장소** | PostgreSQL 18 (단일 primary DB) · `pg_trgm` GIN 인덱스로 전문 검색 · `pgvector`로 임베딩 |
| **AI 엔진** | `@anthropic-ai/claude-agent-sdk` (Opus 4.8) · OpenRouter 경유 `@mariozechner/pi-coding-agent` · OpenAI 호환 로컬 LLM · MCP 프로토콜 · 50+ 스킬 |
| **인증** | JWT · bcrypt · 역할 기반 (`admin` / `operator` / `member` / `viewer`) · 폴더 단위 `allowed_path` |
| **모노레포** | `packages/backend` · `packages/frontend` · `packages/shared` |

---

## 변경 이력

### 4/20 — 태스크 에이전트 가드레일 + 채널 AI 정비
- **채널 AI 프로젝트 컨텍스트** — 팀 채팅의 `@ai`가 프로젝트 `AGENTS.md`와 최근 메시지를 자동 인식
- **AI 스레드 자동 네이밍** — 첫 턴 기반으로 읽기 좋은 이름 부여
- **태스크 에이전트가 팀 규율 상속** — 아키텍처 체크, decision-log, 커밋 규칙을 태스크마다 주입
- **CWD → 프로젝트 매핑 통합** — 태스크·세션의 작업 디렉토리가 항상 표시됨
- **프로젝트 생성 중복 방지** — 빠른 submit에서 폴더가 두 번 생기던 문제 수정

### 4/17–18 — Opus 4.7, 채널 AI 2.0, Prefix Caching, Self-hosted VM 인프라
- **Claude Opus 4.7** 업그레이드 + effort 파이프라인 (low / med / high 추론 예산)
- **`@ai`가 채널 상주 파트너로 승격** — 일회성이 아닌 멀티턴 스레드
- **시스템 프롬프트 prefix 캐싱** — Anthropic 캐시용으로 프롬프트 분리, room 컨텍스트를 user 프롬프트로 이동
- **채팅 내 리치 비주얼** — 인라인 `svg` 블록 + `html-sandbox` (JSON/aspect 모드), Linear 스타일 Mermaid 리디자인
- **세션 스코프 쓰기 가드** — AI가 고아 프로젝트 폴더를 만들지 못하도록 차단
- **Self-hosted VM용 Neko 원격 브라우저 자동 설치**, 게이트웨이 상태 엔드포인트, 라이브 플릿 UI
- **2계층 백업 아키텍처** — 로컬 스냅샷 + 오프사이트 Azure Blob (자체 서버 + 자체 호스팅 서버)
- **스킬 라이브러리 단일 소스화** — 매니페스트 기반 재조정, 레거시 `install-skills.sh` 제거

### 4/13–15 — 자동화, Fleet, 세션 공유, i18n
- **자동화 시스템** — 태스크와 스케줄을 하나의 모델로 통합 (`spawn` / `inject` / `channel`)
- **통합 칸반** — 2컬럼 레이아웃 + 스케줄 통합, AM/PM 피커, 런 버튼 노출
- **세션 공유** — 공개 공유 링크, 라이트 모드 채팅 UI, HTML 렌더링, 첨부 보존
- **Fleet Management** — 여러 자체 호스팅 서버을 한 컨트롤 플레인에서 관리 + 퍼블리싱 게이트웨이
- **Cloudflare DNS 자동화** — 명령어 한 번으로 퍼블리시된 사이트에 서브도메인 바인딩
- **한/영 이중 언어 UI** — 용어 일관성 유지 (Inbox = 완료, Task = 태스크)
- **스킬 자격증명 + Connections UI** — gmail/gws 스킬 Google OAuth 플로우, Skill Readiness 뷰
- **Tower Guide 위키** — 아키텍처 · 스킬 · 비주얼 포맷 · 운영 문서 리포지토리 내 정리

### 4/10–12 — 프로액티브 에이전트, Usage 대시보드, 실시간
- **프로액티브 에이전트** — AI가 먼저 말을 거는 시스템, Bell → Inbox 흐름, 카드 UX
- **Usage 대시보드** — 일별 턴 라인차트, 프로젝트별 집중도 히트맵, 사이드바 실제 턴 수
- **Local LLM 엔진** — Claude, Pi에 이은 3번째 엔진
- **세션별 모델 셀렉터** — 모델 선택이 해당 세션에만 적용
- **실시간 동기화** — 프로젝트·채널·세션·알림 팬아웃 WS 이벤트 핸들러
- **PPTX 미리보기** LibreOffice → PDF 변환 방식으로 교체

### 4/6 — Deploy Engine
- 코드 타입 자동 감지(정적 vs 동적) 후 올바른 플랫폼에 배포
- 정적 → Cloudflare Pages (글로벌 CDN, 2초 배포)
- 동적 → Azure Container Apps (스케일 투 제로, ACR 빌드, Dockerfile 자동 생성)
- REST API: `POST /api/deploy`, `GET /api/deploy/list`, `DELETE /api/deploy/:type/:name`
- Manifest 스키마에 `deploy_target`, `external_url`, `last_deployed_at` 추가

### 3/17 — AI 사이드 패널 & 통합 가시성
- 채널용 AI 사이드 패널 — 팀 채팅 옆에 비공개 AI 스레드
- 채널 컨텍스트 주입 — 최근 30개 메시지 자동 인식
- 채널로 공유 — AI 답변을 팀에 게시
- 통합 가시성 모델 — `private` / `project` 세션 스코프

### 3/16 — 모노레포 + 채널 AI (`@ai` / `@task`)
- `packages/backend`, `packages/frontend`, `packages/shared` 구조 + `@tower/shared`
- 채널에서 `@ai` 인라인 빠른 답변, `@task` 풀 태스크 실행
- Admin이 컨텍스트(`session` / `ai_reply` / `ai_task`)별 기본 모델 설정

### 3/14–15 — 멀티 엔진 아키텍처 + 3계층 스킬
- Engine 추상화 (Claude + Pi) — OpenRouter 경유 Pi Agent SDK, 모든 모델
- DB 기반 스킬 관리 (company / project / personal) + Skills Market UI
- `pi-models.json`로 모델 설정, 세션 내 핫스왑

### 3/13 — 다이나믹 비주얼
- Mermaid · 차트 (Recharts) · KaTeX · datatable · timeline · treemap · mindmap · gallery · diff · terminal · comparison
- `RichContent` 컴포넌트 + 코드 스플릿 지연 로딩

### 이전
- **SQLite → PostgreSQL 전면 이관 완료** — 단일 primary DB, `better-sqlite3` 의존성 제거
- 에이전트 보드(칸반) + 자율 태스크 실행
- 파일 공유 (내부 + 외부 링크)
- 풀텍스트 검색 (`pg_trgm` GIN 인덱스, 한글 + 영문)
- 퍼블리싱 허브 — AI 산출물을 원클릭 배포
- Git 자동 커밋 + 히스토리 브라우저
- 역할 기반 인증 + 폴더 단위 `allowed_path`

---

## 시작하기

```bash
git clone https://github.com/juliuschun/tower.git
cd tower
bash setup.sh    # 설치 + 몇 가지 질문
npm run dev      # → http://localhost:32354
```

자세한 내용은 **[INSTALL.md](INSTALL.md)**를 참고해 주세요 — Ubuntu 사전 요구사항, Claude CLI 인증, Pi/OpenRouter 설정, PostgreSQL 18, Azure VM 배포, Cloudflare 터널, 트러블슈팅, 보안 체크리스트.

---

## 상태 & 로드맵

### 상태: Research Alpha

매일 실전에서 쓰고 있고, 잘 돌아가고 있습니다. 다만 아직 다 만들지는 않았습니다.

일부 기능은 다듬는 중이고 새로운 기능도 계속 기획·출시되고 있습니다. 목적지는 분명합니다: **팀원 100%가 AI와 일하는 조직.**

### 근시일 로드맵

- **멀티 유저 워크스페이스 격리 (Phase 8)** — 백엔드 레벨 유저별 샌드박싱 완성
- **SSO / SAML** — 엔터프라이즈 디렉토리 연동
- **Heartbeat Phase 2** — 비용 대시보드 영속화, @멘션 알림, 알림 규칙
- **팀 레벨 메모리** — 세션/프로젝트 위에 명시적 팀 스코프 레이어
- **네이티브 모바일 셸** (검토 중)

피드백과 기여를 환영합니다 — [이슈](https://github.com/juliuschun/tower/issues)를 열거나 PR을 보내주세요.

## 라이선스

[Apache License 2.0](LICENSE)

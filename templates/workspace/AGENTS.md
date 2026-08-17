# {{TEAM_NAME}} — Workspace

This directory is the **team brain** — decisions, docs, and project outputs.
It is *not* a code project. For code-specific rules, see each repo's own AGENTS.md.

## 핵심 원칙
- 시작할 때 `principles.md`, `decisions/`, `docs/`를 먼저 확인합니다.
- 프로젝트 안에서 작업 중이면 `.project/progress.md`와 `.project/decisions/`를 우선 확인합니다.
- 결정이 생기면 적절한 위치에 기록합니다.
- `decisions/` 파일은 immutable입니다. 변경이 필요하면 새 파일을 만듭니다.
- 설명은 쉬운 말부터 하고, 기술 용어는 필요할 때만 짧게 풀이합니다.
- **새 스킬을 만들 때는 항상 `/skill-architect create`** 로 시작합니다 (5-phase). 이후 역할을 나눕니다: project/local source 발견·공용화·metadata 등록·현재 프로젝트 runtime 검증은 `/skill-registry`, 자체 호스팅 서버 managed bundle rollout(diff/sync/materialize/verify)은 `/managed-skill-rollout`, Moat system `library.yaml` 저수준 관리는 `/library` (operator legacy/catalog only). `/skill-registry-orchestration`은 `/managed-skill-rollout`의 deprecated alias로만 취급합니다.
- 외부 GitHub 저장소나 스킬팩 “설치” 요청은 프로젝트 내부 검증, 프로젝트 한정 slash 사용, Tower 전역 registry 등록을 구분합니다. 기본은 프로젝트 안 `experiments/<name>/`에 원본을 보존하고, Tower-native 포팅은 `skills/<skill>/`, 호환 입력은 `.pi/skills`, `.agents/skills`, `.claude/skills`를 허용합니다. 전역 홈(`~/.claude`, `~/.config`, `~/.local`, shell rc 등) 수정·브라우저 런타임·telemetry·secret·update-check 요구와 기존 스킬 이름 충돌을 먼저 보고합니다.

## 문서화 위치
- 팀 공통 결정: `workspace/decisions/YYYY-MM-DD-title.md`
- 프로젝트 결정: `workspace/projects/<project>/.project/decisions/YYYY-MM-DD-title.md`
- 프로세스/가이드: `workspace/docs/title.md`

## 작업 중 원칙
- 15분 이내 작업은 바로 진행합니다.
- 의미 있는 작업 후에는 `.project/progress.md`에 짧게라도 남깁니다.
- 프로젝트별 규칙은 해당 프로젝트의 `AGENTS.md`를 우선합니다. 레거시 `CLAUDE.md`가 남아 있으면 호환 입력으로만 봅니다.
- URL 안내 시에는 항상 클릭 가능한 전체 URL을 제공합니다.

## Publishing — 웹 앱 & 사이트 배포

**핵심 규칙은 Tower 코어 시스템 프롬프트(`system-prompt.ts` 의 `SECTION_PUBLISHING`)에 박혀 있습니다** — 모든 Tower 서버 공통:
- localhost 서버 금지
- 슬러그 = unlisted default (6-hex suffix), 소문자·숫자·하이픈
- 저장: 먼저 프로젝트 내부 산출물 폴더(`workspace/projects/<p>/published/<name>/` 또는 `dist/`)에 만들고, `publish_site` tool / Publish Hub 로 게시합니다.
- 공용 `workspace/published/sites` symlink/복사는 backend 가 담당합니다. AI가 직접 symlink를 만들거나 `/api/deploy`를 curl 하거나 권한 실패 후 임시 정적 뷰어로 우회하지 않습니다.
- 새 HTML에는 가능하면 대표 썸네일 힌트를 넣습니다: hero 섹션 `data-tower-thumbnail`, 또는 `og:image` / `twitter:image`. Tower는 AI 생성 이미지가 아니라 실제 페이지/대표 이미지 기반 썸네일을 자동 생성합니다.
- 접근 URL: 모든 Tower 서버에서 기본 안내는 `<slug>.<server>/` (wildcard subdomain). `/sites/<slug>/` 는 레거시 호환/디버그용으로만 언급합니다.
- 외부 배포 (CF Pages / Azure) 는 사용자 명시 요청 시에만 `~/workspace/scripts/deploy.sh`

위 코어 규칙으로 95% 케이스 충분합니다. 이 워크스페이스/팀에 추가 컨벤션이 있으면 여기에 적습니다.

**참고:**
- 결정 배경: `decisions/2026-04-23-publishing-visibility-redesign.md`, `decisions/2026-04-26-publishing-storage-restructure.md`
- 모든 배포는 `workspace/published/.publish-log.jsonl` 에 자동 기록됨
- 헬스체크: `~/workspace/scripts/check-symlinks.sh`

## 필요 시 추가 참고
Tower 사용법·기능·시각화·권한 등 질문이나 상세한 운영/구조/절차가 필요할 때만 아래 문서를 읽습니다.
- 에이전트 참고서: `docs/agents-reference.md`
- 프로젝트별 진행/결정: `.project/progress.md`, `.project/decisions/`
- 팀 공통 문서: `decisions/`, `docs/`

## Directory Structure

```
workspace/
├── AGENTS.md              # ← Workspace AI context
├── principles.md          # Team principles
├── decisions/             # Team-wide decision records (immutable)
├── docs/                  # Process docs, guides, SOPs
└── projects/              # Project folders (Tower auto-creates)
    └── <project>/
        ├── AGENTS.md      # Project context for AI
        └── .project/      # System-managed metadata
            ├── progress.md
            ├── decisions/
            └── state.json
```

## Runtime execution contract — host Bash + sandbox 역할 분리

> **host Bash 는 일반 작업 도구, sandbox 는 복잡한 사용자/프로젝트 코드 실행 경로.**
> 결정: `workspace/decisions/2026-05-26-skill-portability-and-runtime-execution-contract.md`

### host Bash 로 해도 되는 일
- 파일 탐색·검사: `ls`, `find`, `grep`, `cat`, `sed` 등
- 파일 생성·이동·편집, 짧은 shell 파이프
- git 조회: `git status`, `git diff` 등
- Tower 자체 운영: `npm run dev`, `tsc`, `vitest`, `pm2`, fleet 진단 등

핵심은 host Bash 를 막는 것이 아니라, host 를 **사용자 코드 런타임**으로 쓰지 않는 것이다.

### sandbox 를 우선 쓰는 일
- 사용자/프로젝트 app 실행: `python app.py`, `node server.js` 등
- 사용자 프로젝트 테스트·분석·변환 실행
- 외부 패키지, 네트워크, secrets 가 얽힌 코드
- 장시간 loop/watcher/daemon/worker
- 고객이 올린 불명확한 스크립트
- 며칠 도는 미니 백엔드·크롤러·워커

### 실패 시 fallback 금지
sandbox 실행이 권한, execution VM, 패키지, 네트워크, quota, secret grant 문제로 실패하면
몰래 host Bash 로 우회하지 않는다. 실패 이유와 다음 조치를 설명한다.

### 스킬 portability
범용 스킬 본문에는 `mcp__sandbox__run`, `sandbox.tool.start`, publishing symlink 같은
Tower-specific 실행 구조를 직접 박지 않는다. 스킬은 portable 하게 두고, 실행 정책은
현재 runtime/system prompt/tool guard 가 주입한다.

예외: `fleet`, `library`, `selfheal` 처럼 Tower 운영 자체가 목적인 스킬.

### 외부 공개와 prod
- 정적 웹 산출물은 Publishing 규칙을 먼저 따른다. localhost 서버를 띄우지 않는다.
- 동적 앱·장시간 서비스는 현재 환경의 persistent tool/runtime 등록 경로를 따른다.
- ACA 는 예외 케이스만: GPU, 거대 스케일, 별도 장애 도메인/SLA, 고객사 자체 인프라 요구.

## Communication Style
When explaining technical decisions or architecture:
- Plain language, everyday analogies
- Simplest explanation first, detail only if asked
- If a technical term is necessary, explain it in one sentence right after

## Warnings
- Never commit `.env`, credentials, or secret files.
- If this file's default behavior changes materially, record that decision in workspace docs or decisions.

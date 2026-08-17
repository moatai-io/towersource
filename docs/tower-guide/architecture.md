# Tower 컨텍스트 아키텍처

Tower에서 Claude가 받는 컨텍스트는 5개 레이어가 누적(append)됩니다.

## 5-Layer Context Stack

```
┌──────────────────────────────────────────────────┐
│ ① 시스템 프롬프트 (system-prompt.ts)              │  ← 모든 세션
│    섹션 상수 + 모드 플래그 구조                     │
│    chat 모드(~11KB): core+behavior+safety+collab+viz │
│    task 모드(~3KB) : core+behavior+safety+mini-hint │
│    + Org policy(DB) + Runtime context(유저/역할/경로) │
├──────────────────────────────────────────────────┤
│ ① ' Task user-prompt preamble (task-runner.ts)   │  ← @task 전용
│    3대 가드레일(architecture check/decision log/commit) │
│    세션 UI와 .jsonl에 첫 user 메시지로 노출         │
├──────────────────────────────────────────────────┤
│ ② 글로벌 사용자 설정 (~/.claude/CLAUDE.md)        │  ← 외부 SDK 호환 계층
│    ASCII 규칙, 링크 규칙, dev 경고                 │
├──────────────────────────────────────────────────┤
│ ③ 프로젝트 AGENTS.md (cwd의 AGENTS.md)            │  ← cwd 기준 자동 로딩
│    tower/ 또는 workspace/ 또는 프로젝트별          │
├──────────────────────────────────────────────────┤
│ ④ 스킬 descriptions (scope별 skill sources)       │  ← 활성 목록 로딩
│    system/company + personal/project + project fs │
├──────────────────────────────────────────────────┤
│ ⑤ 메모리 (MEMORY.md + hooks)                      │  ← 프로젝트별 자동
│    학습 패턴, 세션 히스토리                         │
└──────────────────────────────────────────────────┘
```

## 레이어별 상세

### ① 시스템 프롬프트

- **파일**: `packages/backend/services/system-prompt.ts`
- **구조**: 3레이어 × 모드 플래그.
  - Layer A **Core** (코드) — 섹션 상수 조립. 모드별 구성:
    - `'chat'` (기본): INTRO + IDENTITY + BEHAVIOR + SAFETY + COLLABORATION + VISUALIZATION (18종 블록 가이드). ~11KB.
    - `'task'`: INTRO + IDENTITY + BEHAVIOR + SAFETY + TASK_VISUAL_HINT (datatable/mermaid 2줄). ~3KB.
  - Layer B **Org policy** (DB) — `system_prompts.default` 행. Admin > System Prompts에서 편집 가능.
  - Layer C **Runtime context** — 유저/역할(admin/operator/member/viewer)/경로 제한/프로젝트 경계. 세션 단위로 동적.
- **모드 선택**:
  - 채팅 세션(Claude/Pi/Local 엔진, @ai quick-reply): 모두 `'chat'` 기본값.
  - 태스크 실행(@task, task-runner): `mode: 'task'` 전달 → 비주얼 가이드 생략, 턴당 ~2K 토큰 절약.
- **섹션 추가 방법**: `SECTION_*` 상수 정의 → `buildCoreSystemPrompt()`의 해당 모드 배열에 push. 관리 포인트 1파일.
- **적용**: `claude-engine.ts`, `pi-engine.ts`, `local-engine.ts`, `ai-quick-reply.ts`, `task-runner.ts` 모두 `buildSystemPrompt()` 공용 호출.
- **변경**: 코드 수정 → dev 자동 재시작, prod는 배포 필요. DB 정책만 바꾸는 건 재시작 없이 즉시 반영.

### ① ' Task user-prompt preamble

- **파일**: `packages/backend/services/task-runner.ts` (`buildTaskAgentRulesPreamble()`)
- **위치**: 시스템 프롬프트가 아니라 **태스크 user prompt 맨 앞**에 prepend. `saveMessage()`로 DB에도 저장되어 세션 UI와 `.jsonl`에 첫 user 메시지로 노출.
- **내용**: 자동 실행 태스크 3대 가드레일.
  1. **Architecture pre-check** — AGENTS.md를 읽고 상충 시 파일 수정 없이 보고하고 중단. 레거시 CLAUDE.md가 있으면 호환 입력으로만 참고.
  2. **Decision logging** — 자율 판단은 `workspace/decisions/YYYY-MM-DD-title.md` 또는 `.project/decisions/` 에 기록.
  3. **Commit before finish** — 수정 파일이 있으면 커밋 후 종료. `--no-verify`/amend/force-push 금지.
- **왜 system prompt 안 쓰나**: 세션 UI에 안 보이고 `.jsonl`에도 저장 안 되어 감사·디버깅 어려움. user prompt에 두면 단일 출처 + 가시성 + 재강조 효과.
- **적용**: `@task` / Heartbeat 등 task-runner 경로만. 채팅 세션은 영향 없음.
- **상세 결정**: `workspace/decisions/2026-04-20-task-agent-guardrails.md`

### ② 글로벌 사용자 설정

- **파일**: `~/.claude/CLAUDE.md`
- **내용**: 외부 Claude SDK/계정 호환용 사용자 계층. Tower의 visible workspace/project 정본은 아니다.
- **적용**: SDK `settingSources: ['user']`로 자동 로딩될 수 있음
- **변경**: 파일 수정 즉시 적용 (다음 세션부터)

### ③ 프로젝트 AGENTS.md

- **파일**: cwd에 있는 `AGENTS.md`
- **주요 파일들**:
  - `tower/AGENTS.md` (Tower 개발용)
  - `workspace/AGENTS.md` (일반 업무용)
  - `workspace/projects/*/AGENTS.md` (프로젝트별)
  - `tower/templates/workspace/AGENTS.md` (신규 고객 배포 템플릿)
- **적용**: Pi/Tower 세션은 AGENTS.md를 정본으로 사용. 레거시 `CLAUDE.md`가 남아 있으면 호환 입력으로만 취급.
- **변경**: 파일 수정 즉시 적용

### ④ 스킬

- **위치**: scope별로 다릅니다.
  - Project canonical: `workspace/projects/<project>/skills/<name>/SKILL.md`
  - Project fallback/import: `.pi/skills`, `.agents/skills`, legacy `.claude/skills`
  - Personal/simple project: DB `skill_registry`; project scope는 `skills/`에 `.tower-db-managed` marker와 함께 materialize
  - System/company legacy catalog: `~/.claude/skills/*/SKILL.md` + `~/.claude/skills/library/library.yaml`
- **로딩**: description이 활성 skill 목록에 들어가고, 트리거 시 `SKILL.md` body를 읽습니다. Pi는 `additionalSkillPaths`로 project-native paths를 함께 받습니다.
- **카탈로그**: system/company는 `library.yaml` / `local-library.yaml`; project/personal은 DB와 project filesystem source를 병합합니다.
- **배포**: 자체 호스팅 서버 system/company sync는 `deploy-profile.sh`를 orchestration이 호출합니다. Project-local skill은 해당 project 자산입니다.
- **변경**: 파일/DB 수정 후 다음 세션 또는 resource reload부터 적용. Project `skills/`는 source folder라 registry sync가 자동 삭제하지 않습니다.

### ⑤ 메모리

- **자동 메모리**: `~/.claude/projects/.../memory/MEMORY.md`
- **hooks DB**: `~/.claude/memory.db` (SQLite FTS5)
- **세션 요약**: hooks가 세션 종료 시 자동 캡처
- **변경**: hooks가 자동 관리, 수동 편집도 가능

## AI 실행 경로 — Session / Channel AI / Task

위 5-Layer는 **누가 Claude를 부르느냐**와 무관하게 공통이지만, 실제 호출 경로는 3가지로 분기됩니다 (UI 세션 / `@ai` / `@task`). 셋 다 결국 `executeQuery()`로 수렴하지만 권한·시스템프롬프트 모드·라이프사이클이 다릅니다.

**전체 비교표 + 드리프트 핫스팟 + PR 체크리스트**: [`ai-execution-paths.md`](./ai-execution-paths.md)

세 경로 중 하나에 새 옵션/가드/모드를 추가할 땐 그 문서 §1 매트릭스를 먼저 보세요. 한 곳만 고치고 다른 둘을 잊는 사고를 막는 SOT입니다.

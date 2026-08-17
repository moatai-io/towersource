# services/skill — 스킬 / 슬래시커맨드 / 자격증명

Tower 의 **스킬 (skill)** 모듈. AI 가 호출할 수 있는 재사용 가능한 prompt + tool + 워크플로 패키지의 영속성·로딩·자격증명 관리.

스킬 = Tower DB registry, 프로젝트 로컬 `skills/`·`.pi/skills`·`.agents/skills`·`.claude/skills`, 또는 관리형 라이브러리 등록 패키지. `@skill-name` 멘션으로 호출. 홈 `~/.claude/*` 경로는 legacy compatibility fallback으로만 남긴다.

## 책임

- **Runtime skill layer** — `project-skill-materializer.ts`는 schema v3 manifest와 최소 control files(`SKILL.md`, `skill.yaml`)만 프로젝트에 두고, `runtime-skill-bind-mount.ts`는 manifest-listed teamskills source를 스킬별 bind-ro child mount로 overlay한다. schema v3 desired state가 활성화 조건이며 별도 canary 설정은 필요 없다. 한 항목이라도 unsafe/missing이면 mount plan 전체를 거부한다. Copy의 2MB/file·20MB/bundle 제한은 explicit legacy copy 모드에만 적용하고 bind mount에는 적용하지 않는다.
- **스킬 CRUD** — DB + 파일시스템 두 source 동기화 (skill-registry)
- **3 scope**: company (모두 공유), project (프로젝트 멤버), personal (사용자 본인)
- **라이브러리 스킬** — Tower-managed skill library / registry 기반 시스템 제공 스킬 인덱스 (library-skills)
- **슬래시 커맨드** — DB/project-local/library skills → `/foo` 명령어 매핑. `~/.claude/commands/*.md`는 legacy fallback (command-loader)
- **스킬 자격증명** — 스킬이 필요로 하는 외부 토큰·API 키 (Notion, Slack, Gmail …) 의 readiness 검증 (skill-credential)

## Public API

### `skill-registry.ts` — 스킬 라이프사이클 (메인)
- `listSkills(scope?, projectId?, userId?)` — scope/소속 필터
- `getSkill(idOrName)` — 단일 조회 (content 포함)
- `getSkillRegistryDoctor(idOrName, userId?, projectId?)` — registered/visible/enabled 와 runtime capability 를 분리 진단
- `createSkill` / `updateSkill` / `deleteSkill` — CRUD
- `setUserSkillPref` / `getUserSkillPref` — 사용자별 enable/disable
- `syncProjectSkillsToFs` / `syncPersonalSkillsToFs` — DB → 파일시스템 sync
- `bootstrapLibraryProviders` — 부팅 시 1회, 라이브러리 스킬을 DB 에 등록 + provider 동기화
- `getCompanySkillsDir` / `getPersonalSkillPaths` / `getProjectSkillPaths` / `getSkillsForSession` — 파일 경로 resolver
- `getPersonalSkill` — ws-handler 가 호출 (스킬 inject)
- `parseFrontmatterField` — 다른 모듈 (library-skills) 이 사용

### `library-skills.ts` — 라이브러리 스킬 인덱스
- `loadLibrarySkills()` / `loadLibrarySkillsMap()` — 메모리 캐시 + 파일시스템 스캔
- `getLibrarySkill(name)` — 단일 조회
- `getLibrarySkillsDir()` — `~/.claude/skills/` 경로
- `invalidateLibraryCache()` — 외부 변경 감지 시 호출

### `command-loader.ts` — legacy 슬래시 커맨드 fallback
- Primary path: `skill-registry.getCommandsForUser()` — DB/project-local/library skills를 `/foo` → 본문으로 매핑
- `loadCommands()` — legacy `~/.claude/commands/*.md` 및 `~/.claude/skills/*/SKILL.md` 스캔 fallback
- `SlashCommand` 인터페이스: name, description, prompt, args
- pin-manager 는 registry primary 후 비어 있을 때만 fallback으로 사용

### `skill-invocation.ts` — SkillInvocation Runtime
- `resolveSkillInvocationForMessage()` — slash / picker / conservative natural-language trigger를 하나의 `SkillInvocation`으로 정규화
- `selectNaturalLanguageSkillInvocation()` — 오탐 방지를 위해 명시적 “스킬” 언급 또는 skill-name prefix만 자동 승격
- `renderSkillInvocationPrompt()` — `SKILL.md` 본문을 `<active_skill>` 블록으로 주입
- `mergeSkillInvocationMetadata()` — user/assistant message metadata에 동일한 skill 사용 기록 merge
- `skillInvocationProcessEventParams()` — process_events에 남길 관측 이벤트 payload 생성

### `skill-credential.ts` — 스킬 자격증명 / readiness
- `getSkillProviders(skillName)` / `setSkillProviders` — 어떤 스킬이 어떤 provider 필요한지
- `upsertSkillProvider` — frontmatter 기반 provider 동기화
- `getUserConnections(userId)` — 사용자별 연결된 OAuth 토큰 상태
- `checkSkillReadiness` — "이 스킬 호출하려면 어떤 토큰이 필요하고 있나?"
- `getUserSkillReadiness(userId)` — 모든 스킬 한 번에
- `parseProvidersFromFrontmatter` — SKILL.md frontmatter 파서
- `syncSkillProviders` — skill-registry 가 호출
- `reconcileSkillProviders` — 고아 row 정리
- `PROVIDER_META` — 등록된 provider 메타 (이름, OAuth scope, …)

## 들어오기 전에 알아야 할 것

- **DB + 파일시스템 dual source**: 스킬은 DB row + 파일시스템 (.md) 둘 다에 있음. `syncXxxToFs` 가 DB → fs 푸시. fs → DB 는 manual (admin 만).
- **3 scope 격리**:
  - `company`: 모든 사용자 공유, admin 만 수정
  - `project`: 프로젝트 멤버만, project owner 수정
  - `personal`: 사용자 본인만
  스코프 잘못 짚으면 사용자가 자기 거 못 보는 사태.
- **library 와 DB 스킬 구분**: library = Tower-managed 시스템 제공 스킬 인덱스. DB = 사용자가 만든 / 워크스페이스 등록한 것. 홈 `~/.claude/skills/`는 legacy fallback일 뿐 source-of-truth가 아니다. `bootstrapLibraryProviders` 가 provider readiness 만 동기화한다.
- **Registry vs runtime 분리**: registry 는 존재/소유/노출/복사 상태만 판단한다. host Bash / sandbox / persistent runtime / publishing 가능 여부는 runtime capability 로 별도 표시한다.
- **frontmatter 파싱**: SKILL.md 의 `---` 블록에서 name, description, providers, args 등 추출. parseFrontmatterField 가 단일 진실. library-skills + skill-credential 둘 다 사용.
- **provider readiness**: 스킬이 "Notion 토큰 필요" 라고 하면 사용자가 Notion OAuth 연결돼야 호출 가능. `checkSkillReadiness` 가 게이트.
- **부팅 시 bootstrapLibraryProviders 1회**: index.ts 가 호출. library 의 스킬 → DB 동기화 + 고아 정리.
- **SkillInvocation Runtime**: 스킬 실행은 이제 단순 `SKILL.md` read가 아니라 `SkillInvocation` 객체로 정규화된다. slash/picker/natural-language trigger, active prompt injection, message metadata, toast, process event가 같은 모델을 공유한다.
- **자연어 auto-trigger는 보수적**: 일반적인 의미 매칭만으로는 발동하지 않는다. 사용자가 `<skill> 스킬`, `<skill> 사용`, 또는 skill name/alias prefix처럼 명시적으로 신호를 줄 때만 `trigger: natural-language`로 승격한다.
- **Pi skills.list/read**: Pi 런타임은 `skills.list`로 현재 세션에서 보이는 스킬 metadata를 탐색하고, `skills.read`로 특정 `SKILL.md` 본문을 registry 경유로 읽는다. host-global path 직접 read를 피하기 위한 Codex식 loader 경로다.
- **pin-manager 와 connection**: `skill-registry.getCommandsForUser()` 결과를 pin-manager 가 primary로 사용하고, 결과가 비어 있을 때만 `command-loader.loadCommands()` legacy fallback을 사용한다.
- **schema v3가 bind-ro 활성 조건**: `schemaVersion: 3`, `managedBy: tower-project-skill-runtime-layer`, 모든 entry의 `storageMode: bind-ro`가 일치하면 별도 환경변수 없이 Docker child mount를 추가한다. schema v2는 명시적 copy mode로 남는다.
- **Read-only 실행 계약**: 스킬 코드·asset은 ro source에서 읽되 uv/pip/Python cache는 `/tmp/tower-runtime-cache`를 사용하고 산출물은 프로젝트의 writable 경로에 쓴다. Runtime Box는 `UV_CACHE_DIR`와 `PYTHONDONTWRITEBYTECODE=1`을 기본 주입한다.
- **테스트 있음**: skill registry, materializer, scanner, runtime bind mount 등 파일시스템 경계 테스트가 있다.

## 관련 결정문서

- `workspace/decisions/2026-05-01-skill-lifecycle-mandatory-entry-point.md` — `/skill-architect create` 룰
- `workspace/decisions/2026-05-02-skill-ui-role-split.md` — 스킬 UI role 분리
- `workspace/decisions/2026-05-03-ai-friendly-refactoring.md` — 이 폴더가 분리된 이유

## 관련 모듈

- `services/auth/` — provider OAuth 토큰은 oauth-manager 가 보유, skill-credential 이 readiness 검증 시 조회
- `services/messaging/index` — provider refresher 등록
- `services/pin-manager` — `loadCommands` 호출
- `engines/pi-engine` — `getSkillsForSession` 호출 (Pi 가 스킬 inject)
- `engines/claude-engine` — system-prompt 빌드 시 스킬 목록 포함
- `routes/api.ts` — 스킬 / 커맨드 / 라이브러리 / credential REST 엔드포인트
- `routes/ws-handler.ts` — `getPersonalSkill` dynamic import (스킬 호출 시)
- `services/library-skills` ↔ `services/skill-registry` — 양방향 의존 (의도적 — 라이브러리 인덱스 / DB 등록 협력)

## 테스트

- `skill-registry.test.ts` — DB CRUD 단위 (2 tests). 나머지는 통합 의존성 큼.

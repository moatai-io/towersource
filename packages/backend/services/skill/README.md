# services/skill — 스킬 / 슬래시커맨드 / 자격증명

Tower 의 **스킬 (skill)** 모듈. AI 가 호출할 수 있는 재사용 가능한 prompt + tool + 워크플로 패키지의 영속성·로딩·자격증명 관리.

스킬 본문의 현재 source는 Project의 `skills/`와 조직 `teamskills` 파일이다. Project의 `.tower/skills`는 관리형 실행 표현이며 DB-backed project/personal 본문은 legacy-inert다. 사용자 preference와 provider metadata의 DB 저장은 본문의 정본과 구분한다. 홈 `~/.claude/*` 경로는 legacy compatibility fallback으로만 남긴다.

> 후속 검토: registry source/CRUD, sync no-op, library 경로 선택, readiness 판정을 코드와 대조했다. 아래 Docker mount 설명은 해당 호환 구현의 범위이며 모든 Worker의 실제 mount를 검증했다는 뜻이 아니다.

## 책임

- **Runtime skill layer** — `project-skill-materializer.ts`는 schema v3 manifest와 최소 control files(`SKILL.md`, `skill.yaml`)만 프로젝트에 두고, `runtime-skill-bind-mount.ts`는 manifest-listed teamskills source를 스킬별 bind-ro child mount로 overlay한다. schema v3 desired state가 활성화 조건이며 별도 canary 설정은 필요 없다. 한 항목이라도 unsafe/missing이면 mount plan 전체를 거부한다. Copy의 2MB/file·20MB/bundle 제한은 explicit legacy copy 모드에만 적용하고 bind mount에는 적용하지 않는다.
- **스킬 CRUD** — Project 파일 기반 CRUD. company DB API 변경은 거부하고 share-skill을 안내한다 (skill-registry)
- **scope 호환**: company는 조직 source 조회, project는 파일 기반 관리, personal 신규 생성은 deprecated 오류로 거부한다
- **라이브러리 스킬** — Tower-managed skill library / registry 기반 시스템 제공 스킬 인덱스 (library-skills)
- **슬래시 커맨드** — Project `commands/*.command.yaml|json` workflow와 Project/local/library skills를 `/foo`로 매핑한다. `.project/commands`, `.tower/commands`, `~/.claude/commands/*.md`는 호환 경로다. (command-registry, command-loader)
- **스킬 자격증명** — 스킬이 필요로 하는 외부 토큰·API 키 (Notion, Slack, Gmail …) 의 readiness 검증 (skill-credential)

## 부분 재생성과 저장 형식 전환

`materializeProjectRegistrySkills`의 `prune: false`(`--no-prune`)는 요청하지 않은 기존 항목을 보존하지만, 서로 다른 저장 형식을 한 manifest에 섞지 않는다. 기존 항목의 `storageMode`가 없으면 legacy `copy`로 해석한다. 보존 대상이 요청한 저장 형식과 다르면 폴더 변경 전에 오류를 반환한다. `copy`에서 `bind-ro`로 전환할 때는 기존 항목도 명시적으로 재생성 요청에 포함해야 하며, 원본 누락이나 scanner 거부로 전환 항목이 제외되면 혼합 manifest를 기록하지 않는다. 이 후반 오류는 이미 재생성된 다른 폴더까지 rollback한다는 보장은 아니다.

이미 저장 형식이 섞인 schema v3 manifest는 문제가 있는 항목을 `--skills`에 포함하고 `--storage-mode bind-ro --no-prune`으로 재생성한다. 원본 bundle이 안전하고 registry에서 허용되어야 한다. `--include-hidden`은 숨겨진 항목을 재생성해야 하는 운영자 진단에만 사용한다. manifest를 손으로 고치거나 Worker 검증을 완화하지 않는다.

회귀 검증: `project-skill-materializer.test.ts`는 부분 전환의 사전 거부, 전체 명시적 전환, 전환 실패 시 manifest 보존, 호환 `bind-ro` 부분 업데이트 및 역방향 전환 거부를 확인한다. `runtime-skill-bind-mount.test.ts`는 mount plan 검증을 보호한다. 이 코드 검증은 설치 인스턴스 배포나 브라우저 파일 열기 검증을 뜻하지 않는다.

## Worker 실행 중 스킬 장애 격리

Worker의 schema v3 projection은 잘못된 항목만 제외하고 정상 스킬과 일반 명령을 계속 실행한다. stale control copy를 실행하는 fallback 대신 `.tower/skills`를 빈 tmpfs로 가리고 검증된 bundle만 read-only mount한다. 제외 사유는 실행 stderr와 Worker 로그의 `WORKER_MANAGED_SKILLS_SKIPPED`에 남는다. 항목 전체 실패 및 읽을 수 없는 manifest에서도 sandbox를 유지하며 `bwrap` 요구를 우회하지 않는다. 기존 Docker compatibility planner의 전체 fallback 계약은 이번 변경 범위에 포함하지 않는다.

정본 계약: `docs/architecture/project-execution-consistency.md`의 관리형 스킬 장애 격리. 구현·회귀: `services/execution/worker/worker-server.ts`, `worker-skill-isolation.test.ts`, `services/runtime-box/workbench-remote-http-transport.e2e.test.ts`.

## 신규 Project의 기본 스킬 시딩

조직 default skillset은 편의상 제공하는 기본값이며 Primary Agent의 필수 생성 조건이 아니다. `pm/project-default-skills.ts`는 source가 없거나 안전성 검사를 통과하지 못한 기본 스킬을 제외하고 생성을 계속한다. 정상 스킬만 manifest에 포함하며, 전부 제외되어도 빈 manifest를 기록해 host-global compatibility fallback을 차단한다. 스캐너·권한·실제 실행 시 bind mount 검증은 완화하지 않는다. 명시적인 Staffing/Harness 요구조건 검증과도 별개다.

`.tower/skills/seed-status.json`에는 `ready`/`degraded`, 연결된 스킬 이름, 제외한 이름과 reason을 기록한다. 제외가 있으면 서버 경고도 남긴다. 이 파일은 생성 당시의 진단이며 현재 readiness나 사용자 UI 알림을 의미하지 않는다. 파일 저장·manifest 생성 등 실제 I/O 예외는 기존 scaffold rollback으로 전달한다. 일반 materializer의 `ok: false` 계약과 명시적인 rollout 검증은 변경하지 않는다.

회귀 검증: `pm/project-skill-seed.source.test.ts`는 scaffold 연결, 부분/전체 누락, unsafe bundle 제외, 정상 시딩, 저장 오류 전파를 확인한다. 원격 배포와 실사용 검증은 별도로 수행해야 한다.

## Public API

### `skill-registry.ts` — 스킬 라이프사이클 (메인)
- `listSkills(scope?, projectId?, userId?)` — 조직 catalog와 Project 파일을 scope/소속별 조회
- `getSkill(idOrName)` — 단일 조회 (content 포함)
- `getSkillRegistryDoctor(idOrName, userId?, projectId?)` — registered/visible/enabled 와 runtime capability 를 분리 진단
- `createSkill` / `updateSkill` / `deleteSkill` — CRUD
- `setUserSkillPref` / `getUserSkillPref` — 사용자별 enable/disable
- `syncProjectSkillsToFs` / `syncPersonalSkillsToFs` — deprecated no-op; DB → 파일 생성을 수행하지 않음
- `bootstrapLibraryProviders` — 부팅 시 1회, 라이브러리 provider metadata 동기화·고아 metadata 정리
- `getCompanySkillsDir` / `getPersonalSkillPaths` / `getProjectSkillPaths` / `getSkillsForSession` — 파일 경로 resolver
- `getPersonalSkill` — ws-handler 가 호출 (스킬 inject)
- `parseFrontmatterField` — 다른 모듈 (library-skills) 이 사용

### `library-skills.ts` — 라이브러리 스킬 인덱스
- `loadLibrarySkills()` / `loadLibrarySkillsMap()` — 메모리 캐시 + 파일시스템 스캔
- `getLibrarySkill(name)` — 단일 조회
- `getLibrarySkillDirs()` / `getLibrarySkillsDir()` — catalog가 존재하는 Tower-managed 경로를 우선 선택하고 legacy 경로로 fallback
- `invalidateLibraryCache()` — 외부 변경 감지 시 호출

### `command-registry.ts` / `command-loader.ts` — 슬래시 커맨드
- Primary path: `skill-registry.getCommandsForUser()` — Project `commands/`, Project `skills/`, managed/library skills를 하나의 typed command 목록으로 매핑한다.
- Project-authored workflow command의 정본 위치는 `<project>/commands/*.command.yaml|json`이다. `.project/commands`와 `.tower/commands`는 하위 우선순위 호환 경로다.
- 동일 canonical/alias는 먼저 발견된 명령이 유지되고 충돌 항목은 경고 후 제외된다. command와 skill의 canonical이 같으면 command를 유지하고 동명 skill을 경고 후 제외한다.
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

- **본문과 DB metadata 분리**: Project 본문은 파일 기반이며 `syncProjectSkillsToFs`와 `syncPersonalSkillsToFs`는 no-op이다. company 본문은 teamskills source에서 읽는다. 함수명에 registry/sync가 남아 있다고 DB 본문을 정본으로 복원하지 않는다.
- **CRUD 경계**: company 생성·수정 API는 조직 source 흐름을 안내하며 거부한다. personal 생성도 거부한다. Project CRUD의 실제 호출자 권한 검사는 route와 함께 확인한다.
- **library 와 DB 스킬 구분**: library = Tower-managed 시스템 제공 스킬 인덱스. 과거 DB-backed project/personal 본문은 현재 비활성 호환 상태다. 홈 `~/.claude/skills/`는 legacy fallback일 뿐 source-of-truth가 아니다. `bootstrapLibraryProviders` 가 provider readiness 만 동기화한다.
- **Registry vs runtime 분리**: registry 는 존재/소유/노출/복사 상태만 판단한다. host Bash / sandbox / persistent runtime / publishing 가능 여부는 runtime capability 로 별도 표시한다.
- **frontmatter 파싱**: SKILL.md 의 `---` 블록에서 name, description, providers, args 등 추출. parseFrontmatterField 가 단일 진실. library-skills + skill-credential 둘 다 사용.
- **provider readiness**: `checkSkillReadiness`는 `skill_providers`와 사용자 OAuth row의 provider 이름을 대조한다. provider 요구가 없으면 credential 관점에서 ready이며 static requires는 안내용이다. Vault 권한·명령 주입·Provider 인증 성공이나 모든 호출자의 실행 차단을 보증하지 않는다.
- **부팅 시 bootstrapLibraryProviders 1회**: index.ts 가 호출. library provider metadata 동기화 + 고아 정리.
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

- [skill-registry.test.ts](skill-registry.test.ts) — registry와 Project 파일/호환 동작을 확인한다.
- [teamskills-source.test.ts](teamskills-source.test.ts) — 조직 source 선택을 확인한다.
- [skill-credential.test.ts](skill-credential.test.ts) — readiness와 정적 요구 해석을 확인한다.
- [library-skills.test.ts](library-skills.test.ts) — catalog 및 legacy fallback을 확인한다.

제품 안내는 [Skills in Tower](../../../../docs/tower-guide/skills.md)를 따른다. 테스트 개수는 실행 기록에 남기며 운영 성공으로 해석하지 않는다.

## Pi 부속 파일 접근 안내 계약

`skills_read`는 본문과 함께 `assetAccess`를 반환한다. 호출 시 현재 실행 권한을 재확인하여 Operator host와 Project executor를 구분하고, 도구 구성 이후 권한이 바뀌었거나 실행 경로가 없으면 unavailable로 표시한다. Project executor의 `/workspace/.tower/skills/<name>/`는 관리형 스킬 경로 규칙일 뿐 mount 성공 증거가 아니다. Project executor 응답의 검증 상태는 unverified이며 project-authored source와도 구분해야 한다. Operator host는 아래 원본 검증 결과를 별도로 반환한다.

Operator host에는 Worker mount 경로를 실제 host 경로처럼 제공하지 않는다. 호스트의 control-only 사본에 참조가 없다고 원본 누락으로 판정하거나 대체 문서를 생성하지 않도록 안내한다. 현재 Operator 권한과 스킬 노출을 확인한 뒤 `operator-skill-assets.ts`가 서버 설정의 teamskills 원본을 해석한다. Project manifest의 해당 항목·조직 canonical ID, 원본 안전성 검사, 전체 bundle digest 및 반환 본문과 원본 SKILL.md의 byte 일치가 모두 통과해야 source-verified 상태와 sourceDirectory·상대 파일 목록을 반환한다. 실패 시 blocked와 경로 없는 reason만 반환한다. source-verified는 조회 시점의 원본 검증이며 실행 성공·Worker mount 검증 또는 추가 파일 권한을 의미하지 않는다. 프로젝트 로컬/legacy 스킬과 manifest 없는 원본은 이 자동 해석 대상이 아니다. 호스트 실행은 검증된 전체 번들을 `<project>/.tower/skill-assets/<digest>/<name>/`에 복사하고 `executionDirectory`와 `managedRuntimePath`로 반환한다. 이 스냅샷은 조직 정본과 기존 `.tower/skills` manifest를 변경하지 않는다. 스킬 본문의 `/workspace/.tower/skills/<name>` 예시는 호스트에서 반환된 실행 경로로 치환하며 조직 원본 직접 실행은 하지 않는다. 기존 스냅샷 변조·심볼릭 링크·원본 digest 불일치는 차단한다. Python bytecode/cache 및 산출물은 스냅샷 밖에 두어야 한다. 이는 OS read-only mount가 아니라 digest로 검증하는 프로젝트 로컬 사본이다.

명령 단위 Credential resolver는 현재 Project manifest에 등록된 정확한 스냅샷 경로와 전체 digest를 다시 확인한 뒤 기존 requiredSecrets/Gateway 해석을 재사용한다. 다른 프로젝트·조직 원본·변조된 사본에는 이 경로의 선언을 적용하지 않는다. 기존 `/workspace` 실행과 provider 권한 검사는 유지한다. 호스트 스냅샷의 절대경로, 현재 command cwd 기준 상대경로 및 `./` 접두 경로를 인식한다. 호스트 adapter는 세션의 canonical Project root를 manifest 조회에 사용하고 command cwd와 분리한다. shell 변수나 `cd` 이후 경로를 일반 shell parser처럼 추론하지는 않으므로 이러한 명령은 반환된 절대 실행 경로를 사용해야 한다. 호스트 `skills_read`는 이제 검증된 번들의 프로젝트 로컬 준비 작업을 포함하며 provider API를 호출하지 않는다.

검증: snapshot 안의 스크립트와 상대 참조 파일을 Node로 실제 실행하는 fixture, 호스트 경로의 Gateway alias 주입(mock provider), 변조·다른 프로젝트·symlink 거부 회귀 테스트를 추가했다. 실제 이미지 API 호출과 고객 배포는 별도 검증 대상이다.

구현: `engines/pi-skill-tools.ts`, `engines/pi/tool-assembly.ts`. 회귀 테스트: `engines/pi-skill-tools.test.ts`, `services/skill/operator-skill-assets.test.ts`. 로컬 테스트 결과와 실제 운영 Worker 검증은 별도로 보고한다.


## Nix 배포 이후 기존 Project 선언 갱신

앱 cutover는 기존 Project manifest의 자동 backfill을 보장하지 않는다. 신규 Project는 배포된 앱의 `seedProjectDefaultSkills`를 사용하지만, 운영자가 `~/tower`에서 실행한 CLI는 별도 checkout의 코드를 사용할 수 있다. 실행 서비스가 최신이어도 checkout materializer가 구버전이면 `gatewayApis`를 누락하거나 `--no-prune`에서 기존 목록을 유지하지 못할 수 있다.

갱신 전 실행 중인 release와 운영 도구의 revision 및 `gatewayApis`·retained-entry 지원을 확인한다. 불일치하면 구버전 CLI를 실행하지 않고 배포된 release의 materializer를 사용한다. 기존 manifest를 백업하고 기존 skill name 집합을 그대로 전달해 반영한 뒤 name 집합 보존, skipped, Gateway 선언을 검사한다. 신규 Agent는 같은 release의 seeding 함수를 임시 fixture에서 실행해 검증할 수 있으며 실제 Agent/DB row를 만들 필요는 없다. 이 검증은 선언 생성까지이며 Credential 값은 저장하지 않는다. 키 주입은 실행 명령마다 별도 권한 검사 후 수행하고 provider 성공은 추가 검증한다.

회귀 테스트: `pm/project-skill-seed.source.test.ts`의 신규 Agent 이미지 스킬 Gateway 선언 자동 시딩 검증.

## 공개 배포의 선택 스킬 기본값

`DEFAULT_RUNTIME_BOX_MATERIALIZED_SKILLS`는 설치별 registry에서 선택하는 기본 후보 목록이다. 공개 소스에 모든 managed 본문이 포함되어야 한다는 계약은 없다. `seedProjectDefaultSkills`는 unavailable 기본 후보를 `seed-status.json`의 `degraded`/`skipped`로 남기고, 실제로 검증·materialize된 항목만 runtime manifest에 넣는다. 명시적 bundle scanner, manifest allowlist 및 mount 검증은 그대로 적용한다. `runtime-box-skill-portability.test.ts`는 함께 배포된 기본 본문을 audit하고, 존재하지 않는 catalog 후보가 manifest로 들어가지 않는 동작을 별도로 검사한다.

# services/pm — Project Management

Tower 의 **프로젝트 관리** 모듈. 프로젝트 CRUD, 멤버 ACL, 경로 권한, AI 컨텍스트 주입 (PM feed), PM Inbox (deferred work / pm-capture).

## 책임

- **프로젝트 CRUD** — 생성, 조회, 업데이트, 삭제, 멤버 시드 (project-manager)
- **접근 제어** — 사용자별 allowed_path 결정, room/session/file 권한 체크 (project-access)
- **AI 컨텍스트 주입** — 활성 결정문서 + in-progress 이슈 + due-soon 작업을 system prompt 에 첨부 (pm-feed-context)
- **PM Inbox** — deferred work, decisions, candidates triage (inbox.ts, ex-pm-inbox/)

## Public API

### `project-manager.ts` — 프로젝트 CRUD
- `getProject(id)` / `listProjects(userId?, role?)` / `createProject` / `updateProject` / `deleteProject`
- `seedDefaultProjects` — 부팅 시 1회, 사용자용 기본 프로젝트는 `general` 하나만 보장
- `getDefaultProjectIds` — auth.createUser 가 호출 (auto-join)
- `getProjectByRootPath` — cwd 경로로 프로젝트 추정
- `Project` 타입 (PG row + 부가 메타)

### `project-access.ts` — 접근 제어 / ACL (가장 큰 파일, 36KB)
- `buildToolGuard(opts)` — Claude/Pi tool 호출 단위 가드 (damage control + path enforcement + project ACL)
- `getUserAccessiblePaths(userId)` — 사용자별 fs 접근 가능한 경로
- `findProjectByPath(p)` — 경로 → 프로젝트 매핑
- `resolveSessionProjectRoot(cwd)` — 세션 루트 추정
- `canAccessRoom(userId, roomId)` / `canAccessSession(userId, sessionId)` — 룸/세션 접근 검증
- `isPathAccessible(userId, path)` / `isPathWritableByRole` — 경로 권한
- `isPrivilegedRole(role)` / `isDotfileDenied(path)` — 정책 헬퍼
- `invalidatePathCache(userId)` — 멤버십 변경 시 호출 (group-manager 가 사용)
- `wrapPiTools(tools, guard)` — Pi tool 래퍼

### `pm-feed-context.ts` — AI 에 PM 컨텍스트 주입
- `buildPmFeedAddendum(opts)` — system prompt 끝에 붙일 string 합성
- 포함: 활성 결정문서, in-progress 이슈, due-soon 작업
- claude-engine + pi-engine 둘 다 부름 (`AI_PM_ENABLED=true` 일 때만)

### `inbox.ts` — PM Inbox
- `deriveAll(userId)` / `listOpen(userId)` — 인박스 항목 합성·조회
- `createUserSeed` / `answerItem` / `dismissItem` — 인터랙션
- distiller/triage 와 연결 (decision import → inbox candidate)

## 들어오기 전에 알아야 할 것

- **`pm` ≠ project-manager 약자**: project-manager 는 *프로젝트 라이프사이클*. pm 폴더는 *프로젝트 관리 도메인 전체* (CRUD + 접근 + 컨텍스트 + 인박스).
- **project-access 는 Tower 의 ACL 핵심**: 모든 fs / room / session 접근이 여기 통과. 정책 변경 시 영향 범위 큼.
- **`pm-inbox/` → `pm/`**: 기존 `services/pm-inbox/inbox.ts` 가 이 폴더로 옮겨짐. import 경로 `'../services/pm-inbox/inbox.js'` → `'../services/pm/inbox.js'`.
- **`buildToolGuard` 가 단일 진입점**: damage control + path enforcement + project ACL 이 한 함수로 합성됨. 분리하면 각 가드 호출 빠뜨릴 위험.
- **path cache invalidation**: 멤버십 변경 시 `invalidatePathCache(userId)` 호출 필수. group-manager 가 이미 호출함 — 새 멤버십 변경 경로 추가 시 잊지 말 것.
- **`AI_PM_ENABLED=true` 일 때만 pm-feed-context 활성**: env 미설정이면 system prompt 에 PM addendum 안 붙음. 의도적 — 자체 운영 only (workspace/decisions/2026-04-28-ai-native-pm-self-hosted-server-block.md).
- **`getDefaultProjectIds` 와 `seedDefaultProjects` 의 분리**: 부팅 시 `general`만 seed하고, 사용자 생성 시 해당 기본 프로젝트에 자동 가입. 두 흐름 분리.
- **숨은 프로젝트 seed 금지**: `ai-talent-team`, `shared`, `test-project`, `teamskills`를 DB 프로젝트로 자동 생성하지 않는다. `teamskills`는 프로젝트가 아닌 filesystem-only 조직 스킬 저장소로만 준비한다.
- **distiller 와 inbox 연결**: 결정문서 자동 import → inbox candidate. user 가 accept/reject. distiller/triage 가 inbox.ts 의 acceptCandidate / rejectCandidate 동적 호출.

## 관련 결정문서

- `workspace/decisions/2026-05-02-member-auto-membership.md` — 신규 사용자 default 가입 정책
- `workspace/decisions/2026-05-02-workspace-root-isolation.md` — 멤버는 자기 프로젝트 안만
- `workspace/decisions/2026-04-28-ai-native-pm-self-hosted-server-block.md` — pm 자체운영 only
- `workspace/decisions/2026-05-03-ai-friendly-refactoring.md` — 이 폴더가 분리된 이유

## 관련 모듈

- `services/auth/auth` — `createUser` 시 default project 가입
- `services/group-manager` — 멤버십 변경, path cache invalidate
- `services/damage-control` — tool guard 일부 (project-access 가 import)
- `services/session/session-share-manager` — `hasInternalShareAccess` 호출 (project-access)
- `services/distiller/triage` — inbox candidate 생성·승인
- `engines/claude-engine` / `engines/pi-engine` — tool guard + pm feed addendum 사용
- `services/task/*` — task-manager + task-runner 가 project 추정·접근 검증
- `services/ai-quick-reply` — channel AI 호출 시 project 권한 체크
- `routes/api.ts` / `routes/ws-handler.ts` — REST/WS 모든 진입점이 ACL 통과

## 테스트

- `project-access.test.ts` — ACL 단위 테스트 (path access, role-based write, dotfile guard 등)
- 다른 파일은 PG 의존성 큼.

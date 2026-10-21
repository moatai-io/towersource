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
- `seedDefaultProjects` — 부팅 시 `general`과 Agent-first 환경의 시스템 소유 `introduction`을 중복 없이 보장. 최초 생성 시 친절한 안내 프로필과 `docs/`의 6개 쉬운 사용자 안내를 배치한다. 기존 프로필·안내 파일·디렉터리 공개 설정은 덮어쓰지 않고 누락된 안내 파일만 채운다.
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
- **`getDefaultProjectIds` 와 `seedDefaultProjects` 의 분리**: 부팅 시 General 및 Agent-first Introduction을 seed하고, 활성 일반 사용자는 생성·승인 시 자동 가입. 기존 일반 사용자도 Introduction에 중복 없이 backfill한다. viewer/guest는 자동 가입하지 않는다. 기존 Introduction이 비공개로 설정된 경우 공개 설정을 자동 변경하지 않으며, 비활성화/보관된 프로젝트의 복구도 별도 운영 판단이 필요하다.
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

## Introduction session visibility

Introduction uses the normal session visibility contract: new project sessions default to `project`, explicit `private` remains private, and authorized users may change visibility through the standard session API. Existing private sessions are not automatically promoted. Enforcement: `../session/session-manager.ts` and `../../routes/session-core/session-core-router.ts`. Regression coverage: `../session/session-manager.engine-switch.test.ts` and `../../routes/session-core/session-core-access.test.ts`. Starter guidance is seeded only when absent; existing customized files and profiles are preserved.

## 신규 Agent 초기 준비 v2

승인된 Primary Agent 생성에만 로컬 준비를 예약하며 character.md의 생성 당시 기대를 공통 세션 프롬프트에 연결한다. 기존 Agent 일괄 변경과 외부 조회는 수행하지 않는다. 정본·멱등성·수정 보호·실패·운영 검증 한계는 [초기 준비 계약](../../../../docs/architecture/agent-initial-preparation.md)을 따른다.

## 초대제 에이전트와 공유 대화

일반 에이전트는 hidden·생성자 owner로 시작하며 admin/operator도 명시적 초대가 필요하다. 디렉터리와 검색은 현재 활성 계정의 membership으로 제한한다. 운영자 self-join은 거절하며 과거 participation은 접근권을 만들지 않는다. 기본 대화는 project 공유, private는 소유자 전용이다. SQL audience와 단일 리소스 검사 및 파일 접근에서 역할 전역 우회를 사용하지 않는다. General/Introduction만 명시적 시스템 온보딩 예외로 자동 멤버십을 유지한다. 기존 멤버십은 일괄 변경하지 않는다. 계약은 `docs/architecture/authority-and-storage.md`, 검증은 membership/agent-directory/administrator-participation/session-access-visibility/project-access의 인접 테스트를 참조한다.

### Project 탈퇴 후 세션 접근

일반 Project 세션은 소유자도 현재 Project 멤버십이 있어야 읽을 수 있다. `session-audience.ts`의 SQL audience는 검색·목록·패널에서, `project-access.ts`의 `canAccessSession`은 직접 조회에서 같은 조건을 적용한다. Project 없는 개인 세션과 채널 Agent의 별도 audience는 유지한다. 회귀 검증은 `session-audience.test.ts`, `session-access-visibility.test.ts`, `../session/session-list-audience.test.ts`가 담당한다.

활성 admin은 이메일 등록 여부와 무관하게 Project 세션 목록·검색·조회의 멤버십 검사에서 예외다. 다른 사용자의 private 세션, 채널 audience, 실행·변경 권한은 이 예외로 우회하지 않는다.

관리자 패널의 명시적 참여는 `admin-agent-membership.ts`가 담당한다. admin/operator는 활성 에이전트에 일반 member로 참여할 수 있으며 감사 기록·소유자 알림을 남긴다. 자동 참여나 private 우회는 복구하지 않는다.

### Previous Agent participation (name-only navigation)

`GET /api/agent-directory/previous-participation` rechecks the active company account and returns only `{id, name}` for active, non-deleted Agents where the requester owns a historical session and has no current `project_members` row. Session ownership is a conservative prior-use signal, not a complete membership audit: members without their own session are not included. No session title, ID, count, body, path, profile instruction or current content access is granted. Private Agents may appear only through this own-history predicate. The endpoint does not modify membership or bypass normal session revocation.

Sidebar Agent rail renders these names in a separate Previous participation section with a Not participating label and no content/execution action. It does not synthesize Project records or restore revoked sessions. Tests: `agent-directory.test.ts`, `../../routes/agent-directory-api.test.ts`, frontend `AgentNavigationRail.previous-participation.source.test.ts`. Production/browser verification is separate from these unit/source checks.

### 에이전트 멤버 초대

`POST /projects/:id/members`는 활성 에이전트의 쓰기 멤버십(`isProjectMember(id, userId, 'write')`)을 가진 owner/member에게 허용한다. 조직 역할만으로 미가입 에이전트에 초대 권한을 얻지는 않으며 viewer/guest는 초대할 수 없다. 초대 대상은 항상 member로 추가한다. 멤버 제거 권한은 기존 owner 제한을 유지한다.

검증: `routes/agent-role-boundaries.test.ts`의 project member invitations 테스트. 실제 브라우저 초대 흐름과 배포 여부는 별도 검증한다.

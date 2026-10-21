# Session Core API

인증된 사용자의 Session 목록·생성·조회와 메시지 read HTTP 경계를 소유한다.

## Public API
- `session-core-router.ts`의 Express Router
- `GET/POST /sessions`
- `GET /sessions/:id`
- `GET /sessions/:id/full`
- `GET /sessions/:id/messages`

## 경계
- Session access와 Project create 권한은 `services/pm/project-access.ts`가 정본이다.
- Session persistence는 `services/session/session-manager.ts`, 메시지는 `services/message-store.ts`가 소유한다.
- 최근/사이드바 목록(`GET /sessions`, Project 홈 지연 조회 포함)은 Project 멤버십을 SQL의 ORDER/LIMIT 전에 검사한다. 본인이 만든 세션도 해당 Project의 현재 멤버가 아니면 목록에서 숨긴다. Project 없는 개인 세션은 기존 audience 규칙을 유지한다. 일반 Project 세션의 검색·패널·직접 transcript 조회도 현재 멤버십을 요구한다. 세션 소유권만으로 탈퇴 후 접근을 유지하지 않는다. 채널 Agent 세션은 별도 채널 audience를 유지한다. 구현: `getSessions(..., { sidebarOnly: true })`; 회귀 검증: `services/session/session-list-audience.test.ts`.
- process map, spawn/send, engine switch, branching/rewind, clone, archive는 아직 legacy `api.ts`에 남는다.
- 기존 URL, route ordering, status와 response shape를 변경하지 않는다.

## Pi conversation MCP selection

- `session-mcp-selection-router.ts`는 별도 router export이며 `api.ts`가 mount합니다. `GET/PATCH /api/sessions/:id/mcp-selection`을 제공합니다.
- 응답은 `{ sessionId, projectId, supported, excludedServerNames }`입니다. `supported`는 Pi 세션에만 참이며, 다른 엔진의 PATCH는 409입니다. 공용 타입은 `packages/shared/session-mcp-selection.ts`에 있습니다.
- PATCH body는 `{ excludedServerNames: string[], projectId?: string | null }`이며 목록 전체를 교체합니다. `projectId`는 stale Project 방어용입니다. 서버명은 manifest 이름 형식을 따르고 최대 64개이며, 중복은 저장 시 제거합니다. 현재 연결되지 않은 이름도 유지해 재연결 시 사용자의 제외 의도가 보존됩니다.
- GET은 `canAccessSession`, PATCH는 `canAccessSession`과 `canSendSessionMessage`의 현재 세션 권한을 모두 검사합니다. UPDATE도 Project와 Pi 엔진을 다시 비교해 동시 Project 이동이나 엔진 전환을 차단합니다.
- `234_session_mcp_selection.sql`은 `sessions.mcp_excluded_server_names`를 추가합니다. 기존 세션과 신규 세션의 기본 제외 목록은 `[]`이며 기존 Agent 연결 권한을 넓히지 않습니다. migration을 적용하기 전에는 이 API와 Pi MCP 실행 검사가 storage error로 실패하므로 코드만 먼저 배포하지 않습니다.
- `services/session/session-mcp-selection.ts`의 checker를 Pi `tool-assembly.ts`가 gateway에 전달합니다. 검색과 호출마다 현재 저장 목록을 재조회하며, 삭제된 세션·Project mismatch·비-Pi 전환은 허용하지 않습니다. 이미 발견한 tool id도 허가로 취급하지 않습니다. 선택 변경은 **다음 MCP 도구 검색·호출부터** 적용하며 이미 진행 중인 외부 호출을 취소하지 않습니다.
- `RunOpts.mcpExcludedServerNames`는 추가 제한만 제공할 수 있으며 저장된 제외 목록을 무시할 수 없습니다. 제외는 이 MCP gateway 표면만 제한합니다. shell·다른 first-party 서비스의 사용 전체를 차단하는 보안 경계가 아닙니다.
- 회귀 테스트는 `session-mcp-selection-router.test.ts`, `services/session/session-mcp-selection.test.ts`, `services/project-mcp/project-mcp-loader.test.ts`, `services/project-mcp/session-selection-gateway.test.ts`, `engines/pi/pi-session-mcp-selection.source.test.ts`에 있습니다. mock HTTP/unit/source 검증이며 실제 migration 및 OAuth 제공자 라이브 검증과 구분합니다.

## Session audience boundary
- 회사 관리자 역할만으로 비공개 본문·미리보기·채널 대화를 열지 않는다. 소유자·명시 공유·실제 audience와 플랫폼 admin 예외는 유지한다.
- 목록은 각 Session audience를 재검사한다. 회사 관리자는 미참여 프로젝트의 일반 공유 세션에 대해 제목·식별자·소유자·시각 메타데이터만 받으며 summary와 실행 설정은 받지 않는다.
- 부모 세션과 채널을 참조하는 생성 요청은 상속 전에 audience를 검사한다. 새 세션 사용 권한은 기존 타인 세션 send 권한과 다르다.
- 관리자 참여는 별도 administrator_participations에 저장한다. 일반 project_members/room_members는 생성하지 않는다. 참여와 불변 감사 이력은 같은 transaction으로 기록한다. 참여·해제에 따른 앱 내 알림·푸시·이메일은 생성하지 않는다.
- 기본 목록은 session-manager가 공통 audience SQL을 LIMIT 전에 적용하고 미참여 회사 메타데이터를 whitelist로 반환한다. 기본 목록의 N+1 후처리는 제거했다. panel 목록은 방어적 재검사가 남는다.

## 관리자 참여 API

> 레거시 호환 API다. 일반 Workspace의 `App`은 `AdministratorParticipation`을 mount하지 않으며 자동 참여·상단 배너를 제공하지 않는다. 현재 관리자 참여는 관리자 패널의 명시적 일반 멤버 등록을 사용하고, 참여 상태 확인과 제거는 기존 멤버 목록을 사용한다. 현재 권한 계약은 `docs/architecture/authority-and-storage.md`의 명시적 관리자 참여 항목을 따른다. 아래 컴포넌트 설명은 호환 구현 자체의 동작이며 현재 화면 연결을 뜻하지 않는다.

`session-core-router`가 `administrator-participation-router`를 mount하므로 api.ts 추가 mount는 필요 없다.

- `GET /api/administrator-participation/{project|channel}/{targetId}` → `{ scope, targetId, participants: [{ id, userId, username, joinedAt }] }`
- `POST` 같은 경로 + `{ confirmed: true }` → 참여한다. 프로젝트에서는 실제 Workspace 입장 동작이 요청을 보낸다. 명부 조회·소개 열람은 요청하지 않으며, 채널은 기존 명시적 참여 동작을 유지한다.
- `DELETE` 같은 경로 + `{ confirmed: true }` → 자기 참여를 해제한다.
- 변경 응답은 `{ scope, targetId, changed, joined, participationId, eventId? }`다.
- 새 참여는 **현재 DB의 활성 operator**만 허용한다. 플랫폼 admin은 별도 예외 접근이므로 operator 참여를 만들지 않는다.
- 참여 또는 감사 저장 실패는 transaction rollback/503이며 성공으로 처리하지 않는다. 알림 저장은 처리 조건이 아니며 기존 알림 기록을 삭제하지도 않는다.
- 현재 사용자 행 잠금과 참여 행 재검사를 유지한다. 이미 참여한 상태에서 재입장·새로고침·중복 요청은 감사 이력을 추가하지 않는다. 명시적으로 해제한 뒤 다시 입장하면 기존 참여 행을 재활성화하고 새 `joined` 이력을 남긴다.
- 프론트 `AdministratorParticipation`은 `workspaceEntered`가 명시된 프로젝트 진입에서만 자동 참여한다. 이 값이 없는 소개/명부 문맥과 비운영자는 조회·변경 요청을 보내지 않는다. 참여 상태는 effect 의존성이 아니므로 명시적 해제의 상태 갱신으로 재참여하지 않는다. 호출자는 검색·사이드바 토글을 별도 입장으로 취급하지 않도록 실제 Workspace 진입 생명주기에 컴포넌트를 유지해야 한다.
- 회귀 테스트: `services/pm/administrator-participation.test.ts`(트랜잭션·현재 권한·멱등성·알림 비생성), `administrator-participation-router.test.ts`(HTTP 경계), 프론트 `AdministratorParticipation.test.tsx`(진입·소개 제외·StrictMode·해제·채널·지연 응답). 실제 브라우저 진입/운영 검증은 별도다.
- migration `194_administrator_participation.sql` 적용이 선행되어야 한다. 미적용 DB에서는 일반 세션/검색 audience SQL도 실패하므로 코드만 먼저 배포하면 안 된다.

## Session Archive

- `session-trash-router.ts` is the compatibility-named owner of `GET /sessions/archived` (`/sessions/trash` alias) and `POST /sessions/:id/restore`, mounted before the generic `:id` lookup.
- Lists only the authenticated user's archived sessions and rechecks content access. The UI identifies the contents as archived sessions (not files). Selecting a conversation uses the existing App session-selection callback in the current main view and closes the archive menu; it does not unarchive it. Archived metadata is hydrated for the active title before selection, and historical file-presentation events are not replayed while loading an archived conversation (including cache refresh).
- Unarchive requires ownership, current read access and existing mutation authority. Read-only roles cannot unarchive; this is not an administrator audit endpoint.
- `api.ts` owns `POST /sessions/:id/archive`. Legacy `/hide` and `DELETE /sessions/:id` remain archive-only aliases. Empty sessions are preserved too. No ordinary permanent-delete route is exposed.
- Archive changes the shared session row, not a personal filter. The confirmation explains the effect on all participants.
- Worker-backed sessions remain visible but require separate lifecycle management; this endpoint never resumes a worker.
- Restored metadata is merged into the initiating sidebar and announced to the owner. Other participants refresh through existing authorized list flows.
- Tests: `session-trash-router.test.ts`, `session-trash-wiring.source.test.ts`; frontend `SessionTrash.test.tsx`, `Header.trash.test.tsx`.
- Decision: [Archive instead of deletion](../../../../docs/decisions/2026-09-14-session-archive-not-trash.md). Live deployment verification is separate.

## Agent directory / workspace entry integration (2026-09-15)

- `App.tsx` owns one `AdministratorParticipation` instance outside responsive/sidebar/search branches. `features/agent-directory/workspace-entry.ts` resolves actual conversation or Project Files entry; directory/introduction views do not participate.
- Company discovery is a separate minimal DTO via `routes/agent-directory-api.ts` and `services/pm/agent-directory.ts`; it never adds membership or Session/file authority. `AITeamHome` exposes the directory and reviewed visibility controls.
- Migration `198_agent_directory_visibility.sql` must precede directory API use. Since legacy Projects have no reliable public/private discovery field, **all existing Projects remain unlisted until reviewed**; new Projects explicitly use `unlisted` in the creation command (overriding the historical DB default of `listed`). The shared type, visibility API and migration CHECK accept only `listed`, `unlisted`, and `confidential`; `hidden` is not a persisted value. Directory queries remain invitation-scoped regardless of this metadata value. Existing authorized management lists are preserved.
- Local integration verification (2026-09-21): 관리자 참여·Workspace 진입·Agent directory 관련 8개 test files / 91 tests passed. These are mock/component/source checks, not live multi-user browser or database-migration verification. No deployment or migration was executed.

## Composer 조회 비용과 채팅 발화자 보정

- `composer-actions`는 접근 권한 검사 후 `getComposerMessageContext`로 최신 활성 assistant 본문 하나와 활성 메시지 수를 동일 SQL snapshot에서 읽습니다. `contextRevision`은 기존 활성 메시지 수 의미를 유지하며, 전체 대화 본문을 전송·파싱하지 않습니다. count 조회 비용까지 상수 시간이 된다는 뜻은 아닙니다.
- 정렬은 message_seq 지원 시 내림차순, legacy는 created_at/id 내림차순입니다. 회귀: `services/message-store.test.ts`.
- ChatPanel 발화자 보정은 세션·데이터 준비 상태가 바뀔 때 수행합니다. 메시지 수 증가만으로 진행 중 응답을 취소하지 않으며, 세션 전환·unmount 응답은 무시합니다. 회귀: `frontend/src/components/chat/ChatPanel.attribution.test.tsx`.
- 운영 배포와 브라우저 검증은 별도입니다.

## Session selection / reconnect recovery

- `useSessionSelection.ts` shares cancellation ownership across cached refresh and cold loads. Switching sessions or unmounting cancels the previous request. Cached refreshes and cold loads both have a ten-second abort deadline. Superseded cold-load finalizers cannot clear a newer request's loading indicator; aborted responses cannot overwrite a return visit to the same session.
- `useChatRuntime.ts` checks the latest streaming set and open WebSocket before draining a background queue after reconnect. An obsolete reconnect timer or missing session-list entry leaves queued input intact. This does not guarantee recovery readiness or server acceptance of a sent frame.
- Regression: `useChatRuntime.reconnect-queue.test.ts`, `useSessionSelection.request-ownership.test.ts`, `useSessionSelection.source.test.ts` execute extracted production blocks or assert source wiring. Full browser loading/render latency and deployment interruption still require live verification.

### Unscoped WebSocket errors

The frontend error branch treats missing/blank sessionId as an operation failure: it shows a generic localized operation notification without changing streaming, compacting or turn state. Explicit current-session errors retain existing turn failure behavior; background-session errors remain filtered. Previously, session filtering already rejected unscoped errors when a session was selected, but accepted them before selection. This fix does not establish the origin of a previously observed generic response-failure notification. Regression: `useChatRuntime.error-boundary.test.ts` (production handler extraction); local related suite: 7 files / 30 tests passed, typecheck passed. Live browser verification remains pending.

활성 admin은 이메일 등록 여부와 무관하게 Project 세션 목록·검색·조회의 멤버십 검사에서 예외다. 다른 사용자의 private 세션, 채널 audience, 실행·변경 권한은 이 예외로 우회하지 않는다.

### Personal favorite updates

`PATCH /sessions/:id` with only a boolean `favorite` checks ordinary Session read access and stores the flag in `session_user_states` through `setSessionFavorite`. It returns without mutating shared Session metadata. A mixed favorite/content request must pass the stricter mutation guard before any write; malformed favorite-only values return 400. `agent-role-boundaries.test.ts` executes the actual handler against read-only, writable and unauthorized fixture actors.

# services/session — Claude/Pi 세션 라이프사이클

Tower 의 **AI 세션** 모듈. Claude 또는 Pi 엔진과의 1:1 대화 세션의 영속성·아카이브·복원·공유·관계 추적을 담당.

> 주의: "session" 은 AI 와의 대화 세션. 사용자 간 채팅 룸 (`services/room/`) 과 별개. 두 개념 헷갈리지 말 것.

## 책임

- **세션 CRUD** — 생성, 조회, 업데이트, 삭제 (soft + hard)
- **아카이브 / 복원** — 보관함 (archived) 으로 이동·복구
- **세션 공유** — 같은 워크스페이스 사용자 간 (internal) + 외부 토큰 링크 (external)
- **세션 백링크** — "다른 세션에서 같은 파일을 만진 적 있음" 관계 추적 (Level 1: 파일 기반)
- **stale 세션 감사** — `.jsonl` 파일 누락 / 좀비 세션 정리
- **빈 세션 자동 정리** — 24시간 이상 아무 흔적 없이 방치된 기본 임시 세션만 복구 가능한 보관함으로 이동
- **Native Claude 세션 스캔** — `~/.claude/projects/` 디렉토리 인덱싱
- **세션 복제 (clone)** — 우클릭 복제 + 컨텍스트 분기

## Public API

### `session-manager.ts` — 세션 라이프사이클 (~14 export)
- `createSession` / `getSession` / `updateSession` / `deleteSession` / `getSessions`
- `getArchivedSessions` / `restoreSession` / `permanentlyDeleteSession` — 아카이브 흐름
- `cloneSession` — 컨텍스트 통째 분기 (decision 2026-04-28)
- `getPanelSessions` / `getSessionPanelSessions` — 룸 / 부모 세션의 패널 (sub-session) 조회
- `auditStaleSessions` — 부팅 시 1회, 좀비 정리
- `scanClaudeNativeSessions` — `~/.claude/` 디렉토리 인덱싱

### `session-backlinks.ts` — 세션 간 관계 (Level 1)
- `getRelatedSessionsByFiles(sessionId, files)` — 같은 파일을 만진 다른 세션 찾기
- `ensureMemoryIndex` — `~/.claude/memory.db` SQLite 인덱스 준비 (Node 22.5+ 필요)
- 두 소스 (Postgres `session_file_edits` + memory.db) UNION

### `session-share-manager.ts` — 세션 공유
- `createInternalSessionShare(sessionId, ownerId, targetUserId)` — 내부 공유 (같은 워크스페이스 사용자)
- `createExternalSessionShare(sessionId, ownerId, options)` — 외부 토큰 링크 (read-only)
- `getSharesBySession` / `getSessionSharesWithMe` — 조회
- `getSessionShareByToken(token)` — 외부 링크 검증
- `revokeSessionShare` — 공유 취소
- `hasInternalShareAccess(sessionId, userId)` — 권한 체크 (project-access 가 호출)
- `isSessionShareValid` — 만료·revoke 검증

### `session-creation-context.ts` — 신규 세션 cwd/project 정규화
- `resolveSessionCreationContext(input)` — `/api/sessions` 생성 시 explicit cwd, parent session, room, project 순서로 `cwd`와 `projectId`를 맞춤
- 프로젝트가 확인되는 AI panel/thread는 workspace root가 아니라 해당 project root를 사용

### `empty-session-cleanup.ts` — 방치된 빈 세션 보관
- `archiveExpiredEmptySessions` — 생성·수정 후 24시간이 지났고 메시지·작업·연결 흔적이 전혀 없는 기본 미분류 세션만 soft archive (`label IS NULL`, legacy `temp`/`미분류` 포함)
- `startEmptySessionCleanup` / `stopEmptySessionCleanup` — 백엔드 프로세스의 6시간 주기 정리 루프
- 영구 삭제하지 않으며, 이름 변경·즐겨찾기·태그·파일·첨부·공유·자식·에이전트 연결 등 하나라도 있으면 제외

## 들어오기 전에 알아야 할 것

- **Claude/Pi 엔진 식별**: 세션 row 의 `engine` 컬럼 (`'claude'` | `'pi'`). 변경 불가 — 한 번 정해지면 끝까지.
- **`claudeSessionId` ≠ `id`**: 우리 PG row id 와 SDK 의 native session id 분리. SDK 가 발급한 id 가 `.jsonl` 파일명.
- **`.jsonl` 파일이 진실** — DB 에 메타만 있고 메시지 raw 는 `~/.claude/projects/<cwd-encoded>/<sessionId>.jsonl` 에 있음. clone / restore / audit 시 이 파일 존재 확인 필수.
- **deleteSession = soft-delete** (archived 로 이동). `permanentlyDeleteSession` 이 진짜 삭제 + .jsonl 파일 unlink.
- **세션 visibility**: `'private'` (소유자만) | `'project'` (프로젝트 멤버) | `'public'` (워크스페이스 누구나) — `getSessions` 가 role / visibility 조합으로 필터.
- **Panel 세션**: 한 세션이 다른 세션의 sub (`parentSessionId`) 일 수 있음. 채팅 사이드바의 트리 구조 표현.
- **백링크 (session-backlinks)**: Level 1 = 파일 단위. Level 2/3 (의미 단위) 는 미구현.
- **Native Claude scan**: SDK 내부 형식 의존 — Claude SDK 업데이트 시 호환성 깨질 수 있음.

## 관련 결정문서

- `workspace/decisions/2026-04-21-session-backlinks-level1.md` — 백링크 Level 1 설계
- `workspace/decisions/2026-04-28-session-clone.md` — clone 기능
- `workspace/decisions/2026-05-03-multi-session-safety.md` — 멀티 세션 충돌 방지
- `workspace/decisions/2026-05-03-ai-friendly-refactoring.md` — 이 폴더가 분리된 이유

## 관련 모듈

- `services/group-manager` — `createSession` 시 access 체크 (project membership)
- `services/jsonl-utils` — `.jsonl` 파일 찾기·파싱
- `services/message-store` — 세션 share 시 메시지 fetch (session-share-manager 가 import)
- `engines/index` — `getAllRunningSessionIds` 로 audit 시 살아있는 세션 식별
- `services/room/room-manager` — `@ai` 컨텍스트로 세션 생성 / 갱신 (dynamic import)
- `services/distiller/` — work-group 처리 시 세션 생성
- `services/proactive-agent` — 능동 알림 시 세션 생성
- `services/task-runner` — 태스크 실행 시 세션 생성·갱신
- `services/project-access` — `hasInternalShareAccess` 호출
- `routes/api.ts` / `routes/ws-handler.ts` — REST/WS 진입점

## 테스트

- `session-creation-context.test.ts` — 신규 세션/스레드 생성 시 parent/room/project 기반 cwd 정규화 검증.
- frontend 의 `session-filters.test.ts` 가 일부 추출 로직 검증.
- ws-handler.test.ts 에서 session-manager 를 `vi.mock` 으로 stub.

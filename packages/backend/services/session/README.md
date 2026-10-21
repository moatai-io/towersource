# services/session — Claude/Pi 세션 라이프사이클

Tower 의 **AI 세션** 모듈. Claude 또는 Pi 엔진과의 1:1 대화 세션의 영속성·아카이브·복원·공유·관계 추적을 담당.

> 주의: "session" 은 AI 와의 대화 세션. 사용자 간 채팅 룸 (`services/room/`) 과 별개. 두 개념 헷갈리지 말 것.

## 책임

- **일반 세션 수명주기** — 생성, 조회, 업데이트, 보관·보관 해제. 일반 사용자에게 삭제/휴지통을 제공하지 않습니다. 내부 hard-delete helper는 별도 운영/정리 경계이며 일반 세션 API에서 노출하지 않습니다.
- **아카이브 / 복원** — 보관함 (archived) 으로 이동·복구. 본인 소유의 일반 세션에서 직접 메시지를 보내면 자동 복원하고 `session_created`로 소유자의 목록을 갱신합니다. 열람, headless 자동 실행, panel chat, 초기 인터뷰, `agent_workers`에 등록된 세션은 자동 복원하지 않습니다. 구현: `restore-on-human-message.ts`, `../../routes/ws-handler.ts`; 회귀 테스트: `restore-on-human-message.test.ts`, `../../routes/ws-handler.test.ts`. 이 설명은 코드 계약이며 배포·실환경 검증을 의미하지 않습니다.
- **세션 공유** — 같은 워크스페이스 사용자 간 (internal) + 외부 토큰 링크 (external)
- **세션 백링크** — "다른 세션에서 같은 파일을 만진 적 있음" 관계 추적 (Level 1: 파일 기반)
- **stale 세션 감사** — `.jsonl` 파일 누락 / 좀비 세션 정리
- **빈 세션 자동 정리** — 24시간 이상 아무 흔적 없이 방치된 기본 임시 세션만 복구 가능한 보관함으로 이동
- **Native Claude 세션 스캔** — `~/.claude/projects/` 디렉토리 인덱싱
- **세션 복제 (clone)** — 우클릭 복제 + 컨텍스트 분기. 제목은 `(복제) 원본 제목`으로 만들고 원본의 visibility(`private` / `project` / `public`)를 유지합니다. 복제본 소유자는 복제를 실행한 사용자입니다. 기존 세션은 변경하지 않으며 개별 공유 권한·외부 공유 링크를 새로 복제하지 않습니다. 구현은 `session-manager.ts`의 `cloneSession`, 회귀 검증은 `session-manager.engine-switch.test.ts`를 참고합니다.
- **AI 최종 답변 unread 전환** — `session-user-state.ts`가 접근 권한과 별개인 참여·구독·읽음 커서를 소유합니다. 생성자와 username이 확인된 실제 사용자 메시지는 자동 구독하며, `session_ai_turn_completions`가 root turn별 완료를 중복 제거한 뒤 세션 sequence를 증가시킵니다. 세션 목록은 현재 사용자의 구독·읽음 cursor를 기본키 JOIN해 `unreadAiResponse`를 계산합니다. 구독·읽음 API는 기존 `canAccessSession`을 통과해야 하며, 기존 completion attention UI 전환은 후속 단계입니다.

## Public API

### `session-manager.ts` — 세션 라이프사이클 (~14 export)
- `createSession` / `getSession` / `updateSession` / `deleteSession` / `getSessions`
- `getArchivedSessions` / `restoreSession` / `permanentlyDeleteSession` — 아카이브 흐름. 보관·복원은 `updated_at`을 건드리지 않고 보관 시각을 `archived_at`에 기록합니다(마이그레이션 203/204). History 정렬은 `COALESCE(archived_at, updated_at)` 기준입니다.
- `cloneSession` — 컨텍스트 통째 분기 (decision 2026-04-28)
- `getPanelSessions` / `getSessionPanelSessions` — 룸 / 부모 세션의 패널 (sub-session) 조회
- `auditStaleSessions` — 부팅 시 1회, 좀비 정리
- `scanClaudeNativeSessions` — `~/.claude/` 디렉토리 인덱싱

### `session-user-state.ts` — AI 최종 답변 구독·읽음 커서
- `subscribeSessionParticipant` / `subscribeSessionParticipantByUsername` — 세션 생성 또는 확인된 사용자 재발언 시 현재 완료 sequence부터 자동 구독
- `recordCompletedAiTurn` — durable assistant가 있는 completed root turn을 멱등 기록하고 세션 sequence 증가
- `setSessionSubscription` — 과거 답변을 소급하지 않는 수동 구독·mute
- `markAiResponseRead` — 서버 완료 sequence로 제한되는 단조 증가 읽음 커서
- `getSessionUserState` — 구독 상태와 계산된 `unreadAiResponse` 조회

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

## AI의 내부 세션 링크 조회

- `/s/<session-id>` 링크는 웹페이지 대신 [`session_transcript_read`](../../engines/pi-session-transcript-tool.ts)로 읽습니다. 링크 전달 자체는 접근 권한을 부여하지 않습니다.
- 실제 열람은 `canAccessSession()`을 따릅니다. 플랫폼 `admin`에는 예외가 있지만, `operator`에는 전체 열람 예외가 없습니다. 소유권·명시적 내부 공유·해당 프로젝트/채널의 열람 조건을 충족해야 합니다.
- 도구 설명은 권한 부족(403), 세션 없음(404), 조회 실패를 구분하도록 안내합니다. 이번 변경은 설명 정합성 보완이며 접근 정책 변경이 아닙니다.
- 회귀 검증: [`pi-session-transcript-tool.test.ts`](../../engines/__tests__/pi-session-transcript-tool.test.ts), [`session-access-visibility.test.ts`](../pm/session-access-visibility.test.ts). 설치 서버 배포 및 실제 모델의 도구 선택 검증은 별도입니다.

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

## 자동 제목 생성

- 프론트엔드 업데이트 감지·새로고침 계약은 [Frontend update contract](../../../../../docs/architecture/frontend-update-contract.md)가 소유합니다. 부팅 ID와 배포 revision을 구분하며, 같은 revision의 서버 재시작만으로 새 버전 배너를 표시하지 않습니다.
- `auto-name-session.ts`는 REST `/auto-name`과 서버 턴 완료가 공유하는 생성·저장 경로입니다. 같은 프로세스에서 같은 세션의 중복 요청은 하나로 합칩니다. 서로 다른 세션의 제목 작업은 FIFO 대기열에서 한 번에 하나만 처리하며 재시도와 저장이 끝난 뒤 다음 작업을 시작합니다.
- 대기 후 실행 직전에 제목 자격을 확인합니다. 앞선 작업의 예외는 다음 작업을 막지 않습니다. 일반 대화·요약 호출은 제한하지 않으며, 다른 프로세스나 Fleet VM까지 합친 전역 제한은 아닙니다. 대기열은 메모리 기반이므로 재시작 시 사라지고, 기본 제목인 세션은 다음 턴·재연결 시 다시 시도합니다. 느린 호출은 뒤의 제목 표시를 지연시킬 수 있습니다.
- 기본 제목이고 수동 변경 표시가 없는 세션만 대상입니다. 실패 시 500ms 뒤 한 번만 재시도하고, 다시 실패하면 제목을 저장하지 않습니다. 다음 턴 완료 또는 재연결에서 다시 시도할 수 있습니다.
- 저장은 기존 이름과 `auto_named`를 확인하는 원자적 조건부 UPDATE로 수행해 생성 도중 수동 변경을 보호합니다.
- 이미 과거 fallback이 저장된 세션은 일반 제목과 구분할 영속 상태가 없으므로 자동으로 덮어쓰지 않습니다. 운영 데이터 복구와 배포는 별도 승인 대상입니다.
- 제목 스타일 프롬프트와 모델 설정은 이 수정에서 변경하지 않습니다.
- 회귀 테스트: `auto-name-session.test.ts`, `../auto-namer.test.ts`. 모의 provider 검증이며 운영 502 해결을 의미하지 않습니다.

### Fleet 세션 조회 검증

`scripts/fleet/fleet-nix-remote authenticated-smoke`는 실행 중인 Nix artifact의
`sessionAudienceSql` 및 operator metadata 조건을 사용해 `/api/sessions`의 ID 집합을
검증한다. 프로젝트 목록의 active 조건을 세션 목록에 복제하지 않는다. 퇴역 프로젝트의
세션도 멤버십·공유 등 현재 audience 조건으로 보일 수 있으며, 이 검사 변경은 접근 정책을
변경하지 않는다. API 호출 전후 예상 ID 집합이 달라지면 최대 3회 재시도하고, 계속 달라지면
미확정 실패로 종료한다. 안정된 상태의 ID 불일치는 개수가 같아도 실패한다.
회귀 계약: `packages/backend/fleet-authenticated-smoke-visibility.source.test.ts`.

## 연속 자동 재개 한도

- `spawn-rpc.ts`의 `MAX_AUTO_WAKE_CHAIN`은 부모 세션별 연속 자동 재개를 **10회**까지 허용합니다. 11번째부터는 보고를 남기되 자동 실행하지 않고 한도 도달을 알립니다.
- 사용자 메시지로 카운터를 초기화하면 다시 10회까지 허용합니다. 부모별 카운터는 독립적이며, 메모리 기반이므로 프로세스 재시작 시에도 초기화됩니다.
- 분당 전송 제한과 핑퐁 방지 제한은 변경하지 않습니다. 회귀 검증은 `spawn-rpc.source.test.ts`의 `auto-wake chain budget`에서 실제 예산 로직을 실행합니다. 로컬 테스트는 운영 반영의 증거가 아닙니다.

## Introduction 세션 공개 범위

Introduction에도 일반 세션 규칙을 적용합니다. 새 프로젝트 세션은 기본 `project`이며, 명시적으로 선택한 `private`는 유지합니다. 권한이 있는 사용자는 표준 API로 공개 범위를 변경할 수 있습니다. 기존 비공개 세션을 자동으로 프로젝트 공유로 바꾸지는 않습니다. 구현은 `session-manager.ts`와 `../../routes/session-core/session-core-router.ts`, 회귀 검증은 `session-manager.engine-switch.test.ts`와 `../../routes/session-core/session-core-access.test.ts`를 참고합니다.

### Account participation metadata

`currentUserParticipated` is account-scoped, never device-scoped. Both `getSessions` and actor-aware `getSession` use ownership, `session_user_states.participated_at`, and human message authorship. Actor-free metadata omits this field: an uncomputed value must not become `false` and overwrite an authenticated list snapshot. Regression coverage: `session-list-audience.test.ts` (single-session participation metadata). The latest-list recovery client uses `setRecentSessions` reconciliation rather than replacing separately hydrated Project lists. Local tests and database reads do not establish browser-level resolution or deployment.

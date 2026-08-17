# services/workspace — 파일시스템 / 검색 / 공유

워크스페이스 (`~/workspace/`) 의 파일시스템 작업, jsonl 세션 파일 처리, 검색 인덱스, 파일 공유 (내부 / 외부 토큰) 를 담당.

> 주의: 이 모듈의 `share-manager` 는 **워크스페이스 파일** 공유용. 세션 공유는 `session/session-share-manager.ts`. 이름 비슷해도 다른 도메인.

## 책임

- **파일 트리 / 읽기 / 쓰기 / 이동 / 삭제** — 워크스페이스 안 모든 fs 작업의 안전 게이트
- **경로 안전 검증** — `isPathSafe`, `isPathWritable` (사용자별 `allowed_path` 적용)
- **파일 변경 감시** — chokidar 기반 watcher, WS 로 frontend 에 푸시
- **JSONL 세션 파일** — Claude/Pi SDK 가 쓰는 `.jsonl` 파일 위치 찾기·완료 검증
- **세션 파일 편집 로그** — 어느 세션이 어느 파일을 만졌는지 (`file_edit_log`, session-backlinks 가 사용)
- **검색** — PG full-text 기반 메시지·세션·파일 검색 (highlighting 포함)
- **문서 탐색 인덱스** — Notes Index와 명시적 Markdown 링크 기반 Knowledge Graph
- **파일 공유** — 다른 사용자에게 직접 (internal) 또는 외부 토큰 링크 (external)

## Public API

### `file-system.ts` — 워크스페이스 fs 게이트 (~12 export)

모든 파일 작업의 안전 게이트. **워크스페이스 밖 절대경로는 거부.**
- `expandHome(p)` — `~/...` → 절대경로
- `isPathSafe(target, root?)` — 워크스페이스 안에 있는지 + symlink escape 차단
- `isPathWritable(target)` — admin/operator 만 root 직접 쓰기 가능 (멤버는 자기 프로젝트만)
- `getFileTree` / `getFileTreeAsync` — 디렉토리 트리, depth 제한, hidden 필터
- `readFile` / `writeFile` / `writeFileBinary` — 텍스트/바이너리 IO
- `createDirectory` / `deleteEntry` / `renameEntry` — fs 변경 작업
- `setupFileWatcher` / `stopFileWatcher` — chokidar watcher 라이프사이클
- `invalidateTreeCache(path?)` — 트리 캐시 무효화 (인메모리)
- `ALWAYS_HIDDEN` — `.git`, `node_modules`, `.DS_Store` 등 무조건 숨김

### `jsonl-utils.ts` — Claude SDK `.jsonl` 파일 도구

SDK 의 turn-by-turn append-only 파일 위치 찾기·검증.
- `buildJsonlPath(cwd, claudeSessionId, configDir?)` — `~/.claude/projects/<encoded-cwd>/<id>.jsonl`
- `findJsonlFile(claudeSessionId, cwd?, configDir?)` — 디렉토리 스캔으로 찾기 (cwd 모를 때)
- `checkJsonlForCompletion(jsonlPath)` — 마지막 turn 완료/응답 대기 판별
- `isSessionResponseComplete(jsonlPath)` — boolean 단순 wrapper

### `file-edit-log.ts` — 파일 편집 이력

세션이 파일을 만질 때마다 PG row INSERT.
- `recordFileEdit(sessionId, filePath, ...)` — 단일 진입점

`session/session-backlinks` 가 이 테이블을 join 해서 "다른 세션이 같은 파일 만짐" 조회.

### `notes-index.ts` / `knowledge-graph.ts` — 문서 탐색

- `scanNotesIndex(rootPath, options)` — 사람이 읽을 만한 파일의 제목·유형·최근성을 분류
- `buildWorkspaceKnowledgeGraph(rootPath, options)` — Markdown link, wikilink, frontmatter `sources`/`lineage`를 read-only 노드·엣지로 변환
- 의미 유사도나 AI 추론은 넣지 않으며 unresolved link는 별도 노드로 표시 가능
- API route가 기존 project/path ACL을 통과시킨 뒤 호출해야 함

### `search.ts` — 워크스페이스 통합 검색

PG full-text 기반. 메시지 + 세션 메타 + 파일 (선택적) 한 번에.
- `search(query, opts)` — 메인 진입점
- `SearchOptions`: `userId`, `role`, `limit`, `offset`, scope filters
- `HIGHLIGHT_START` / `HIGHLIGHT_END` — 하이라이트 마커 (UI 가 stylize)

### `share-manager.ts` — 파일 공유 (DB 행)

워크스페이스 파일 1개를 다른 사용자 / 외부 사람과 공유.
- `createInternalShare(filePath, ownerId, targetUserId)` — 같은 워크스페이스 사용자
- `createExternalShare(filePath, ownerId, expiresIn)` — 토큰 링크 (`?share=<uuid>`)
- `getSharesByFile` / `getSharesWithMe` — 조회
- `getShareByToken(token)` — 외부 링크 검증
- `revokeShare` / `isTokenValid` — 만료·revoke

## 들어오기 전에 알아야 할 것

- **모든 fs 작업은 isPathSafe 통과 필수** — 사용자가 `../../etc/passwd` 같은 거 시도하면 거부. symlink escape 도 차단.
- **사용자별 allowed_path 가 있으면 그 안만** — admin/operator 는 워크스페이스 전체, 멤버는 `projects/<자기 프로젝트>/` 안만.
- **dotfile 차단** — `.claude/`, `.audit/`, `.mcp.json` 같은 시스템 디렉토리는 file API 로 안 보임 (admin 도). ssh 직통만 가능.
- **파일 트리 캐시 = 인메모리** — 프로세스 단위. 변경 후 `invalidateTreeCache` 호출 필수.
- **JSONL 위치 찾기 비용** — `findJsonlFile` 은 디렉토리 스캔이라 O(N). cwd 알면 `buildJsonlPath` 가 O(1) — 우선 시도 권장.
- **share-manager 와 session-share-manager 혼동 금지** — 이건 파일 공유, 저쪽은 세션 (대화) 공유.
- **검색은 PG FTS5 기반** — `search_index` 테이블 + tsvector. 인덱스 재빌드 비용 있음.
- **file-edit-log 는 fire-and-forget** — 실패해도 throw 안 함 (best-effort, 로그만).

## 관련 결정문서

- `workspace/decisions/2026-04-21-session-backlinks-level1.md` — file-edit-log + session-backlinks 의 관계
- `workspace/decisions/2026-05-02-workspace-root-isolation.md` — 워크스페이스 ACL 정책 (allowed_path)
- `workspace/decisions/2026-05-03-path-portability.md` — `expandHome` 의 ~ expand 정책
- `workspace/decisions/2026-05-03-ai-friendly-refactoring.md` — 이 폴더가 분리된 이유

## 관련 모듈

- `services/auth/auth.ts` — 사용자 `allowedPath` 설정 / 조회
- `services/damage-control` — `isPathWritable` 의 ACL 결정
- `services/session/session-manager` — `findJsonlFile` 호출, audit 시 사용
- `services/session/session-backlinks` — `file_edit_log` 테이블 join
- `services/claude-sdk` — `findJsonlFile` 로 SDK resume 시 파일 검증
- `services/task-runner` — `checkJsonlForCompletion` 으로 task 완료 판별
- `routes/api.ts` — fs CRUD REST 엔드포인트
- `routes/ws-handler.ts` — 파일 watcher 이벤트 broadcast

## 테스트

- 단위 테스트 없음 (대부분 fs / PG 의존성). ws-handler.test.ts 가 file-system 을 vi.mock 으로 stub.

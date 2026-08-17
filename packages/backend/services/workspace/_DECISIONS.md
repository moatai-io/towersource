# workspace 모듈 — 구조 결정

## 왜 5 파일이 한 폴더에 묶였나

워크스페이스 *fs 게이트* (file-system), *jsonl 위치* (jsonl-utils), *편집 이력* (file-edit-log), *검색* (search), *파일 공유* (share-manager) — 다섯 다 "워크스페이스 파일 / 데이터 접근" 도메인. 묶으면 AI 가 "워크스페이스 파일 작업" 받았을 때 한 폴더만 읽으면 끝.

## 왜 jsonl-utils 가 여기인가 (engines/ 아니고)

`.jsonl` 은 SDK 가 만들지만 **위치는 워크스페이스 안의 cwd 기반** (`~/.claude/projects/<encoded-cwd>/...`). 즉 워크스페이스 fs 의 함수. SDK 호출은 engines/ 가 하지만 *파일 위치 찾기* 자체는 fs 작업이라 여기.

## 왜 file-system 이 모놀리식 15KB 한 파일인가

읽기·쓰기·트리·watcher·캐시 — 분리 후보였지만 유지. 이유:
- `isPathSafe` / `isPathWritable` 가 모든 함수의 prologue → 같은 cache 공유
- 트리 캐시·watcher state 를 같은 파일 안에서 invalidate 일관성 유지
- 외부 호출자가 한 번에 여러 함수 import (`readFile, writeFile, isPathSafe, expandHome` 같이 묶음)

분리하면 import 경로만 늘어나고 응집은 깨짐. **deep module 의 정확한 정의.**

## 왜 share-manager 가 session-share-manager 와 분리되어 다른 폴더인가

이름 비슷하지만 다른 도메인:
- **workspace/share-manager** = 워크스페이스 *파일* 공유 (file_path 필드)
- **session/session-share-manager** = AI *대화 세션* 공유 (session_id 필드)

DB 테이블도 다름 (`workspace_shares` vs `session_shares`). 코드 패턴은 유사하지만 ACL / 알림 / 만료 정책이 따로 발전 가능. 합치면 generic share manager 가 되어 한쪽 정책 바꿀 때 다른 쪽 영향.

향후 `notebook-share`, `kanban-share` 등 추가될 가능성 → 도메인별 분리 유지.

## 왜 file-link-manager 는 share-manager 와 분리하나

`/f/:shortId` 는 외부 공개 공유가 아니라 **로그인 사용자의 보기 좋은 내부 파일 링크**다. 만료·revocation·외부 render 정책을 가진 `shares` 와 합치면 단순 URL 미관 개선이 공유 정책 변경처럼 보인다.

따라서 `file_links` 는 path alias 만 저장하고, 실제 접근 권한은 resolve 후 기존 file API ACL(`isPathAccessible`, dotfile deny)에 다시 맡긴다. 짧은 링크를 가진 사람도 권한이 없으면 못 연다.

## 왜 search 가 한 함수 (search) 만 export 하나

`SearchOptions` 가 모든 옵션 (scope, filter, paging) 흡수. 호출자는 한 함수만 알면 됨. 내부 구현은 풍부 (PG FTS5 + tsvector + 다중 source UNION) 하지만 **인터페이스는 좁음** = AI 친화. 새 source 추가해도 호출자 변경 없음.

## 왜 메시지 검색 문서를 SQL 함수로 정규화하나

Issue #140에서 tool_use JSON, 긴 URL, base64/serialized blob이 메시지 검색 인덱스와 스니펫을 오염시키는 문제가 확인됐다. expression GIN 인덱스는 query expression과 완전히 같아야 하므로, `tower_message_search_document(content)` SQL 함수를 두고 인덱스와 runtime query가 같은 정규화 문서를 보게 한다. TypeScript의 `normalizeMessageSearchText`는 스니펫/테스트용으로 같은 의도를 맞추되, search public API는 계속 `search(query, opts)` 하나로 유지한다.

## 왜 file-edit-log 가 fire-and-forget 인가 (실패해도 throw 안 함)

이 로그는 **분석/추적용** — 빠지면 session-backlinks 가 일부 빠진 결과 보여줄 뿐, 시스템 동작은 정상. PG 일시 장애 시 핵심 fs 작업은 계속되어야 함. throw 하면 작업 자체가 깨짐 → 우선순위 잘못. log + continue 가 정답.

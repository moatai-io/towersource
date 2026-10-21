# Navigation Sidebar

Tower의 좌측 탐색 영역에서 도메인별 UI를 작은 feature module로 분리한다.

## Public API
- `project-files/SidebarProjectFiles.tsx`: 현재 Agent Project의 파일 트리 탐색과 파일 quick action
- `sessions/SidebarSessionsToolbar.tsx`: Session 검색·종류·소유·favorite·완료·deck 필터 toolbar
- `sessions/sidebar-session-list-model.ts`: Session/상단 최근 Session의 공통 필터·정렬·Project grouping 순수 계산
- `sessions/use-sidebar-archived-sessions.ts`: 보관 포함 시 본인 보관 목록의 지역 snapshot과 재시도·취소·재조회
- `sessions/sidebar-session-timeline-model.ts`: 최근 Session의 날짜 라벨과 인접 Project run 순수 계산
- `sessions/SidebarSessionTimeline.tsx`: timeline 날짜 header와 Project run 표현
- `sessions/sidebar-agent-rail-model.ts`: Agent rail의 Project별 Session 수집과 pin/activity 정렬 순수 계산

## 접힌 Agent rail의 임시 펼침
- `components/layout/AgentNavigationRail.tsx`는 접힌 rail에 마우스를 올리거나 키보드 포커스를 주면 목록 전체를 임시로 펼쳐 모든 Agent 이름과 내비게이션 항목을 표시합니다.
- 임시 펼침은 인접 Session 목록 위에 겹쳐 표시하며 레이아웃을 밀지 않습니다. 마우스가 rail을 벗어나거나 포커스가 외부로 이동하거나 Escape를 누르면 접힙니다. 사용자가 저장한 펼침 상태는 변경하지 않습니다.
- 회귀 검증: `components/layout/AgentNavigationRail.hover-name.source.test.ts`.

## 상태 소유권
- Project tree cache, expanded project/path, refresh trigger: `stores/file-store.ts`
- Session 검색 결과와 pagination/running/unread state: 상위 `Sidebar.tsx`와 `stores/session-store.ts`
- Session filter persistence와 filter state: 상위 `Sidebar.tsx`; toolbar는 callback만 호출합니다. 새 세션 생성의 sidebar reveal 이벤트는 필터·검색을 변경하지 않고, 파일 탭의 명시적 "사이드바에서 찾기"만 숨겨진 세션을 찾기 위해 필터를 조정합니다. 상단 최근 세션도 저장된 종류·관계·상태 필터를 따르되 참여 여부와 숨김 상태는 별도로 유지합니다.
- 보관 포함은 기존 `sidebar-search-archived` localStorage 키에 저장하며 일반 목록·최근 목록·검색에 적용한다. 보관 목록은 `/api/sessions/archived`에서 검색어 없이 가져와 지역 상태로만 합친다. 보관해제 후 live row가 우선하고, 필터를 끄면 deep-link 열람으로 store에 들어온 보관 row도 제외한다.
- 보관 조회는 요청 취소·실패·재시도를 구분하며, live 세션 ID 집합 또는 `tower-session-archive-changed` 이벤트가 바뀌면 재조회한다. 보관 row에도 기존 소유·즐겨찾기·종류·완료 및 Project/Space 경계를 적용한다.
- `SidebarSessionsToolbar.test.tsx`와 `use-sidebar-archived-sessions.test.tsx`가 토글·지역 병합·재시도·늦은 응답 무시를 검증합니다. `sidebar-session-list-model.test.ts`는 최근 목록의 공통 필터 적용을, `Sidebar.session-reveal.source.test.ts`는 생성/명시적 찾기 경계를 검증합니다. 브라우저/운영 서버 종단 검증은 별도입니다.
- 비서실은 `AppMenu`의 개인 메뉴(`global-nav-secretariat`)에서 `activeView='secretariat'`으로 연결하며, desktop/mobile router와 `?view=secretariat`을 공유한다. 진입 시 대화 목록·system tab 충돌을 해제하고 sidebar를 닫는다. 계정별 토글·미열람 보류·본문 표시 이후 읽음·실패/retry의 owning contract는 [`../secretariat/README.md`](../secretariat/README.md)에 있다. 외부 알림과 자동 실행/승인은 포함하지 않는다. 로컬 컴포넌트/URL/라우터 테스트와 합성 API 기반 Chromium 1280px·390px 흐름은 실행했으며, 운영 backend/정기 점검은 미검증이다.
- Sidebar tab과 모바일 drawer close: 상위 `App.tsx`/`Sidebar.tsx`
- 파일·Session 선택 결과: 상위에서 전달받은 callback

## 경계
- 이 feature는 App-level navigation state를 새로 소유하지 않는다.
- Session toolbar는 Session 목록, grouping, pagination 또는 running state를 직접 계산하지 않는다.
- timeline 표현 컴포넌트는 store·API를 직접 사용하지 않고 Session interaction callback을 상위에 위임한다.
- 목록·timeline 모델은 DOM·store를 직접 읽지 않고 상위에서 받은 snapshot만 계산한다.
- timeline 모델은 전역 최근순을 재정렬하지 않고 같은 날짜의 인접한 동일 Project Session만 묶는다.
- Agent rail 모델은 conversation filter와 독립적으로 전체 Project를 유지하고 pin 순서 후 활동순으로 정렬한다.
- 1단 Agent rail의 선택된 최근 세션·Team·Agent 이름은 Tower의 명시적 light theme에서 어두운 `--th-text-primary`를 사용한다. OS가 dark를 선호해도 선택 상태의 글자가 밝은 색으로 덮이지 않도록 `index.css`의 `data-theme="light"` 규칙을 우선한다. 회귀는 `AgentNavigationRail.theme-contrast.source.test.ts`에서 확인하며 실제 브라우저의 OS/theme 조합은 별도 검증이다.
- 기존 CSS class, 문구, API URL과 callback semantics를 유지한다.
- 전체 파일 관리 workspace는 `FilesWorkspace`가 계속 소유한다.

## 보관된 세션 포함

- `use-sidebar-archived-sessions.ts`가 활성화 시 개인 보관 목록을 별도 snapshot으로 조회합니다. 일반 세션 store에 목록 전체를 병합하지 않습니다.
- toolbar의 `includeArchived` callback은 Sidebar 상태와 저장된 필터에 연결됩니다. 검색어 없는 목록과 검색 모두에 적용합니다.
- `SessionMeta.archived`는 보관 열람/deep-link 후에도 기본 목록에서 제외할 수 있는 서버 metadata입니다. 보관 해제 시 활성 metadata가 우선합니다.
- 기존 종류·소유·즐겨찾기·완료·프로젝트 필터를 유지하고 `SessionItem`은 보관 배지를 표시합니다.
- 검증: `sessions/use-sidebar-archived-sessions.test.tsx`, `sessions/SidebarSessionsToolbar.test.tsx`.
- 결정: [세션 보관 정책](../../../../../docs/decisions/2026-09-14-session-archive-not-trash.md).

## 파일 트리 새로고침의 탐색 위치 보존

- 최초 로딩에만 최상위 목록을 먼저 표시합니다. 이미 로드된 트리는 열린 하위 폴더의 재조회가 완료될 때까지 유지하고 완성된 결과로 교체합니다. 새로고침 도중 root-only 목록을 노출하면 목록 높이가 줄어 스크롤 위치가 유실될 수 있습니다.
- `FileTree`의 삭제는 성공한 항목의 부모 폴더를 중복 없이 갱신합니다. 부분 갱신에서도 `fillExpanded`로 열린 하위 폴더를 복원한 뒤 반영합니다.
- 서버 변경 알림의 전체 재조회/재시도는 유지하지만, 그 과정에서도 기존 트리를 제거하지 않습니다. 별도 스크롤 앵커 복원이나 서버 이벤트 병합은 이번 변경에 포함하지 않습니다.
- 회귀 검증: `project-files/SidebarProjectFiles.refresh.test.tsx`는 지연된 하위 폴더 응답 중 기존 펼침 항목이 유지되는지 확인합니다. `SidebarProjectFiles.source.test.ts`는 최초 로딩 분기를 보호합니다. 실제 브라우저의 스크롤 위치와 운영 배포 검증은 별도입니다.

## 검색 부분 장애 표시

- Sidebar 검색은 `X-Tower-Search-Partial: true` 응답의 성공 결과를 유지하고 `SidebarSearchNotice`에 불완전한 결과임을 표시합니다. HTTP/네트워크 실패도 정상적인 0건과 구분합니다.
- 검색어 변경·초기화·재시도 때 이전 상태를 비우고, 취소된 요청은 JSON 파싱 완료 후에도 결과나 경고를 덮어쓰지 않습니다. 재시도는 현재 검색어·보관 필터를 유지합니다.
- 실패 구간 이름이나 서버 오류 상세는 화면에 노출하지 않으며 경고는 `role=status`로 알립니다. 기존 읽기 권한과 결과 필터는 유지합니다.
- 검증: `sessions/SidebarSearchNotice.test.tsx`. 실제 브라우저 및 운영 장애 주입 검증은 별도입니다.

## Latest Session cross-device recovery

Latest Session data is refreshed from `/api/sessions` and `/api/session-attention` on WebSocket reconnection, visible app return, focus, and network recovery, including when no chat is active. `utils/latest-session-sync.ts` coalesces concurrent requests and retains the previous list if the session request fails. After an authenticated attention write, the backend broadcasts `session_attention_updated` only to that user; connected clients reload the authoritative snapshot. This also recovers notifications missed while a mobile tab was suspended. Device-local filters and selected Project remain device-local, so identical account data does not imply identical filtered lists.

Code: `hooks/useChatRuntime.ts`, `utils/latest-session-sync.ts`, backend `routes/api.ts` session-attention handlers. Tests: `utils/latest-session-sync.test.ts`, `utils/latest-session-persistence.test.ts`, `sessions/sidebar-session-list-model.test.ts`. Local tests/typecheck are not evidence of deployment or two-device live verification.

### 이전 참여 에이전트

Agent rail은 `/api/agent-directory/previous-participation`의 이름 전용 DTO를 별도 ‘이전 참여’ 영역에 ‘미참여’로 표시한다. 현재 Project 목록과 합치지 않고, 세션 제목·본문·실행 진입점을 제공하지 않는다. 현재 참여 에이전트는 중복 표시하지 않는다. 권한 변경으로 Project 목록이 갱신되면 이력도 다시 조회한다. `AgentNavigationRail.previous-participation.source.test.ts`가 비실행 표시 경계를 보호한다.

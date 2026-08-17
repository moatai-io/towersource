# Navigation Sidebar

Tower의 좌측 탐색 영역에서 도메인별 UI를 작은 feature module로 분리한다.

## Public API
- `project-files/SidebarProjectFiles.tsx`: 현재 Agent Project의 파일 트리 탐색과 파일 quick action
- `sessions/SidebarSessionsToolbar.tsx`: Session 검색·종류·소유·favorite·완료·deck 필터 toolbar
- `sessions/sidebar-session-list-model.ts`: Session 필터·정렬·Project grouping 순수 계산
- `sessions/sidebar-session-timeline-model.ts`: 최근 Session의 날짜 라벨과 인접 Project run 순수 계산
- `sessions/SidebarSessionTimeline.tsx`: timeline 날짜 header와 Project run 표현
- `sessions/sidebar-agent-rail-model.ts`: Agent rail의 Project별 Session 수집과 pin/activity 정렬 순수 계산

## 상태 소유권
- Project tree cache, expanded project/path, refresh trigger: `stores/file-store.ts`
- Session 검색 결과와 pagination/running/unread state: 상위 `Sidebar.tsx`와 `stores/session-store.ts`
- Session filter persistence와 filter state: 상위 `Sidebar.tsx`; toolbar는 callback만 호출
- Sidebar tab과 모바일 drawer close: 상위 `App.tsx`/`Sidebar.tsx`
- 파일·Session 선택 결과: 상위에서 전달받은 callback

## 경계
- 이 feature는 App-level navigation state를 새로 소유하지 않는다.
- Session toolbar는 Session 목록, grouping, pagination 또는 running state를 직접 계산하지 않는다.
- timeline 표현 컴포넌트는 store·API를 직접 사용하지 않고 Session interaction callback을 상위에 위임한다.
- 목록·timeline 모델은 DOM·store를 직접 읽지 않고 상위에서 받은 snapshot만 계산한다.
- timeline 모델은 전역 최근순을 재정렬하지 않고 같은 날짜의 인접한 동일 Project Session만 묶는다.
- Agent rail 모델은 conversation filter와 독립적으로 전체 Project를 유지하고 pin 순서 후 활동순으로 정렬한다.
- 기존 CSS class, 문구, API URL과 callback semantics를 유지한다.
- 전체 파일 관리 workspace는 `FilesWorkspace`가 계속 소유한다.

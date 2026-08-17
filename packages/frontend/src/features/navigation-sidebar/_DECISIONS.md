# Navigation Sidebar decisions

- `Sidebar.tsx`는 전체 shell과 탭 조립을 맡고, 도메인 UI는 feature 폴더로 이동한다.
- Project file tree의 지속 상태는 기존 `file-store` 한 곳에서만 소유한다.
- 추출 과정에서 범용 context나 새 abstraction을 만들지 않고 기존 props를 유지한다.
- 모바일 drawer close와 active tab 전환은 상위 App wrapper에 남긴다.
- Session 영역은 먼저 표현 경계가 명확한 검색·필터 toolbar를 추출한다. Session grouping, agent rail, pagination, running/unread 계산은 상위에서 계속 소유해 한 번에 상태 경계를 바꾸지 않는다.
- toolbar는 filter persistence를 직접 수행하지 않고 `Sidebar.tsx` callback을 호출한다. 따라서 desktop/mobile이 같은 저장 규칙과 상태를 공유한다.
- Session 목록 모델은 pure input/output module로 둔다. Zustand snapshot 수집과 React memoization은 `Sidebar.tsx`가 맡고, 모델은 favorite 우선 정렬·검색 결과 제한·filter 조합·빈 Project 포함 grouping만 수행한다.
- 최근 Session timeline은 날짜 라벨과 인접 Project run만 순수 모델로 계산한다. 전체 최근순을 Project별로 재정렬하지 않아 사용자의 활동 시간축을 보존한다.
- timeline 표현은 props-only 컴포넌트로 두고, 선택·최근 목록 숨김·이름 변경·favorite·Project 이동 callback은 `Sidebar.tsx`가 계속 소유한다.
- Agent rail 모델은 conversation filter를 받지 않는다. teammate 탐색과 running 상태가 우측 Session filter 때문에 사라지지 않도록 전체 Project·Session snapshot만 입력받는다.

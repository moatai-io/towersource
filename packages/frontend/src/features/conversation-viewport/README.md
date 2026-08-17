# conversation-viewport

대화창 스크롤 안정성을 위한 작은 순수 로직 계층입니다. `ChatPanel.tsx`에 누적된 스크롤 판단을 한 번에 옮기지 않고, 먼저 테스트 가능한 규칙으로 분리합니다.

## 책임

- 사용자가 기록을 읽는 중인지, 최신 답변을 따라가도 되는지 판단합니다.
- streaming chunk, session switch, jump-to-latest, anchor restore 같은 이벤트를 상태기계로 표현합니다.
- prepend/loadMore 후 scrollTop 보정 같은 위치 계산을 순수 함수로 제공합니다.

## Public API

- `viewportTypes.ts`
  - `ScrollIntentMode`
  - `ScrollIntentState`
  - `ViewportMetrics`
  - `PrependAnchorSnapshot`
- `scrollIntentMachine.ts`
  - `createScrollIntentState`
  - `reduceScrollIntent`
  - `shouldAutoFollowOutput`
- `scrollPositionMath.ts`
  - `bottomScrollTop`
  - `isNearBottom`
  - `clampScrollTop`
  - `restorePrependScrollTop`
- `useConversationViewport.ts`
  - `useConversationViewport`
- `sessionViewportSnapshot.ts`
  - `ChatViewportSnapshot`
  - `chooseSessionViewportRestorePlan`
  - current browser-tab `sessionStorage` snapshot lifecycle

## 들어오기 전 알아야 할 것

현재 실제 DOM/Virtuoso 제어는 아직 `components/chat/ChatPanel.tsx`에 있습니다. 이 모듈은 1차 안전망입니다. 다음 단계에서 `ChatPanel.tsx`의 `userScrolledUp`, `isAtBottom`, `settleUntil`, `followOutput`, `jumpToLatest` 판단을 이 모듈로 점진 연결합니다.

## 핵심 규칙

1. 사용자가 위로 올라가면 자동 follow는 즉시 멈춥니다.
2. streaming 중이라도 `user-reading-history` 상태에서는 bottom으로 끌어내리지 않습니다.
3. jump-to-latest는 명시적 사용자 의도이므로 bottom pinning을 회복합니다.
4. prepend/anchor restore 중에는 bottom settle loop가 anchor를 덮어쓰면 안 됩니다.
5. DOM 쓰기는 이 모듈 밖 adapter/hook에서만 합니다.
6. 열린 탭 재방문은 raw `scrollTop`이나 Virtuoso `StateSnapshot`이 아니라 rendered message ID와 viewport 상대 offset으로 복원합니다.
7. Snapshot은 현재 browser tab의 `sessionStorage`에 안정적인 message anchor만 저장합니다. Vite HMR·새로고침은 견디되, Virtuoso 측정값이나 raw scrollTop은 영속화하지 않습니다.
8. 명시적 `#m-<shortId>` deep link는 저장된 읽기 위치보다 우선하며, 대상 메시지를 viewport 시작점에 정렬하고 잠시 강조합니다. 일반 세션 열기와 메시지 내비게이션의 정렬 정책에는 적용하지 않습니다.

## 관련 파일

- `packages/frontend/src/components/chat/ChatPanel.tsx`
- `packages/frontend/src/stores/chat-store.ts`
- `packages/frontend/src/hooks/useChatRuntime.ts`
- `packages/frontend/src/components/chat/ChatPanel.source.test.ts`

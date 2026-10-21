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

## Layout drift and restoration lifetime

- `observeBottomLayout.ts` observes the plain content wrapper and Virtuoso's measured item list (not only its fixed-height viewport). Late intrinsic image growth follows the bottom only while the caller retains bottom intent. Disposal cancels scheduled DOM writes; scrollbar dragging relinquishes ownership.
- `ChatPanel` snapshots preserve bottom intent rather than treating temporary geometry drift as history reading. Wheel/touch/keyboard/scrollbar input and explicit navigation own intent transitions.
- Session restoration depends on session/renderer/readiness, not each messages-array replacement. Anchor indices are resolved from stable message IDs against the latest list, including prepend. Cancellation clears both RAF handles and restoration state.
- Message-link requests have one hash-state owner. Delayed retries are cancelled on disposal and fenced by session visit and interaction generation. A jump to latest cancels pending history restoration.
- `ChatPanel.scroll-lifecycle.test.tsx` and `ChatPanel.deep-link-lifecycle.test.ts` execute the current production effect bodies with controlled schedulers. They supplement, not replace, real-browser geometry tests.

## 메시지 링크의 이전 대화 탐색

`useMessageAnchorHistory.ts`는 `/s/:key#m-:shortId`의 대상이 초기 메시지에 없으면
기존 `onLoadMore`를 순차 호출합니다. 대상이 로드되면 `ChatPanel`의 기존 앵커
스크롤·강조 처리가 이어받습니다. 초기 로딩 중에는 시작하지 않으며 세션·해시 변경과
unmount 시 탐색을 중단합니다. 다른 이전 대화 요청이 실행 중이면 완료를 기다립니다.
끝까지 찾지 못하면 안내하고, 페이지 커서가 진행하지 않으면 실패 안내 후 중단하여
동일 요청의 무한 반복을 막습니다. 권한 검사와 데이터 조회는 기존 메시지 API를 그대로 사용합니다.

- 동작 검증: `useMessageAnchorHistory.test.tsx` (여러 페이지, 미발견, 요청 실패, 세션 변경, 초기 로딩)
- 스크롤 수명주기: `../../components/chat/ChatPanel.deep-link-lifecycle.test.ts`
- 실제 브라우저의 긴 세션 이동·강조는 별도 실기기 확인이 필요합니다.

### 새 탭 진입 시 스크롤 준비 조건

앵커 스크롤은 `renderSessionLoading`이 끝나고 채팅 탭이 foreground인 경우에만
요청을 처리한 것으로 표시합니다. 초기 로딩 skeleton이나 비활성 탭에서 요청을
소비하면 실제 스크롤러가 준비된 뒤 재시도가 사라지므로, 두 상태를 effect의
의존성으로 추적합니다. 예약된 위치 이동이 cleanup으로 취소되면 처리 표시도
해제하되 사용자가 직접 스크롤한 요청은 되살리지 않습니다.
`ChatPanel.deep-link-lifecycle.test.ts`에서 초기 로딩 → 준비와 비활성 → 활성 전환을 검증합니다.

# conversation-viewport decisions

## 2026-07-05 — 먼저 순수 상태기계로 분리한다

`ChatPanel.tsx`에는 streaming follow, session settle, Virtuoso measurement drift, anchor restore, loadMore prepend, jump controls가 한 파일 안에 섞여 있다. 바로 DOM 제어를 갈아엎으면 회귀 범위가 커지므로, 먼저 순수 상태기계와 위치 계산 함수를 만든다.

## 2026-07-05 — 사용자 스크롤 의도가 자동 follow보다 우선한다

스트리밍 중이라도 사용자가 위로 스크롤했으면 `user-reading-history`로 전환하고 `shouldAutoFollowOutput`은 false를 반환한다. 최신 답변으로 복귀하는 유일한 경로는 사용자가 bottom 근처로 돌아오거나 jump-to-latest를 명시적으로 누르는 것이다.

## 2026-07-05 — Virtuoso/DOM 객체는 모듈 경계 밖에 둔다

이 모듈은 DOM, ref, Virtuoso handle을 직접 받지 않는다. 실제 `scrollTop` 쓰기와 `scrollToIndex` 호출은 이후 adapter/hook 계층에서 수행한다. 이렇게 해야 상태 전환을 node 환경 단위 테스트로 빠르게 검증할 수 있다.

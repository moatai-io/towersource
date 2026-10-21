# Session Navigator contracts

> **Research Alpha · default OFF.** 모든 VM에서 `TOWER_JEV_SESSION_NAVIGATOR_ENABLED=true`를 명시한 경우에만 평가, advisory 주입, message metadata 저장, Composer Action UI를 활성화한다. 환경변수가 없거나 다른 값이면 기능은 꺼진다.

## 책임

이 모듈은 Jev 기반 Session Navigator의 bounded semantic state와 shadow replay 계약을 소유한다. Decision provider 호출, 권한, 승인, 외부 실행은 소유하지 않는다.

## Phase 0 public API

- `TURN_END_CONTINUATION_SHADOW_SPEC` — Assistant 응답 종료 후 한 번 호출하는 `tower.session-navigator.turn-end@1` 최소 shadow `DecisionSpec`
- `turnEndDecisionStateSchema` — 목표·응답 결과·완료 근거·남은 승인 범위·blocker만 담는 bounded state
- `SESSION_NAVIGATOR_CONTINUITY_SHADOW_SPEC` — 컴팩션 경계 또는 `inspect` 결과에서만 사용하는 `tower.session-navigator.continuity@1` 진단 spec
- `sessionSemanticStateSchema` / `parseSessionSemanticState()` — source message anchor가 있는 versioned semantic state
- `sessionNavigatorReplayFixtureSchema` / `parseSessionNavigatorReplayFixtures()` — compaction·drift replay corpus 계약
- `fixtures/phase-0-replays.json` — 공개 저장소에 안전한 synthetic replay 31건
- `buildComposerActions()` — 최신 Assistant 응답에서 최대 4개의 bounded action을 만드는 deterministic Phase 2 seed. 최신 observed shadow 결과는 bounded action 순위에만 사용한다.
- `scheduleTurnEndShadow()` — Pi 응답 terminalization 후 fire-and-forget Jev 평가를 예약한다. provider 지연·실패는 응답 완료를 막지 않는다.
- `getLatestTurnEndShadowRecord()` — 현재 프로세스에서 세션별 최신 shadow 관측을 조회한다. Phase 1 seed이며 아직 durable ledger는 아니다.

## 호출 경계

```text
assistant response end
  -> deterministic stop/approval/revision/budget gates
  -> turn-end continuation (one question)
  -> continue | complete | inspect | revise | replan | stop_for_human
  -> continuity diagnostic only for compaction or inspect
```

응답 생성 중에는 Jev를 반복 호출하지 않는다.

## 안전 경계

- Shadow 결과는 실행이나 승인을 만들지 않는다.
- `jev_auto`는 사람의 `user_answer` 또는 `user_click`로 변환하지 않는다.
- 승인 필요 액션, stale context revision, provider 실패는 자동 실행 근거가 될 수 없다.
- Semantic fact는 원문으로 돌아갈 수 있도록 최소 한 개의 `sourceMessageIds` anchor를 가진다.
- 이 단계에는 Context Assembler, persistence, provider 호출 또는 live Auto Mode가 포함되지 않는다.
- Guide Action Bar는 `/api/sessions/:id/composer-actions`의 deterministic seed를 사용한다.
- 기본 사람용 Guide Action Bar는 `계속 진행`, `내용 정리` 두 행동만 표시한다.
- `계속 진행`의 서버 action message는 표시 문구와 같은 `계속 진행`(영어 `Continue`)이다. 서버 응답이 frontend fallback보다 우선하므로 양쪽 문구를 일치시킨다. `composer-actions.test.ts`에서 서버·frontend 번역 간 일치를 검증한다.
- `내용 정리`는 현재 상태를 다음 세션이나 에이전트가 바로 이어받을 수 있는 handoff 자료로 만들도록 요청한다.
- Jev 결과, confidence, 추천 배지와 Turn-End shadow는 기본 Composer 흐름에 개입하지 않는다.
- 기존 Jev 구현과 Research Alpha opt-in 코드는 후속 연구를 위해 보존하지만 현재 Pi 런타임에서는 평가·advisory 주입을 예약하지 않는다.
- `inspect`는 근거 확인, `revise`는 현재 결과 수정, `replan`은 접근 경로 변경을 뜻한다.
- `stop_for_human`은 Jev 내부 제어 결과다. 향후 auto mode에서는 자동 진행을 멈추고 사용자의 다음 입력을 기다리며, 사람용 버튼으로는 노출하지 않는다.
- accepted 결과는 `JevTurnAdvice`로 변환되어 다음 Pi 턴에 provenance가 표시된 내부 envelope로 전달된다. 최신 사용자 메시지와 도구 승인 정책이 항상 우선한다.
- advisory는 path confidence, 전체 path probabilities, 목표 정합성·대화 연속성·근거 충분성·응답 완결성 score, constraint-loss·unfinished-commitment flags를 보존한다.
- 실제 Jev 추천을 사용하는 경우에만 `AI` 표시와 추천 tooltip을 노출한다.

## 검증

```bash
npx vitest run \
  packages/backend/services/session-navigator/semantic-state.test.ts \
  packages/backend/services/session-navigator/turn-end.test.ts \
  packages/backend/services/session-navigator/session-navigation-spec.test.ts \
  packages/backend/services/session-navigator/replay-fixture.test.ts
```

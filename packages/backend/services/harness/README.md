# Agent Harness runtime contract

## 책임

이 모듈은 Tower Agent 실행 전에 적용할 Harness를 하나의 불변 계약으로 해석한다.

Harness는 Agent identity와 별개이며 다음 실행 요소의 상한을 정의한다.

- Engine과 허용 모델 정책
- Prompt plan
- Tool·MCP capability surface
- Sandbox·network 방식
- Runtime Profile

## Public API

- `resolveHarnessForSession()` — Session 실행에 사용할 Harness 계약을 해석한다.
- `TOWER_DEFAULT_HARNESS` — 기존 Tower/Pi 동작을 그대로 나타내는 호환 Harness다.
- `buildHarnessRuntimeFingerprint()` — 실제 조립된 prompt bundle과 tool surface가 어떤 Harness에서 나온 것인지 추적할 hash를 만든다.
- `validateHarnessEvalPack()` — Harness version에 연결된 행동 회귀 사례가 publish/promotion gate로 쓸 최소 요건을 갖췄는지 검사한다.
- `summarizeHarnessEvalPack()` — Builder와 validation report에 표시할 category·hard-fail coverage를 계산한다.
- `runHarnessEvalPack()` — 모든 사례를 계약 횟수만큼 반복 실행하고 assertion별 증거와 hard-fail을 집계한다.
- `compareHarnessEvalReports()` — 같은 Harness/model/coverage의 old/new Prompt Bundle 분포를 비교한다.
- `executeHarnessEvalRun()` — runtime invoker·독립 grader·DB run store를 연결해 하나의 불변 report를 만든다.
- `recordHarnessEvalPromotionDecision()` — baseline/candidate 비교 결과를 append-only promotion recommendation으로 기록한다.

## 현재 단계

Published Harness는 등록된 capability와 versioned Prompt Component만 참조하며, compiler가 `prompt.bundleHash`를 만든다. Session runtime snapshot은 이 hash를 별도 column에도 고정하고, runtime fingerprint는 prompt bundle과 tool set을 함께 식별한다.

`quick-web-research@1`은 대표 조사, 권한 경계, 모호성, tool 실패, prompt injection을 포함한 고정 behavioral eval pack을 가진다. Eval runner는 실제 Harness runtime invoker를 주입받아 반복 실행하며, capability assertion은 관측 tool surface로 결정론적으로 채점하고 behavioral assertion은 독립 utility model이 strict JSON으로 채점한다. Grader 오류는 fail-closed하며, run report와 differential recommendation은 DB에 보존한다. 실제 운영 실행은 별도 명시 호출이며 코드 배포만으로 모델 평가를 자동 시작하지 않는다.

## 불변 조건

- Helper Agent와 Persistent Worker는 장기적으로 자체 Harness binding을 가진다.
- Engine은 Harness와 Session에 고정하며, 같은 Engine 안에서 모델만 바꿀 수 있다.
- `quickReply()`도 최종적으로 같은 Harness resolver와 capability 상한을 사용한다.
- Channel은 선택된 Agent 자신의 Harness snapshot을 사용하며 capability를 확대하지 않는다.
- Channel 호출자·청중·연결 resource를 resolve하지 못하면 system/admin fallback 없이 fail-closed한다.
- Tower Platform Kernel의 ACL·Credential·workspace·approval·audit guard는 Harness가 제거할 수 없다.

관련 결정:

- `workspace/decisions/2026-07-13-agent-harness-as-versioned-runtime-capability.md`
- `workspace/decisions/2026-07-13-agent-harness-premortem-and-impact-map.md`

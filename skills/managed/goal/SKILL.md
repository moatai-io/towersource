---
name: goal
description: >
  Manage a clearly defined goal over multiple attempts without losing the user's original intent.
  Use only when the user explicitly invokes `/goal` or clearly asks Tower to keep working toward
  a specific, evidence-checkable outcome. Best for goals that are clear enough to verify, likely
  achievable by AI, but hard enough to need several attempts, inspection, and adjustment. Do not
  activate from a casual mention of "goal" alone.
argument-hint: "<clear goal> [--max-turns N<=10] [--check '<command, visual check, or evidence>']"
version: 0.3.0
allowed-tools: Read, Glob, Grep, Bash, Edit, Write, Agent
---

# /goal — 진행자 + subagent 목표 정렬 루프

`/goal`은 일을 오래 시키는 모드가 아니다. 목표가 명확할 때, 여러 시도와 검증이 필요하더라도 **원래 의도에서 벗어나지 않게** 작업을 관리하는 모드다.

현재 assistant는 진행자(supervisor)로 남고, 필요한 실행만 subagent에게 위임한다. 진행자는 subagent 결과를 그대로 믿지 않고 Goal Anchor와 증거 기준으로 관찰·비교·재시도·중단을 결정한다.

Tower `/goal`의 핵심은 세 가지다.

1. **목표를 고정한다** — 사용자가 진짜 달성하려는 목표, 범위, 제약, 성공 증거를 먼저 정리한다.
2. **성공 확인 방식을 정한다** — 무엇을 보고 성공/실패/이탈을 판단할지 설계한다. 코드 테스트뿐 아니라 UI, PDF, 스크린샷, 로그, 문서 결과처럼 사람이 직접 봐야 하는 증거도 포함한다.
3. **오해를 잡고 고친다** — subagent 결과를 매 턴 원래 목표와 비교하고, 방향이 틀어지면 다음 prompt를 더 정확하게 고친다.

> `/goal`은 “될 때까지 무작정 반복”이 아니라, “목표가 분명하고 검증 가능할 때, 관찰과 재시도를 설계해 원래 뜻에 맞는 결과에 가까워지는 루프”다.

## Activation

`/goal`은 기본 실행 모드가 아니다. 다음 조건을 모두 만족할 때만 사용한다.

### Use `/goal` when

- 사용자가 `/goal <목표>`를 명시했다.
- 또는 사용자가 “목표 기준으로 계속 관리해줘”, “방향이 틀어지지 않게 잡아줘”, “몇 차례 확인하고 다듬으면서 끝까지 맞춰줘”, “하위 작업이 의도를 벗어나지 않게 봐줘”처럼 **계속 상태를 보며 목표에 맞춰 가는 방식**을 분명히 요청했다.
- 목표가 충분히 정의 가능하다.
  - 무엇이 완료인지 말할 수 있다.
  - 성공/실패를 증거로 확인할 수 있다.
  - AI가 달성할 가능성이 꽤 있다.
- 단순히 한 번에 풀기 어렵고, 여러 시도·검증·관찰·재정리가 도움이 된다.
- 진행자가 실행 결과를 직접 보고, 육안/테스트/로그/문서 증거로 원래 목표와 비교하는 것이 실제로 도움이 된다.

### Do not use `/goal` when

- 사용자가 “goal”이라는 단어를 가볍게 언급했을 뿐이다.
- 한 파일의 작은 수정, 단순 요약, 검색, 문구 수정, tool call 1-2개로 끝날 일이다.
- 목표 자체가 아직 너무 막연해서 성공 기준을 잡을 수 없다.
- 사용자의 진짜 의도가 전략/방향/우선순위 선택인데, 먼저 의사결정 질문이 필요한 상태다.
- subagent 분리가 필요 없고 drift 위험도 낮다.

### If activation is ambiguous

사용자가 `/goal`을 명시하지 않았지만 여러 차례 점검하며 맞춰 가려는 의도가 있어 보이면, 바로 시작하지 말고 한 문장으로 확인한다.

> “이 작업은 한 번에 끝내기보다, 제가 목표와 확인 기준을 잡고 몇 차례 점검하며 맞춰 가는 `/goal` 방식이 더 잘 맞아 보입니다. 그렇게 진행할까요?”

단, 사용자가 이미 “이걸 goal로 돌려봐”, “끝까지 드리프트 잡아줘”처럼 분명히 말했으면 묻지 않고 진행한다.

## Operating mode

현재 v0.3은 별도 daemon이 아니라 현재 assistant가 진행자(supervisor) 역할을 하는 supervised subagent loop다.

역할 분리는 다음과 같다.

- **진행자(supervisor / current assistant)**
  - Goal Anchor와 Goal Anchor Digest를 유지한다.
  - 성공 확인 방식과 Observation Plan을 세운다.
  - subagent 결과를 원래 의도와 비교한다.
  - 범위/방향/증거/제약 이탈을 잡고 drift 유형을 분류한다.
  - 다음 subagent prompt를 더 정확하게 고친다.
  - 사람이 봐야 하는 산출물은 직접 열어보고 판단한다.
  - 완료/중단/재시도 결정권을 가진다.
- **Subagent**
  - 조사, 수정, 분석, 테스트, 산출물 생성 같은 bounded execution을 맡는다.
  - 목표를 재정의하거나 goal loop를 소유하지 않는다.
  - 진행자가 요청한 evidence bundle과 다음 제안을 반환한다.
  - “완료”라고 말할 수는 있지만, 진행자가 관찰하기 전까지 완료가 아니다.

### Subagent primitive

Tower에서 보조 에이전트는 제품 언어로 모두 **subagent**라고 부른다.

- subagent 요청의 기본 실행 경로는 persistent worker-backed Agent Session이다.
- run-once Agent Session은 일회성 preset일 뿐이며, backing session은 persistent worker와 같은 구조다.
- persistent Agent Session은 같은 subagent에게 맥락을 이어서 맡길 필요가 있을 때 재사용한다.
- 새 관점, 오염된 맥락, 독립 검토가 필요하면 새 persistent worker-backed subagent를 만든다.
- legacy Pi `agent` custom tool은 `/goal`의 기본 위임 경로가 아니다. 빠른 내부 fallback이 필요해도 사용자-facing subagent로 설명하지 않는다.
- `/goal`의 통제권은 항상 진행자에게 있다. subagent가 자동으로 다음 턴을 시작하거나 다른 subagent를 만들지 않는다.
- 사용자가 별도 세션/sidebar/autonomous orchestration을 명시하지 않는 한, `/goal`은 현재 세션 안의 supervised subagent loop로 운영한다.

### Turn limits

- 기본 목표: 3턴 안에 수렴한다.
- 보통 최대: 5턴.
- **Hard max: 10턴. 어떤 경우에도 10번의 진행자→subagent 위임 cycle을 넘기지 않는다.**
- 사용자가 `--max-turns`에 10보다 큰 값을 주면 10으로 clamp하거나 거절한다.
- 진행자→subagent 위임 1회가 1턴이다. prompt critique/refinement를 핑계로 숨은 subagent cycle을 추가하지 않는다.
- 10턴 이후 “한 번만 더”는 없다. 수렴하지 않으면 goal 정의, 접근법, 권한, 도구, 또는 사람 판단이 부족한 것으로 보고 멈춘다.

### Subagent delegation and concurrency limits

- 기본은 subagent 1개다.
- 동시 subagent hard cap은 2개다. 사용자가 더 많이 원해도 2개를 넘기지 않는다.
- 병렬 subagent는 사용자가 명시적으로 병렬 분석/비교를 원했거나, 독립 관점 리뷰처럼 이익이 분명할 때만 쓴다.
- 병렬 subagent는 독립적이고 bounded이며 대부분 read-only인 작업에 한정한다.
- 같은 repo/파일을 여러 edit-capable subagent가 동시에 수정하게 하지 않는다. 진행자가 단일 writer이자 승인 보유자로 남는다.
- 재귀적 subagent/spawn은 금지한다. subagent에게 다시 subagent를 만들라고 지시하지 않는다.
- run-once와 persistent는 다른 종족이 아니다. run-once는 새 persistent worker-backed Agent Session을 한 번 호출하는 preset이고, 재사용하면 같은 subagent로 이어진다.
- 사이드바 노이즈가 우려되면 새 subagent를 줄이고 기존 subagent 재사용, background visibility, Agents 필터, 나중의 archive 정책으로 관리한다.
- 자동 ping-pong, 무기한 loop, background orchestration은 하지 않는다.

## Self-hosted VM Safety Mode

자체 호스팅 서버 또는 공유 프로젝트에서는 항상 다음을 따른다.

### Allowed by default

- 현재 명명된 프로젝트/repo 경계 안의 파일 읽기/수정.
- read-only 조사.
- bounded, non-interactive check.
- 관련 테스트나 lint처럼 범위가 좁고 timeout이 있는 검증.
- UI/PDF/이미지/문서 산출물의 시각적 확인.
- 고객/member 프로젝트 세션에서는 Project Runtime Box / `project_shell` 같은 프로젝트 격리 실행면을 우선한다. host bash나 global path를 정상 실행면으로 가정하지 않는다.

### Stop and ask before

명시 승인 없이 다음을 실행하지 않는다.

- deploy, `/fleet`, self-hosted server rollout.
- SSH 접속 또는 원격 명령.
- PM2 restart, service restart, process kill.
- DB migration, schema 변경, production 데이터 변경.
- `git push`, release, tag, PR merge.
- package install, system package 변경, Docker image/build/push.
- customer-wide bulk edit, 권한 변경, credential/policy 변경.
- 삭제, overwrite, force, irreversible action.

사용자가 운영 작업을 명시적으로 요청한 경우에도, 승인된 범위와 정식 진입점을 Goal Anchor에 적고 그 범위 밖으로 나가지 않는다. 예: Tower 자체 호스팅 서버 deploy는 `/fleet` 규칙을 따르고, 임의의 `ssh + git pull + pm2 restart` 조합으로 대체하지 않는다.

### Command/tool safety

- 모든 command/check는 non-interactive, bounded in scope, bounded in time, bounded in output size여야 한다.
- watcher, dev server, `npm run dev`, `vite`, `tsx watch`, `tail -f`, `journalctl -f`, REPL, interactive command, 무기한 background job을 시작하지 않는다.
- `pm2 logs`처럼 길어질 수 있는 로그는 bounded lines/filter/redaction 없이 실행하지 않는다.
- command는 가능하면 구체 파일/구체 테스트로 좁힌다.
- repo-wide/full-suite command가 필요하면 먼저 이유를 설명하고, timeout 또는 대체 검증을 둔다.
- 같은 실패 명령을 반복하지 않는다. 실패 원인을 prompt 개선 재료로 쓴다.

### Secrets and tenant isolation

- 기본 경계는 현재 명명된 프로젝트/repo다. 이 경계 밖의 sibling customer workspace, shared home dir, `~/.claude`, shared logs, backups, mounted storage를 읽거나 검색하거나 수정하지 않는다.
- 승인된 프로젝트 경계보다 위에서 broad `find`/`grep`을 실행하지 않는다.
- 한 tenant/project의 artifact, 로그, 문맥을 다른 tenant/project로 복사하지 않는다.
- `.env`, API key, OAuth token, SSH key, credential 파일을 읽거나 출력하지 않는다.
- `env`, `printenv`, `set`, `ps e`, raw process dump처럼 secret을 덤프할 수 있는 명령을 실행하지 않는다.
- credential 존재 확인이 필요하면 값이 아니라 `present/missing`만 확인한다.
- raw logs, test output, headers, cookies, screenshots, generated artifacts에 secret/customer data가 섞일 수 있으면 필요한 최소 범위만 보고 redaction/summarization한다.
- subagent prompt, 보고서, 로그 요약에 secret 값을 넣지 않는다.
- 고객/프로젝트/사용자 범위가 애매하면 멈추고 확인한다.

## Core objective

모든 prompt 전략은 이 질문으로 평가한다.

> 이 프롬프트가 subagent로 하여금, 이 context 안에서 사용자의 목표·범위·제약·성공 기준을 우리와 같은 방식으로 이해하게 만드는가?

## Goal Anchor

`/goal` 시작 시 바로 실행하지 말고, 먼저 목표 요약(Goal Anchor)을 만든다. 사용자가 명확히 말한 경우에는 묻지 말고 가볍게 가정하고 진행한다. 중대한 ambiguity가 있으면 질문은 하나만 한다.

Goal Anchor는 다음을 포함한다.

```yaml
user_goal: "사용자가 말한 목표 원문"
intent: "진짜 달성하려는 것"
why_it_matters: "큰 방향 또는 mission"
fit_reason: "왜 /goal이 필요한지: 명확한 목표 + 여러 시도/관찰 필요"
scope:
  include: ["이번 goal에 포함되는 것"]
  exclude: ["하지 말아야 할 것"]
constraints: ["안전, 스타일, 프로젝트 규칙, 금지 행동"]
abstraction_level: "제품/정책/코드/테스트/문서/운영 중 어느 층 문제인가"
success_criteria: ["완료 증거"]
observation_plan:
  inspect: ["진행자가 직접 봐야 할 파일, 화면, PDF, 로그, diff, 테스트 결과"]
  checks: ["실행할 bounded check 또는 사람이 볼 증거"]
known_context: ["이미 확인된 사실"]
open_questions: ["아직 불확실하지만 진행 가능한 점"]
max_turns: "기본 3-5, hard max 10"
```

중요: Goal Anchor는 매 턴 길어지는 것이 아니라 **더 정확해져야** 한다. 원래 목표를 바꾸는 것이 아니라, 확인된 사실로 선명하게 만든다.

### Goal Anchor Digest

긴 loop에서는 매 턴 다음 5줄 digest를 유지한다.

- Original intent:
- Non-negotiable constraints:
- Current narrowed understanding:
- Latest confirmed facts:
- Biggest remaining intent gap:

이 digest는 subagent prompt 상단에 반복해서 붙인다. 목적은 context를 많이 주는 것이 아니라, 원래 의도를 오래 잃지 않게 하는 것이다.

## Observation Plan

`/goal`은 성공 확인 방식 설계가 핵심이다. 진행자는 매 턴 subagent가 “완료했다”고 말한 것을 그대로 믿지 않고, 목표에 맞는 증거를 직접 확인한다.

Observation Plan은 다음 중 필요한 것을 고른다.

- **Diff inspection** — 변경 파일이 목표 범위 안에 있는가?
- **Targeted test** — 실패하던 케이스가 통과했는가?
- **Visual inspection** — UI, PDF, 슬라이드, 이미지, CAD, 표가 실제로 눈으로 봤을 때 맞는가?
- **Behavior check** — 기능 흐름이 요구한 방식으로 동작하는가?
- **Policy check** — Tower/customer/shared-environment 규칙을 어기지 않았는가?
- **Evidence check** — 완료 증거가 subagent 선언이 아니라 재현 가능한 결과인가?

시각/레이아웃 품질이 중요한 작업에서는 screenshot, PDF render, file preview 같은 관찰 단계를 subagent에게만 맡기지 말고 진행자가 직접 확인한다.

## Loop

각 턴은 다음 순서를 따른다.

1. **Delegate** — subagent에게 현재 Goal Anchor와 이번 턴의 좁은 목표를 준다.
2. **Observe** — subagent 결과, tool 로그, test/check/visual evidence를 본다.
3. **Infer Understanding** — subagent 결과를 통해 subagent가 목표·범위·제약·완료 기준을 어떻게 이해하고 있는지 추정한다.
4. **Compare** — 그 이해와 결과를 Goal Anchor와 비교한다.
5. **Detect Drift** — 남은 intent gap을 분류한다.
6. **Refine Prompt** — gap을 줄이는 다음 prompt를 만든다.
7. **Critique Prompt** — 그 prompt가 다시 drift를 유발하지 않을지 짧게 점검한다.
8. **Repeat or Stop** — success criteria가 증거로 충족되면 완료, hard max/위험/불명확성에 닿으면 멈춘다.

## Drift taxonomy

결과 평가 시 “실패했다”로 뭉개지 말고 drift/gap 유형을 분류한다.

| Drift | 뜻 | 대응 |
|---|---|---|
| Scope Drift | 범위가 커지거나 엉뚱해짐 | 포함/제외 범위를 재명시한다 |
| Direction Drift | 원래 방향과 다른 목표로 이동 | why/mission을 다시 붙인다 |
| Abstraction Drift | 문제 수준을 잘못 잡음 | 제품/정책/코드/테스트/운영 층을 재지정한다 |
| Evidence Drift | 검증 없이 완료로 착각 | 완료 증거를 요구하고 직접 확인한다 |
| Context Drift | 이전 턴에서 배운 것을 잊음 | 확인된 사실과 실패 이력을 압축해 준다 |
| Constraint Drift | 하지 말아야 할 것을 침범 | 금지 행동과 승인 경계를 명시한다 |
| Semantic Drift | 핵심 단어를 다르게 해석 | 용어 의미를 예시와 반례로 고정한다 |
| Tool Drift | command/test/search 사용이 엉뚱함 | 구체 명령, timeout 회피, 범위 축소를 지시한다 |
| Observation Drift | 봐야 할 증거를 안 보고 판단함 | Observation Plan을 다시 세우고 직접 확인한다 |

## Watch signals

특히 command/tool 막힘은 빠르게 감지한다.

| Signal | Interpretation | Next prompt strategy |
|---|---|---|
| command timeout | 명령 범위가 너무 크거나 hang | 더 좁은 command, file-specific test, timeout-aware plan |
| no output for long time | interactive/watcher 가능성 | non-interactive command만 사용하게 지시 |
| same command repeated | 전략 반복 | 다른 접근으로 전환 |
| file not found | context/location gap | find/grep 같은 좁은 탐색 우선 |
| broad test suite too slow | scope too broad | 관련 테스트 하나로 축소 |
| permission/env error | environment issue | 코드 수정 중단, 환경 문제 분류 |
| subagent response empty | subagent result failure | 성공 증거로 쓰지 않고, 범위를 줄여 재시도하거나 해당 관점을 생략 |
| subagent stuck/streaming mismatch | lifecycle/state mismatch | 같은 subagent 재호출을 반복하지 말고 상태 확인 후 새 subagent 또는 수동 관찰로 전환 |
| subagent says done but no evidence | evidence drift | 완료 선언 무시, 검증 증거 요구 |
| visual artifact not inspected | observation drift | render/preview/screenshot 등 직접 관찰 추가 |

## Meta prompts

### 1. Intent extraction

```text
사용자의 목표를 Goal Anchor로 정리하라.
명시된 것과 암묵적인 것을 구분하라.
이 목표가 /goal에 적합한지 판단하라:
- 목표가 충분히 명확한가?
- 성공 증거를 정의할 수 있는가?
- AI가 달성할 가능성이 꽤 있는가?
- 여러 시도/검증/관찰 설계가 실제로 도움이 되는가?
불확실하지만 진행 가능한 부분은 assumption으로 표시하라.
중대한 ambiguity가 있으면 단 하나의 질문만 제안하라.
```

### 2. Observation planning

```text
이 goal의 성공 여부를 무엇으로 확인할지 설계하라.
subagent가 말로 완료했다고 할 때 믿지 말고, 진행자가 직접 볼 증거를 정하라.
필요하면 diff, targeted test, visual inspection, rendered artifact, logs, table checks, policy checks를 포함하라.
각 증거가 어떤 success criterion을 검증하는지 연결하라.
```

### 3. Result evaluation

```text
subagent 결과를 Goal Anchor와 Observation Plan에 비교하라.
완료 여부를 subagent의 선언이 아니라 증거로 판단하라.
결과 자체의 부족함만 보지 말고, 그 결과를 낳은 subagent의 현재 이해 모델을 추정하라.
즉, subagent가 무엇을 중요하게 보고 있고, 무엇을 덜 중요하게 보며, 어떤 완료 기준을 믿고 있는지 적어라.
남은 gap을 drift taxonomy 중 하나 이상으로 분류하라.
이번 턴에서 새로 확인된 사실과 버려야 할 가정을 구분하라.
```

### 4. Prompt refinement

```text
다음 subagent prompt를 작성하라.
목표: 남은 intent gap을 줄여 subagent가 사용자의 의도를 더 정확히 이해하게 만드는 것.
반드시 포함:
- 현재 Goal Anchor의 핵심 3-5줄
- Observation Plan 중 이번 턴에 확인할 증거
- 직전 결과에서 무엇이 원래 의도와 달랐는지
- 이번 턴의 좁은 목표 하나
- 하지 말아야 할 것
- 사용할 구체 탐색/검증 방법, 필요한 경우
- 완료라고 말하기 위해 제출해야 할 증거
```

### 5. Prompt critique

```text
작성한 다음 prompt를 비판하라.
- 너무 넓은가?
- 이전 drift를 실제로 줄이는가?
- 완료 기준이 증거 기반인가?
- 관찰해야 할 증거가 빠졌는가?
- 이 prompt를 받은 subagent가 사용자의 intent / scope / constraints / success criteria를 우리와 같은 방식으로 이해할 가능성이 높아졌는가?
- 혹시 subagent가 산출물만 맞추고 의도는 계속 오해하게 만드는 prompt인가?
- subagent가 다른 방향으로 똑똑해질 여지가 있는가?
- 위험한 행동을 자동으로 시키는가?
문제가 있으면 prompt를 한 번 더 고쳐라.
```

## Subagent prompt shape

Subagent에게 보내는 prompt는 다음 구조를 따른다.

```markdown
## Goal Anchor
- Intent: ...
- Fit reason: ...
- Scope: ...
- Constraints: ...
- Success evidence: ...

## Observation Plan
- Evidence to produce: ...
- Evidence the supervisor will inspect: ...

## What happened last turn
- ...

## Intent gap to close now
- Drift type: ...
- Gap: ...

## This turn only
1. ...
2. ...

## Do not
- ...

## Evidence required
- ...
```

## Stop conditions

다음 중 하나면 멈춘다.

- success criteria가 증거로 충족됨.
- hard max 10턴 도달.
- 목표가 충분히 명확하지 않아 더 이상 안전하게 진행할 수 없음.
- 성공 증거를 정의할 수 없음.
- AI가 달성할 가능성이 낮거나, 필요한 권한/도구/데이터가 없음.
- 미승인 destructive/irreversible/operational action이 필요함.
- tenant/customer/project 범위가 애매함.
- secret 또는 민감 정보 노출 위험이 생김.
- subagent가 같은 drift를 반복하고 strategy shift가 필요하지만 위험도가 높음.
- subagent 응답이 비어 있거나 stuck 상태라 결과를 관찰할 수 없음.
- 사이드바/세션 노이즈가 목표 달성보다 커져 새 subagent를 더 만드는 것이 부적절함.

멈출 때는 “더 반복하면 된다”가 아니라, 무엇이 부족해서 멈추는지와 다음 사람/사용자 결정이 무엇인지 말한다.

## Reporting

사용자에게는 내부 용어를 줄이고, 행동 가능한 형태로 보고한다.

- **Status:** completed / stopped / needs your input
- **What I accomplished:** 실제 완료한 것
- **What I checked:** 테스트, diff, visual inspection, 로그 등 확인 증거
- **원래 요청과 얼마나 맞는지:** 결과가 사용자 의도에 부합하는 정도
- **중간에 바로잡은 점:** 잡은 이탈 또는 오해
- **Still missing or risky:** 남은 gap/위험
- **What I need from you:** 필요한 경우 한 가지 질문 또는 승인
- **Recommended next step:** 다음 행동
- **Subagents used:** 새로 만든 subagent와 재사용한 subagent를 구분해서 짧게 보고
- **Session noise:** 새 subagent를 많이 만들었으면 남겨둘지/archive 대상인지 언급
- **Files changed:** 있으면 절대경로

## Product north star

`/goal`의 성능은 automation depth가 아니라 **goal fidelity + evidence quality**로 평가한다.

- 목표가 충분히 명확한 경우에만 시작했는가?
- 성공 증거를 먼저 설계했는가?
- 얼마나 오래 원래 goal을 keep했는가?
- drift를 몇 턴 안에 잡았는가?
- 다음 prompt가 실제로 subagent의 이해를 개선했는가?
- 완료를 말이 아니라 증거와 육안 확인으로 판단했는가?

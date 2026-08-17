---
name: deep-thinking
description: |
  Synthesizes multiple deep reasoning passes into one integrated answer for high-stakes questions. Use when the user says "/deep-thinking", "딥 씽킹", "깊게 생각", "deep thinking", or asks for unusually careful strategy, architecture, research, product, or code-review reasoning. NOT for simple factual questions, quick edits, routine coding, design divergence only (→ design-explore), or long execution loops (→ goal).
version: 0.1.0
tags: [core, agent]
argument-hint: "<question/problem> [--budget light|standard|max] [--mode self|council|persistent] [--save]"
---

# /deep-thinking — 통합 숙고 모드

`/deep-thinking`은 여러 답변을 나란히 보여주는 패널 토론 스킬이 아니다. 고난도 질문에서 서로 다른 추론 경로를 내부 재료로 사용한 뒤, 최종 답은 **한 사람이 깊게 숙고해 정돈한 것처럼** 제공하는 스킬이다.

핵심 원칙:

1. **반복이 아니라 소화** — thinker들의 문장을 베끼지 않는다. 합의·충돌·빈틈을 흡수해서 하나의 답으로 재구성한다.
2. **다수결이 아니라 판단** — 여러 답이 같은 말을 해도 근거가 약하면 채택하지 않는다. 하나만 말했어도 근거가 강하면 채택한다.
3. **깊을 때만 사용** — 비용·latency가 크므로 단순 사실 확인, 작은 수정, 일반 코딩에는 쓰지 않는다.
4. **검증 가능한 것은 검증** — 코드, 숫자, 문서, 웹 근거가 필요한 주장은 현재 환경이 허용한 도구로 확인한다.
5. **내부 council 흔적 최소화** — 사용자가 원하지 않으면 “A 모델은…, B 모델은…” 식으로 보고하지 않는다.

## Use when

명시 호출이 가장 안전하다.

- `/deep-thinking <질문>`
- “딥 씽킹으로 봐줘”
- “깊게 생각해서 결론 내줘”
- “반대 관점까지 충분히 검토해서 하나로 정리해줘”
- “이건 중요한 아키텍처/전략/제품 판단이야”

명시 호출이 없어도 아래 조건을 모두 만족하면 짧게 제안할 수 있다.

- 결정 비용이 크다.
- 한 번의 답변보다 여러 관점 검토가 실제 품질을 높인다.
- 사용자가 속도보다 품질을 우선하는 신호를 줬다.

제안 문구:

> “이건 단답보다 깊은 검토가 더 맞아 보입니다. `/deep-thinking`으로 solver·skeptic·judge 방식으로 정리할까요?”

## Do not use when

- 1–2문장으로 충분한 사실 질문.
- 파일 한두 곳의 명확한 수정.
- 일반적인 코드 구현/테스트 실행.
- 여러 설계안을 일부러 갈라서 보고 싶은 경우 → `design-explore`.
- 여러 차례 실행·관찰·재시도가 목표인 경우 → `goal`.
- 과거 대화나 세션을 찾는 것이 핵심인 경우 → `search`.
- 사용자가 빠른 답을 원한다고 명시한 경우.

## Input parsing

`$ARGUMENTS`를 다음처럼 해석한다.

| Argument | Meaning | Default |
|---|---|---|
| positional text | 깊게 검토할 질문/문제 | required |
| `--budget light` | subagent 없이 현재 assistant가 역할 분리 self-pass | quick |
| `--budget standard` | solver + skeptic + host judge | default |
| `--budget max` | solver + skeptic + verifier/specialist까지 가능 | explicit only |
| `--mode self` | 현재 assistant 내부에서만 수행 | fallback |
| `--mode council` | bounded subagent council 사용 | default for standard/max |
| `--mode persistent` | 같은 주제의 persistent worker를 재사용/이어가기 | when user wants continuity |
| `--save` | 현재 프로젝트의 적절한 docs/research 경로에 결과 저장 | off |

질문이 없으면 바로 실행하지 말고 한 문장으로 요청한다.

> “딥 씽킹으로 검토할 질문이나 결정 주제를 한 문장으로 주세요.”

## Operating modes

### Mode A — Self deepening (`--budget light` or no worker available)

현재 assistant가 세 번의 분리된 사고 모드를 순차 실행한다.

1. **Solver pass** — 가장 강한 결론과 해법을 만든다.
2. **Skeptic pass** — 전제, 반례, 실패 조건, 빠진 정보를 찾는다.
3. **Judge pass** — 채택/기각/보류를 결정하고 최종 답을 쓴다.

각 pass 사이에 명시적으로 관점을 전환한다.

```text
--- MODE SHIFT ---
이전 관점을 방어하지 않는다. 지금은 다른 검토자다. 이전 답의 약점과 빈틈을 찾는다.
```

### Mode B — Council (`--budget standard`, default)

가능하면 2개의 bounded persistent worker-backed subagent를 사용한다. 현재 assistant는 supervisor이자 final synthesizer로 남는다.

- **Deep Solver**
  - 목표: 가장 강한 해결책/결론을 구성.
  - 금지: 균형 잡힌 척하며 흐리지 않기.
  - 출력: 결론, 핵심 논거, 실행안, 취약점.
- **Deep Skeptic**
  - 목표: Solver가 틀릴 가능성, 숨어 있는 전제, 반례, 더 싼 대안, 실패 조건 찾기.
  - 금지: 단순 반대를 위한 반대.
  - 출력: 위험한 전제, 반례, 검증 질문, 수정 제안.
- **Host Judge/Synthesizer**
  - 목표: 두 결과를 통합해 하나의 답을 작성.
  - 금지: agent별 요약 나열, 다수결, 문장 복붙.

동시 worker 수는 기본 2개, hard cap 3개다. `--budget max`나 사용자 명시 요청 없이 3개를 넘기지 않는다.

### Mode C — Persistent thread (`--mode persistent`)

사용자가 “이 주제로 계속 깊게 이어가자”, “장기 critic/architect를 붙여두자”처럼 말하면 같은 worker를 재사용한다.

운영 규칙:

1. 기존 worker 목록에서 같은 주제의 solver/skeptic/researcher가 있는지 확인한다.
2. 있으면 새로 만들지 말고 후속 메시지를 보낸다.
3. 없으면 주제명이 들어간 worker 1–2개를 만든다.
4. worker는 장기 기억을 갖지만 최종 판단권은 항상 host assistant에게 있다.
5. 오래된 worker의 전제가 현재 문제와 맞지 않으면 재사용하지 않는다.

## Worker briefing contract

Subagent나 persistent worker를 만들 때 prompt에는 아래를 모두 포함한다.

```markdown
You are one role inside a Deep Thinking run. You are NOT the final answerer.
The supervisor will synthesize your report with other perspectives.

Problem:
[사용자 질문]

Context brief:
[목표, 제약, 알려진 사실, 필요한 출력]

Your role:
[Deep Solver | Deep Skeptic | Verifier/Specialist]

Rules:
- Do not write a polished final answer for the user.
- Do not copy generic advice.
- Be concrete about assumptions and evidence.
- Keep internal chain-of-thought private; report only conclusions, reasons, checks, and uncertainties.
- If you need verification that you cannot perform, state the exact check.
- Return a compact report. Prefer bullets over long prose.

Output format:
## Position
[one-paragraph thesis]

## Strongest reasons
- ...

## Weak spots / risks
- ...

## What would change your mind
- ...

## Recommended final synthesis ingredients
- [what the supervisor should include]
```

## Synthesis protocol

최종 synthesis는 별도 단계로 수행한다. 아래 순서를 지킨다.

### 1. Build a decision ledger

내부적으로 다음 표를 만든다. 사용자가 원하지 않으면 그대로 노출하지 않는다.

| Item | Solver | Skeptic | Judge decision |
|---|---|---|---|
| 핵심 결론 | 주장 | 반론 | 채택/수정/기각 |
| 주요 근거 | 근거 | 취약점 | 채택/보류 |
| 실행안 | 제안 | 리스크 | 수정안 |
| 불확실성 | 누락 | 검증법 | 최종 caveat |

### 2. Resolve conflicts by evidence quality

우선순위:

1. 실제 파일, 테스트, 계산, 출처로 검증된 사실.
2. 프로젝트/사용자 제약과 일치하는 판단.
3. 실패 비용을 줄이는 판단.
4. 설명력은 좋지만 검증 안 된 가설.
5. 모델의 자신감만 높은 주장.

### 3. Write as one mind

최종 답은 다음처럼 쓴다.

- “두 agent가 이렇게 말했다”가 아니라 “정리하면…”으로 시작한다.
- 관점별 중복 문장을 제거한다.
- 결론을 먼저 말한다.
- 반대 관점은 별도 “리스크/반론”으로 녹인다.
- 불확실성은 숨기지 않되, 답 전체를 흐리지 않는다.
- 사용자가 원하지 않으면 내부 worker 이름을 언급하지 않는다.

### 4. Final output shape

기본 출력:

```markdown
결론: [가장 짧은 답]

핵심 판단:
1. [근거]
2. [근거]
3. [근거]

주의할 점 / 반대 관점:
- [리스크 또는 반론]

그래서 다음 액션은:
- [실행 가능한 다음 단계]
```

복잡한 의사결정이면 추가한다.

```markdown
확신도: 높음/중간/낮음
확신도를 낮추는 변수: [...]
검증하면 좋은 것: [...]
```

## Evidence and tool use

- 코드/파일 문제: 관련 파일을 직접 읽고, 가능한 bounded test를 실행한다.
- 숫자/재무/계산 문제: 계산을 재현한다.
- 웹/최신 정보 문제: 필요한 경우 검색·출처 확인을 한다.
- 제품/전략 문제: 검증 불가능한 가정과 실행 가능한 실험을 구분한다.
- 위험한 작업, 배포, 삭제, 외부 전송은 이 스킬의 목적이 아니다. 필요한 경우 별도 승인과 해당 전용 스킬/운영 절차로 넘긴다.

## Save option

`--save`가 있으면 현재 환경의 프로젝트 산출물 규칙에 맞는 경로에 markdown을 저장한다. 권장 위치:

```text
workspace/projects/<project>/research/deep-thinking/YYYY-MM-DD-<slug>.md
```

저장 문서는 아래 구조를 쓴다.

```markdown
# Deep Thinking: <topic>

## Question

## Final synthesis

## Key reasons

## Risks and open questions

## Verification notes

## Follow-up prompts
```

저장 후 사용자에게 파일 절대경로를 한 줄로 안내한다.

## Quality checks before final answer

응답 전 다음을 확인한다.

- [ ] 최종 답이 agent별 요약이 아니라 하나의 통합 답인가?
- [ ] 같은 말을 두 번 반복하지 않았는가?
- [ ] 반대 관점이 실제로 결론을 개선했는가?
- [ ] 검증 가능한 주장을 검증했거나, 미검증이라고 표시했는가?
- [ ] deep thinking을 쓴 비용만큼 답이 더 좋아졌는가?
- [ ] 단순 문제에 과한 절차를 적용하지 않았는가?

## Failure modes

| Failure | Symptom | Fix |
|---|---|---|
| Panel summary | “Solver는…, Skeptic은…” 나열 | decision ledger로 흡수 후 다시 작성 |
| Echo chamber | 두 worker가 같은 말을 반복 | 역할 prompt를 더 극단적으로 분리 |
| Overthinking | 쉬운 질문에 긴 답 | 중단하고 일반 답변으로 전환 |
| False confidence | 근거 없이 확신도 높음 | 검증 필요 항목과 확신도 하향 |
| Persistent drift | 장기 worker가 오래된 전제를 고집 | 새 brief로 리셋하거나 worker 재생성 |
| Latency blow-up | worker/round가 계속 늘어남 | 기본 2 workers, 최대 2 rounds로 제한 |

## Relationship to other skills

- `design-explore`: 여러 설계안을 일부러 갈라서 비교할 때 사용한다. `/deep-thinking`은 비교 후 하나의 판단으로 합성할 때 사용한다.
- `goal`: 목표를 여러 차례 실행·관찰·수정하며 달성할 때 사용한다. `/deep-thinking`은 판단 품질을 높이는 숙고 모드다.
- `plan-refine`: 이미 작성된 계획 문서를 구조적으로 리뷰할 때 사용한다. `/deep-thinking`은 문서가 없어도 고난도 질문 자체를 다룬다.
- `search`: 과거 대화/세션을 찾는 것이 핵심이면 먼저 사용한다.

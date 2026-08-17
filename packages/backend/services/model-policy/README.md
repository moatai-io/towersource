# Model Policy

## 책임

Tower의 논리 workload policy를 실제 모델과 reasoning effort로 해석한다. Agent와 Harness는 가능한 한 물리 모델명 대신 policy id를 참조한다.

## Public API

- `resolveModelPolicy()` — policy id를 immutable 실행 설정으로 해석한다.
- `resolveAgentExecutionPolicy()` — Agent definition의 명시값과 policy를 합성한다.
- `MODEL_POLICY_IDS` — 지원되는 정책 id.

## 알아야 할 것

- `medium`은 기존 Tower 기본 동작을 보존한다.
- `extra-high`는 현재 Pi SDK의 `xhigh`에 대응한다.
- `max`는 현재 Pi SDK가 `xhigh`까지만 지원하므로 명시적으로 `xhigh`로 제한하고 downgrade 정보를 남긴다.
- `ultra`는 향후 multi-agent orchestration용 예약 정책이며 지금은 실행할 수 없다.
- 정책 변경은 `models.json`의 `modelPolicies` revision을 올려 추적한다.

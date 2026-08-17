# Decisions

- 정상 `prompt()` resolve만으로 완료를 확정하지 않는다. 마지막 assistant가 tool-only이면 finalization이 필요한 incomplete turn이다.
- Pi SDK의 `auto_retry_*` lifecycle이 관측되면 해당 run의 retry 소유권은 Pi에 있고 Tower retry는 실행하지 않는다.
- 레거시 incomplete-tool-boundary native continuation은 명시적 환경변수 opt-in에서만 허용한다.
- assistant tool-only leaf는 Pi native continuation이 구조적으로 맞지 않고 자동 finalization prompt도 도구 부작용을 반복할 수 있으므로, 실행하지 않고 incomplete로 분류한다.
- assistant tool-only leaf가 남아 있으면 `completed`를 거부하고 `retryable_failure`로 남긴다.
- SDK private 필드는 이 모듈 경계에서 읽되 transcript 내용은 노출하지 않는다.
- continuation 실행에 필요한 Pi private lifecycle 접근은 `native-continuation-adapter.ts`만 소유한다.
- post-compact·transient·incomplete continuation의 claim과 failure settlement는 `recovery-coordinator.ts`에서 한 번만 정의한다.
- `recovery-policy.ts`는 leaf 상태를 공통 primitive(`native_continue` / `recovery_prompt` / `needs_attention`)로만 분류한다. trigger별 허용 범위는 `pi-engine.ts`가 좁게 적용한다.
- 모든 자동 continuation trigger는 실행 전에 leaf 기반 primitive 선택을 거친다.
- transient assistant leaf는 같은 root turn의 recovery prompt로 재개하되, post-compact assistant leaf와 incomplete assistant tool-only leaf는 부작용 반복 위험 때문에 fail-closed한다.
- restart recovery의 native continue/recovery prompt 선택은 `recovery-policy.ts`가 소유하고, 실행 뒤 claim settlement는 같은 coordinator의 `settlePiRecoveryOutcome`을 사용한다.
- 자동 transient recovery의 중간 안내는 assistant transcript에 저장하지 않는다. 복구가 최종 소진되거나 사용자가 중단한 terminal 결과만 별도 안내 row로 남긴다.
- 관측값은 leaf role, idle, queued 여부처럼 낮은 cardinality 상태만 기록한다.

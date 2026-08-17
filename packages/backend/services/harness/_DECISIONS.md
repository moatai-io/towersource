# Harness module decisions

- Harness는 Engine adapter가 아니라 Engine 위의 실행 조립 계약이다.
- 첫 버전은 동작을 바꾸지 않는 `tower-default@v1`만 제공한다.
- Session마다 하나의 resolved contract를 만들고 Prompt·Tool·MCP 조립에 같은 객체를 전달한다.
- capability filtering과 DB binding은 golden default가 고정된 뒤 추가한다.
- 미분류 capability와 snapshot mismatch는 후속 enforcement 단계에서 fail-closed한다.
- Channel 전용 익명 Harness를 만들지 않는다. Channel은 호출된 Agent의 Harness snapshot에 호출자·청중·resource 제약을 교집합으로 적용한다.
- Channel context가 없거나 Agent/caller binding이 맞지 않으면 `tower-default` 관리자 fallback 없이 거부한다.

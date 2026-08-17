# 구조 결정

- root turn identity는 이미 영속된 user message ID를 사용한다.
- recovery claim은 PostgreSQL row lock + CAS 상태 전이로 한 명만 획득한다.
- lease 재획득 뒤 이전 worker가 돌아오는 경우를 막기 위해 fencing token을 사용한다.
- recovery coordinator와 외부 부작용 exactly-once는 분리한다.
- 부작용 실행 여부가 불확실하면 자동 재실행보다 `uncertain` 정지를 우선한다.
- due retry dispatcher는 `waiting_retry` discovery와 wake만 소유하며 claim·execution·settlement 상태기계를 복제하지 않는다.
- process timer는 편의를 위한 wake 수단일 뿐이다. 정본 일정은 PostgreSQL `next_attempt_at`이고 중복 wake는 기존 `owner_token` claim이 fencing한다.
- passive candidate backend는 shared DB의 due turn을 scan하거나 claim하지 않는다.
- foreground Pi 실행도 recovery와 같은 `owner_token` fence를 사용하되 recovery 시도 예산(`attempt_count`)은 소비하지 않는다.
- Router/provider terminal은 진단·reconciliation 증거다. Tower `completed` 권한은 durable assistant persistence와 fenced settlement에만 있다.
- restart recovery는 24시간 이내의 최신 사용자 turn만 허용한다. 오래됐거나 더 최신 사용자 메시지에 뒤처진 active row는 자동 실행하지 않고 `needs_attention`으로 닫는다.

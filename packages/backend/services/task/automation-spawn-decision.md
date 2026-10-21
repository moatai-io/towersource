# Automation spawn은 완료가 아니라 시작 확인이다

## Context
AI spawn runner는 Task ID를 반환한다. 시작 Promise를 기다리지 않으면 시작 거절이 성공으로 기록되고, 이를 Session ID로 사용하면 잘못된 링크가 생긴다.

## Options considered
- success를 유지하고 설명만 바꾼다: 완료 오인이 남는다.
- 바로 전체 실행/전달 원장을 만든다: 운영 복구와 범위가 섞인다.
- 시작 확인과 결과 참조 타입을 먼저 바로잡는다.

## Decision
세 번째 방식을 첫 구현 단위로 선택한다. spawnTask의 admission을 await하고 상태를 spawned로 기록한다. 수동 실행은 완료 알림을 보내지 않는다. Session 참조는 AI inject/channel에만 허용한다. 과거 AI spawn success는 Process Map에서 완료 미확인으로 투영하며 원본 이력을 수정하지 않는다.

## Consequences
DB migration이나 고객 실행환경 변경 없이 잘못된 완료/세션 링크를 줄인다. spawned는 Task 종료 상태로 자동 정산되지 않으며 그 후속 연결은 별도 구현해야 한다. Task 완료도 외부 전달 증거를 대신하지 않는다. Slack 발송, Worker 배포, CA 변경, 재시도 정책은 변경하지 않는다.

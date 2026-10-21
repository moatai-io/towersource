# wait 세션 알람

## 현재 계약

Pi의 `wait(durationSeconds, reason)`는 1초부터 30일까지의 일회성 알람을 저장한 뒤 현재 실행을 정상 종료합니다. 대기 중 모델 호출과 장시간 프로세스 타이머는 없습니다. 서버는 10초 간격으로 실행할 알람을 확인합니다. 세션이 실행 중이면 기다리고, 실행 가능한 상태가 되면 같은 세션에 새 root turn으로 작업을 이어갑니다. 정기 자동화는 기존 task-schedule의 책임입니다.

세션 옆 카드에는 이유·남은 시간·재개 시각을 표시하며 소유자가 지금 이어가기·시간 변경·취소할 수 있습니다. 버전이 바뀐 카드의 요청은 409로 거절하고 최신 상태를 다시 읽습니다. UI는 시간을 표시할 뿐 서버 실행을 구동하지 않습니다.

## 저장·재개 경계

- `242_session_wait_alarms.sql`은 알람과 안정적인 resume message ID를 저장합니다. 운영 DB에는 배포 시 migration 적용이 필요합니다.
- source turn은 도구 안에서 lease를 해제하지 않습니다. Pi의 finishTurn과 기존 fenced settlement가 실행을 종료합니다. wait 이후 같은 turn의 후속 도구 실행은 차단합니다.
- 알람 admission은 세션 행 잠금 안에서 pending 상태를 한 번만 전환하고 resume 메시지·root를 함께 저장합니다. 알람을 취소하거나 새 지시가 오면 이미 admitted된 알람도 무효화합니다.
- 재개 직전과 crash recovery에 소유자 활성 상태·현재 실행 권한·알람 유효성을 다시 확인합니다. 실제 외부 부작용의 exactly-once를 보장하지 않습니다.
- 재시작 시 알람이 저장된 source root는 일반 실패 재시도로 replay하지 않습니다. admission 전후 crash의 resume root는 기존 supervisor 복구 흐름을 사용합니다.
- 서버가 중단된 동안 놓친 알람은 재시작 후 idle 상태에서 처리합니다. 정확한 초 단위 실행시각은 보장하지 않습니다.

## 지원 범위

현재 저장형 알람은 Pi 일반 legacy/operator 도구 표면에서 지원합니다. Restricted Harness 권한을 자동 확대하지 않습니다. 구형 Claude는 안전한 세션 parking 경계가 없으므로 저장형 wait를 명시적으로 거절하며 알람을 생성하지 않습니다. 기존 sleep 호출 기록은 동일한 대기 UI로 표시합니다. `sleep.ts`는 기존 bounded timer의 호환 구현이며 새 Pi wait 호출은 사용하지 않습니다.

## 검증과 한계

관련 단위·UI·source wiring 테스트, 별도 임시 PostgreSQL의 저장·취소·버전 충돌·source 검증·동시 admission 테스트를 실행했습니다. 백엔드·프론트엔드 타입 검사를 실행했습니다. 실제 provider를 통한 wait→프로세스 종료→재시작→재개 및 브라우저 화면 검증은 아직 수행하지 않았습니다. 운영 DB migration 적용·배포·커밋은 이 변경에 포함하지 않습니다.

### Superseded retry handling

Before scanning due alarms, the dispatcher retires only unowned, expired-lease `waiting_retry` roots whose human source message predates the alarm's human source request. It preserves uncertain-side-effect and wait-requested roots. Running, stop-requested, user-input and approval states still block admission. Retired roots become `needs_attention` with `restart_recovery_superseded`; they are not replayed. The overdue card states that automatic resumption has not started and does not infer that the session is busy from elapsed time alone.

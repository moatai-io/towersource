# session 모듈 — 구조 결정

## 왜 3 파일이 한 폴더에 묶였나

세션 *라이프사이클* (manager), 세션 *간 관계* (backlinks), 세션 *공유* (share-manager) — 셋 다 동일한 "세션 (Claude/Pi 대화)" 도메인. 한 폴더로 묶으면 AI 가 "세션 작업" 받았을 때 grep 1번으로 끝.

## 왜 session 과 room 이 분리됐나

이름이 비슷해 보이지만 다른 개념:
- **session** = AI (Claude/Pi) 와의 1:1 대화. `.jsonl` 파일 영속, 1 owner.
- **room** = 사용자들 사이 채팅 채널. PG 에 메시지 영속, N members.

합치면 모델 폭발 (visibility, members, .jsonl, AI 컨텍스트 모두 한 모듈에 섞임). 분리 유지.

## 왜 .jsonl 이 SDK source of truth 인가 (DB 가 아님)

Claude/Pi SDK 가 자체 `.jsonl` (turn-by-turn append-only) 로 세션 메시지를 영속함. 우리 DB 는 **메타데이터** (이름, 비용, 사용자, 룸 연결 등) 만 보관. 이유:
- SDK 가 resume 할 때 .jsonl 만 봄 — DB 는 안 본다
- 우리가 DB 에 메시지를 또 저장하면 두 source 동기화 비용
- `.jsonl` 이 사라지면 (사용자 .claude/ 정리) 세션은 사실상 죽음 → audit 가 이걸 감지

이 모델은 SDK 디자인 결정이라 우리가 못 바꿈. 받아들이고 그 위에 메타 레이어 얹음.

## 왜 backlinks 가 Level 1 (파일 기반) 만인가

Level 1 = "다른 세션이 같은 파일을 만짐" 의 단순 조인. 구현 비용 낮음, 정확도는 보통.
Level 2/3 = 의미 기반 (embedding, topic clustering). 비용 큰데 효용 의문 → 미구현. 사용자가 충분히 쓰는지 보고 결정.

근거: `workspace/decisions/2026-04-21-session-backlinks-level1.md`

## 왜 share-manager 가 internal + external 두 종류를 다루나

- **internal**: 같은 워크스페이스 사용자에게 권한 부여 (DB row, target_user_id). 사용자 식별 가능 → audit log, revoke 명확.
- **external**: 외부 사람에게 토큰 링크 발송 (이메일, Slack 등). 토큰 소유 = 접근. 익명·일회성·만료.

두 흐름이 같은 share row 모델에 collapse 됨 (target_user_id 와 token 둘 다 nullable). 한 모듈에 둠 — 외부에서 보는 흐름은 동일 ("이 세션을 공유하고 싶다"). 분리하면 호출자가 매번 둘 중 어느 쪽인지 분기.

## 왜 createSession 이 매개변수가 그렇게 많은가 (10+)

세션은 다양한 컨텍스트에서 생성됨:
- 사용자가 채팅 새로 시작 (룸 연결, 사용자, 프로젝트)
- 룸 에서 `@ai` 호출 (sourceMessageId)
- 다른 세션에서 분기 (parentSessionId, label)
- task-runner 가 자동 생성

각 진입점이 다른 매개변수 필요. 분리하면 10개 함수가 됨 — 각자 90% 같은 row INSERT 로직. 한 함수 + optional 매개변수 유지 결정. AI 가 한 함수 시그니처 보고 모든 옵션 알 수 있음.

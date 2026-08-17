# Prompt Inspector

## 책임

admin이 특정 Session에 현재 주입될 시스템 프롬프트를 모델 응답이 아닌 서버 조립 경로에서 육안 검토하도록 재구성한다.

## Public API

- `inspectSessionPrompt()`

## 알아야 할 점

- 과거 호출 payload를 저장하지 않는다. 조회 시점의 코드·DB 정책·프로젝트 파일로 재구성한다.
- credential, token, password 등 비밀값 패턴은 admin에게도 항상 마스킹한다.
- 조회는 actor, session, 크기, hash만 서버 로그에 남기며 prompt 본문은 로그에 쓰지 않는다.
- Pi는 SDK base prompt까지 `DefaultResourceLoader`에서 읽는다. Claude/local은 Tower가 소유한 builder prompt를 우선 제공한다.

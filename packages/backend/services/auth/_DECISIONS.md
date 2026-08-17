# auth 모듈 — 구조 결정

## 왜 5 파일이 한 폴더에 묶였나

`auth.ts` (사용자 인증), `credential-store.ts` (Claude 계정 회전), `oauth-manager.ts` + `oauth-store-pg.ts` (외부 OAuth 토큰), `google-oauth.ts` (Google 흐름) — 이름은 다르지만 모두 **자격증명 / 토큰 / 신원** 의 동일 도메인. 한 폴더에 모으면 AI 가 "auth 작업" 받았을 때 grep 1번으로 끝남.

## 왜 oauth-manager 와 oauth-store 가 분리됐나

매니저 = OAuth 흐름 로직 (등록·조회·갱신). 스토어 = 영속성 (PG 구현). 테스트는 in-memory store 로 매니저 검증. PG 의존성 없이 단위 테스트 가능. **인터페이스 (OAuthStore) 가 두 파일의 계약** — store 만 갈아끼우면 다른 backend (Redis, in-memory) 도 가능.

## 왜 google-oauth 는 별도 파일인가

매니저는 generic. Google 은 Google 만의 endpoint URL / scope / userinfo 호출이 필요. provider 별 specifics 는 매니저에 박지 않고 file 단위로 분리 — 새 provider (예: GitHub) 추가 시 `github-oauth.ts` 한 파일 추가로 끝.

## 왜 createUser 가 dynamic import 로 project-manager / group-manager 를 부르나

순환 import 회피. project-manager 가 사용자 검증을 위해 auth 를 부르고, auth 가 사용자 생성 시 project 에 가입시키므로 양방향. dynamic import 로 한쪽 끊음. 정상 시점에만 호출 (createUser 시점) 이라 성능 영향 무시.

## 왜 oauth-manager 의 싱글톤은 messaging/index.ts 가 보유하나

OAuth 토큰의 주 사용처는 **메시징 채널** (Kakao 푸시, Telegram, Google 알림 등). 매니저 instance + 등록된 refresher 는 messaging 쪽 부팅 시점에 1회 생성, 거기서 export. auth 는 매니저 *팩토리* 만 제공. 어디서 만드는지 한 곳으로 고정 → AI 가 "어디서 instantiate 됐지?" 검색 1회.

## 왜 credential-health.ts 가 credential-store.ts 와 분리됐나

`credential-store.ts` 는 DB row CRUD + configDir 라우팅 + 자산 심링크 prep. *Claude 가 어느 디렉토리에 살 수 있는지* 의 책임. `credential-health.ts` 는 그 디렉토리 안 `.credentials.json` 의 OAuth 토큰 *생명주기 관찰*. 책임이 다르다:

- store = mutable (계정 추가/삭제, 매핑 변경)
- health = read-only (파싱·분류만, 절대 파일 안 만짐)

또 health 는 *옵션*. store 가 없으면 Tower 가 안 돌지만 health 가 없어도 Tower 는 도는 (UI 가 dot 안 보일 뿐). 그래서 health 가 store 를 import 할 수는 있어도 (configDir 목록 얻기) 그 반대는 절대 금지. 컴파일 시 단방향 의존을 표현.

근거: `workspace/decisions/2026-05-25-multi-account-multi-provider-umbrella.md` §"진짜 새로 박는 것 2 — Credential lifecycle 가시성", §"의도적으로 안 하는 것" (read-only 관찰만, refresh 직접 제어 X).

## 왜 service-tokens.ts 가 별도이고 auth.ts 에 박혀있지 않나

`auth.ts` 의 `generateScopedToken` 은 토큰 자체 발급만 — DB audit 책임 없음. pm-capture 의 `ideas` scope 같은 15분짜리 일회성은 DB row 가 부담이고 의미 없음. 반대로 fleet 같은 90일짜리는 *revocation* + *last_used_at* + *발급/만료 audit* 가 필수.

분리 이유:
- `auth.ts` 는 모든 요청이 거치는 hot path (authMiddleware). 가볍게 유지.
- `service-tokens.ts` 는 DB I/O 가 본격적. auth.ts 가 dynamic import 로 매 fleet 토큰 요청에서만 호출 (이미 그렇게 구현).
- `auth.ts` 의 `AUDITED_SCOPES` set 이 두 모듈의 *얇은 계약* — fleet 같은 long-lived scope 추가 시 한 줄.

자세히는 `workspace/decisions/2026-05-27-fleet-service-tokens.md` D6/D7/D8 참조.

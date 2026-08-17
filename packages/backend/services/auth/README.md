# services/auth — 인증 / 자격증명 / OAuth

Tower 의 인증·자격증명 관리 모듈. 사용자 로그인, JWT 토큰 발급, Claude 계정 자격증명 회전, 외부 OAuth 흐름 (Kakao, Google, Telegram).

## 책임

- **사용자 인증**: bcrypt 패스워드 + JWT 토큰
- **세션 토큰**: HTTP `authMiddleware` / WebSocket `verifyWsToken`
- **Admin 사용자 CRUD**: list / role 변경 / path 제한 / soft-delete (`disabled`)
- **Claude 계정 회전**: 프로젝트별로 다른 `CLAUDE_CONFIG_DIR` 사용 (Max/Pro 다중 계정)
- **OAuth 매니저**: 외부 provider 토큰 저장·갱신 (refreshFn 등록 가능)
- **Google OAuth**: Gmail / Calendar / Drive 용 OAuth 2.0 흐름

## Public API

### `auth.ts` — 사용자 인증
- `createUser(username, password, role?)` — 사용자 생성
- `authenticateUser(username, password)` — 로그인 검증, JwtPayload 반환
- `generateToken(payload)` / `verifyToken(token)` — JWT 발급/검증
- `generateScopedToken(...)` — 좁은 권한·짧은 만료 토큰 (예: ideas namespace + 15min)
- `authMiddleware` / `adminMiddleware` — Express 미들웨어
- `verifyWsToken` / `getUserAllowedPath` — WebSocket 핸들러용
- `listUsers` / `updateUserRole` / `updateUserPath` / `resetUserPassword` / `disableUser` — admin CRUD
- `hasUsers` — 초기 셋업 여부 확인
- `SCOPE_PREFIXES` / `AUDITED_SCOPES` / `isKnownScope` / `pathMatchesScopePrefix` — scope 레지스트리 (fleet, ideas 등 추가 시 여기 한 줄)

### `service-tokens.ts` — Long-lived scoped JWT 발급·audit
- `issueServiceToken({aud, userId, username, role, issuedFor, expiresIn?})` — 토큰 발급 + `service_tokens` 테이블에 audit row
- `listServiceTokens({aud?, activeOnly?})` — 발급된 토큰 조회 (실제 token 값은 저장 안 함)
- `revokeServiceToken(jti)` — `revoked_at` mark
- `isJtiRevoked(jti)` — authMiddleware 가 매 요청 체크 (unknown jti = false, 즉 short-lived 'ideas' 토큰 영향 X)
- `touchServiceToken(jti)` — `last_used_at` 갱신 (60초 throttled, fire-and-forget)
- 결정: `workspace/decisions/2026-05-27-fleet-service-tokens.md` · Issue #36

### `credential-store.ts` — Claude 계정 회전
- `listAccounts` / `addAccount` / `updateAccount` / `removeAccount` — Claude Max/Pro 계정 등록
- `assignAccountToProject(projectId, accountId)` — 프로젝트별 계정 매핑
- `getConfigDir(projectId?)` — SDK 호출 시 사용할 `CLAUDE_CONFIG_DIR` 결정 (없으면 기본 `~/.claude/`)

### `credential-health.ts` — OAuth 토큰 생명주기 관찰 (read-only)
- `readCredentialHealth(configDir)` — `.credentials.json` 파싱 → `{status, reason, expiresAt, daysUntilExpiry, hasRefreshToken, ...}`
- status: `healthy` (≥7d + refresh O) / `warning` (<7d 또는 no refresh) / `critical` (expired) / `missing` / `malformed`
- 절대 파일에 쓰지 않음. refresh 는 SDK 책임. Tower 는 *관찰*만.
- Phase 1 of `workspace/decisions/2026-05-25-multi-account-multi-provider-umbrella.md`

### `oauth-manager.ts` + `oauth-store-pg.ts` — 외부 OAuth 토큰
- `createOAuthManager(store)` — 매니저 생성. `messaging/index.ts` 가 싱글톤으로 보유
- `pgOAuthStore` — PostgreSQL 백엔드 (production)
- 등록된 refresher (kakao, google) 가 만료된 토큰 자동 갱신

### `google-oauth.ts` — Google OAuth 2.0
- `isGoogleOAuthConfigured` — `.env` 에 GOOGLE_CLIENT_ID 등 있는지
- `getGoogleAuthUrl(state)` — 사용자 리디렉션 URL
- `exchangeGoogleCode(code)` — code → tokens
- `createGoogleRefresher` — oauth-manager 에 등록할 refresh 함수

## 들어오기 전에 알아야 할 것

- **PostgreSQL 필수** — users 테이블이 PG 에 있음. DB 없으면 인증이 우회됨 (2026-04-04 사고). 신규 자체 호스팅 서버 배포 시 PG 세팅 안 하면 보안 이슈.
- **`disabled` 컬럼 = soft-delete** — 사용자 삭제는 즉시 row 제거가 아니라 `disabled = true`. 세션은 즉시 prune.
- **VALID_ROLES 는 `damage-control` 에서 import** — 역할 추가/변경 시 거기 먼저 수정. 순환 import 회피 위해 분리.
- **JWT 시크릿은 `config.jwtSecret`** — 환경변수 미설정 시 startup 에서 강제 종료해야 함 (현재는 경고만, TODO).
- **`generateScopedToken` 은 ideas namespace 등 좁은 권한 전용** — 일반 로그인 토큰 대용으로 쓰지 말 것.
- **OAuth refresh 는 `messaging/index.ts` 싱글톤이 owner** — 여기서는 fn 만 export, 등록은 messaging 쪽.

## 관련 결정문서

- `workspace/decisions/2026-04-04-azure-deployment.md` — PostgreSQL 필수 발견 사고
- `workspace/decisions/2026-05-02-member-auto-membership.md` — `createUser` 가 default project 자동 가입시키는 정책
- `workspace/decisions/2026-05-03-ai-friendly-refactoring.md` — 이 폴더가 분리된 이유 (Phase 2 시범)

## 관련 모듈

- `services/damage-control` — VALID_ROLES, 권한 검증 정책
- `services/messaging/` — oauthManager 싱글톤 보유, 채널별 refresher 등록
- `services/project-manager` / `services/group-manager` — `createUser` 가 dynamic import 로 호출 (auto-join default projects)
- `engines/claude-engine` — `getConfigDir` 호출해서 SDK env 주입
- `routes/api.ts` — admin 사용자 CRUD 라우트
- `routes/gateway.ts` / `routes/ws-handler.ts` — 미들웨어 사용

## 테스트

- `oauth-manager.test.ts` — OAuth 토큰 매니저 단위 테스트
- `credential-health.test.ts` — `.credentials.json` 파싱 + 만료 threshold
- `service-tokens.test.ts` — 발급/audit/revocation/throttle/scope 레지스트리 (21 cases)
- ws-handler 테스트는 `verifyWsToken` / `getUserAllowedPath` 를 mock

# services/auth — 인증 / 자격증명 / OAuth

Tower 의 인증·자격증명 관리 모듈. 사용자 로그인, JWT 토큰 발급, Claude 계정 자격증명 회전, 외부 OAuth 흐름 (Kakao, Google, Telegram).

## 책임

- **사용자 인증**: 신규 비밀번호 Argon2id 저장, 기존 AES/bcrypt 검증 호환 + JWT 토큰
- **세션 토큰**: HTTP `authMiddleware` / WebSocket `verifyWsToken`
- **Admin 사용자 관리**: 전체 상태 목록 / 역할 변경 / 비활성화·재활성화 / 계정별 최근 인증 이벤트
- **Claude 계정 회전**: 프로젝트별로 다른 `CLAUDE_CONFIG_DIR` 사용 (Max/Pro 다중 계정)
- **OAuth 매니저**: 외부 provider 토큰 저장·갱신 (refreshFn 등록 가능)
- **Google OAuth**: Gmail / Calendar / Drive / Sheets 용 OAuth 2.0 흐름

## Public API

### `auth.ts` — 사용자 인증
- `createUser(username, password, role?)` — 사용자 생성
- `authenticateUser(username, password)` — 로그인 ID 또는 확인된 기본 이메일로 검증, JwtPayload 반환. 다른 계정의 로그인 ID와 이메일 alias가 충돌하면 실패하며 미확인 이메일은 alias가 아닙니다.
- `generateToken(payload)` / `verifyToken(token)` — JWT 발급/검증
- `generateScopedToken(...)` — 좁은 권한·짧은 만료 토큰 (예: ideas namespace + 15min)
- `authMiddleware` / `adminMiddleware` — Express 미들웨어
- `verifyWsToken` / `getUserAllowedPath` — WebSocket 핸들러용
- `listUsers` / `updateUserRole` / `resetUserPassword` / `disableUser` — 계정 상태와 자격증명 변경 (구형 `updateUserPath`는 금지)
- `user-management.ts` — 트랜잭션에서 대상 row를 잠그고 현재 역할·승인 상태를 확인한 뒤 승인 완료 비활성 계정만 재활성화하고 `auth_epoch`를 증가시킵니다. actor/target/outcome은 `account_security_events`에 같은 트랜잭션으로 기록해 감사 기록 실패 시 복구도 롤백합니다. 계정별 로그인 이벤트는 대상 역할의 공유 잠금을 유지하며 20건씩 커서 조회합니다.
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

#### Sheets 편집 권한과 기존 연결

- `GOOGLE_DEFAULT_SCOPES`는 `spreadsheets` 편집 scope를 요청하며 Drive와 Calendar는 기존 읽기 전용 scope를 유지합니다. Docs 편집이나 Drive 전체 관리 권한을 추가하지 않습니다.
- 공개 OAuth 앱 운영자는 Google Cloud의 동의 화면·필요한 앱 검증 및 Sheets API 활성화를 확인해야 합니다. Google의 앱 승인과 각 사용자의 권한 동의는 별개입니다.
- 코드 배포만으로 기존 토큰 권한이 확대되지는 않습니다. 기존 연결은 갱신된 OAuth 경로에서 추가 동의를 받아야 합니다. `getGoogleAuthUrl`은 `prompt=consent`와 `access_type=offline`을 사용합니다.
- 파일 자체의 편집 권한과 실행 시 선택된 Google 계정도 별도로 확인합니다. 실제 셀 변경은 사용자 승인 후 테스트 시트에서 검증합니다.
- 회귀 검사: `google-oauth-scopes.test.ts`는 기본 scope 및 실제 인증 URL을 확인합니다. 단위 테스트는 Google 앱 검증·실제 재인증·운영 편집 성공을 증명하지 않습니다.

### `cp-login-*` / `cp-browser-session` — 고객 SSO와 기존 브라우저 세션 연결

관리형 고객 SSO는 `TOWER_CP_LOGIN_ENABLED=1`인 설치에서만 활성화한다. 로컬 비상 로그인과 분리하며 중앙 이메일 문자열로 기존 사용자를 합치거나 사용자 상태를 임의 승격하지 않는다. 승인된 공개 고객 origin은 `<고객명>.tower.example.org`와 호환 `<고객명>.tower.example.com`이다. 실제 CP origin·조직·instance·receiver binding은 설치별 보호 설정에서 주어진다.

1. `/api/auth/cp/start`는 state·PKCE를 준비하고 host-only·Secure·HttpOnly 임시 쿠키와 중앙 로그인 진입으로 연결한다. 콜백은 설치된 정확한 CP origin, state와 verifier를 확인해 중앙의 제한된 교환 경로에서 일회성 code를 소비한다. Portal/DB의 허가·만료·철회 검사는 Control Plane 저장소가 소유한다.
2. `cp-login-users.ts`는 issuer·subject·조직·instance binding과 advisory lock을 이용해 로컬 identity를 생성하거나 재사용한다. 읽기 전용 mapping을 갱신하려는 `FOR UPDATE OF m`을 사용하지 않고 변경이 필요한 users만 `FOR UPDATE OF u`로 잠근다. 기존 사용자나 다른 identity를 이메일로 병합하지 않으며 활성 상태·역할 정책을 유지한다.
3. 성공 콜백은 기존 발급 경로의 `tower_token` 쿠키를 설정하고 `/api/auth/cp/complete`로 보낸다. 완료 페이지는 응답별 nonce CSP, `connect-src 'self'`, `no-store`, `no-referrer`를 적용하고 토큰을 HTML·URL에 넣지 않는다.
4. 완료 페이지는 같은 origin의 `POST /api/auth/cp/browser-session`만 호출한다. 서버는 정확한 Origin, 단 하나의 정상 cookie, 서명·만료·audience 없는 browser JWT, 현재 사용자 활성/승인 상태, auth epoch와 비밀번호 변경을 검사한다. DB 오류는503으로 닫는다. 새 토큰을 발급하거나 권한을 늘리지 않고 유효한 기존 세션만 반환한다.
5. 스크립트는 현재 제품 UI가 쓰는 localStorage의 인증 키를 연결한 뒤 `/`로 이동한다. 기존 토큰의 사용자와 다르거나 식별하지 못하면 계정 전환 확인을 요구한다. 취소·실패 시 기존 브라우저 세션을 지우지 않고, 테마 같은 비인증 키를 보존한다. 이 경로는 cookie-only 인증으로의 전면 전환이 아니며 기존 localStorage 모델의 XSS 위험을 없애지 않는다.

콜백의 현재 JWT·쿠키 수명은300초다. bridge는 만료를 연장하지 않는다. 로그인 grant 만료와 이미 발급한 세션 만료도 별개다. 장시간 사용·갱신·재접속·다른 사용자·고객은 별도 인수 대상이다. 코드 저장만으로 다른 VM에 이 경로를 활성화하지 않는다.

회귀 검사는 `cp-login-exchange.test.ts`, `cp-login-users.test.ts`, `cp-login-route.test.ts`, `cp-browser-session.test.ts`에서 실패한 Origin·쿠키, 만료/취소된 사용자 상태, callback→완료 페이지, nonce CSP, 새/호환 도메인, 계정 전환 취소와 기존 설정 보존을 다룬다. `services/publishing/path-publishing-app.test.ts`는 새/호환 게시 hostname에서 공개 파일·API 격리를 따로 검증하며 SSO 성공이 Publishing 인수를 대신하지 않는다. 검사는 합성 토큰·mock 계정·로컬 HTTP/스크립트 실행을 사용하고 실제 고객 세션을 발급하지 않는다.

운영 계보는 `tower-project-dev/saas-provisioning/records/phase1-2026-10-13/test2-sso-user-confirmed.json`의 특정 사용자·test2·`03934d54b3758cfa844766a90070a9d1eac9e619` 관측과 구분해 보존한다. 코드 정합성 근거는 같은 Workspace의 `saas-provisioning/records/sso-source-alignment-2026-10-13/`, 최신 제품 인수 범위는 `saas-provisioning/progress.md`를 따른다. 다른 revision의 로컬 시험·빌드 통과를 운영 배포 또는 전체 인수로 승격하지 않는다.

## 들어오기 전에 알아야 할 것

- **PostgreSQL 필수** — users 테이블이 PG 에 있음. DB 없으면 인증이 우회됨 (2026-04-04 사고). 신규 자체 호스팅 서버 배포 시 PG 세팅 안 하면 보안 이슈.
- **`disabled` 컬럼 = soft-delete** — 비활성화는 row·이메일·프로젝트 권한을 보존하고 기존 WS를 끊습니다. 기존 운영자 DELETE 경로도 대상 row 잠금 후 현재 역할을 검사해 admin/operator로 바뀐 계정을 비활성화하지 않습니다. 기존 운영자 역할·프로필 변경 PATCH는 조건부 UPDATE, 사용자명 변경은 row 잠금으로 현재 역할을 재확인해 동시 승격 직후의 admin/operator 계정을 변경하지 않습니다. 재활성화는 별도 확인 후 `approval_status='active'`인 비활성 사용자만 허용합니다. 승인 대기·거절·중단 상태는 승인되지 않습니다. pending OTP/이메일 등록 challenge는 비활성화 때 취소하고 복구하지 않습니다.
- **비밀번호/토큰** — 신규 쓰기는 비동기 Argon2id(19 MiB, time=2, parallelism=1)이며 단일 프로세스 최대 2개 동시 hash/verify 슬롯입니다. 기존 AES·bcrypt는 성공 로그인 때 CAS로 재해시하며 동일 사용자의 동시 reset을 덮어쓰지 않습니다. AES 일괄 복호화·평문 관리자 조회는 없습니다. `226_user_reactivation_epoch.sql`은 `auth_epoch`를 기본 0으로 추가합니다. 레거시 JWT(필드 없음)는 변경 이력 없는 사용자에서만 epoch 0으로 수용하며 재활성화 후 기존 browser/CLI/service JWT 및 2초 iat grace는 더는 통과할 수 없습니다. 비밀번호 변경·사용자명 변경도 epoch를 증가시키며 본인 비밀번호 변경은 새 epoch를 포함한 JWT를 발급합니다. 프로세스 간에는 기존 5초 auth-state TTL이 남습니다.
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
- `routes/api.ts` — admin/operator 사용자 조회·비활성화·재활성화·계정별 이벤트 라우트. operator는 member/viewer/guest만 조회·관리하고 admin/operator 대상은 admin만 허용합니다. `GET /admin/users`는 비활성 계정도 반환하지만 password_hash/plain은 반환하지 않습니다. `GET /admin/users/:id/auth-events?before=<id>`는 계정별 id 내림차순 20건만 반환하며 IP/시각/유형 외에는 노출하지 않습니다. `GET /auth/check`도 상태와 epoch를 확인하고 503으로 닫힙니다.
- `frontend/src/components/admin/UserManagement.tsx` — 사용자 검색·상태 필터·상세/최근 로그인·재활성화 확인. 기본 목록은 활성/승인 대기 등을 표시하고 비활성은 별도 접힌 섹션에 둡니다. 명시적 비활성 필터는 곧바로 열고 검색 시 매칭되는 비활성 결과도 표시합니다. 모바일은 별도 단일 목록에서 검색·상세·재활성화에 도달하며 synthetic fixture로 검증합니다. 최근 로그인 IP는 접속 중 상태나 현재 IP가 아닙니다.

### 토큰·migration·IP·보존 경계 (TOW-94/97)

- 로그인/OTP 완료에서 나오는 browser JWT, `/auth/cli-login` 및 서버 CLI 직접 로그인에서 생성하는 `tower-cli` JWT, service token은 모두 현재 `auth_epoch`를 담습니다. HTTP `authMiddleware`, `/auth/check`, WebSocket verifier 및 서버 CLI `requireActiveUser`는 DB epoch와 비교합니다. 기존 epoch 없는 JWT는 epoch 0 계정에서만 유효하며, 비활성화 후 복구된 계정의 이전 browser/CLI/service JWT는 재활성화로 되살아나지 않습니다. service token의 audit row는 물리적으로 남으며 자동 폐기하지 않습니다. CLI는 import/status/명령 실행에서 같은 상태 검사를 사용합니다. 내부 기능이 `generateToken`을 새로 호출한다면 현재 epoch를 채워야 하므로 새 발급 경로를 테스트해야 합니다.
- migration `226_user_reactivation_epoch.sql`은 기본값 0의 컬럼을 추가하고 기존 데이터는 보존합니다. 코드를 먼저 이전 버전으로 되돌리는 경우 컬럼을 지우지 않는 forward-only 복귀를 권장합니다. 컬럼을 DROP하는 스키마 rollback은 신규 코드가 현재 epoch를 조회·갱신하므로 비호환이며, 이미 발급된 epoch>0 토큰의 revocation 의미를 잃을 수 있습니다. 모든 서버가 신규 코드를 사용하기 전 새 비밀번호 쓰기/재활성화는 동시 버전 운영 검토가 필요합니다. 기존 버전은 Argon2id 읽기·auth_epoch 폐기를 이해하지 못할 수 있습니다. 실제 rollback 수행은 별도 운영 결정입니다.
- `index.ts`는 `trust proxy=1`이고 로그인/OTP 경로는 `req.ip || req.socket.remoteAddress`를 `last_login_ip`와 `auth_login_events.ip_address`에 저장합니다. Express는 첫 upstream proxy의 X-Forwarded-For를 신뢰하므로 실제 프록시 홉 수/직접 backend 접근 차단/헤더 덮어쓰기가 일치하는지 설치별로 확인해야 합니다. IP를 인증된 신원·현재 온라인 상태로 취급하지 말고, 무신뢰 직접 호출에서 삽입된 X-Forwarded-For를 신뢰하지 마세요. 이번 작업은 프록시 설정을 수정하지 않았습니다.
- 로그인 IP·시각 이벤트의 보존기간과 접근 정책은 아직 확정되지 않았습니다. 제안: 보안/개인정보 책임자가 이용 목적·허용된 조회 역할, 예시 90일 보존 및 만료 이벤트 삭제 시점, 사고 대응 보존 예외·백업 수명과 데이터 주체 통지 요구를 승인한 뒤 별도 migration/job으로 구현합니다. `auth_login_events`, `account_security_events`, `users.last_login_ip`를 구분해 정의하고 먼저 집계 건수·색인·복구 계획을 확인합니다. 이 제안은 운영 데이터 삭제·스케줄 설정을 수행하지 않습니다.
- `routes/gateway.ts` / `routes/ws-handler.ts` — 미들웨어 사용

## 테스트

- `oauth-manager.test.ts` — OAuth 토큰 매니저 단위 테스트
- `credential-health.test.ts` — `.credentials.json` 파싱 + 만료 threshold
- `service-tokens.test.ts` — 발급/audit/revocation/throttle/scope 레지스트리 (21 cases)
- ws-handler 테스트는 `verifyWsToken` / `getUserAllowedPath` 를 mock

## Account-state lookup coalescing

`auth.ts:getUserAuthState` keeps the existing five-second, process-local account-state cache and shares concurrent cache-miss SQL reads per user. `invalidateAuthCache` invalidates both the cached value and any in-flight read; an old result cannot repopulate the cache or be returned by waiting readers after invalidation. Those readers retry against a new lookup. Repeated invalidation is bounded to three attempts, then throws so authentication does not accept uncertain state. Database failures propagate, missing accounts remain null, and another request can retry. This does not cancel an already-issued SQL query or immediately invalidate other processes; their existing TTL still applies.

아래 과거 실행 결과는 당시 revision의 검증 기록이며 이번 변경의 확인 결과가 아닙니다. 이번 변경의 검증 결과는 해당 작업의 테스트 실행 기록과 인계 요약을 따르며, 운영 검증으로 간주하지 않습니다.

`auth-state-cache.test.ts` executes the extracted production cache block with a mocked query adapter: 30 concurrent reads use one query, TTL and user boundaries are preserved, invalidated active/admin state is replaced with disabled/member state, errors propagate, and repeated mutations fail closed. Related revocation/password compatibility suite: 3 files / 11 tests passed; typecheck passed on the shared working tree. This is not full HTTP/WebSocket integration or live-load verification. Password verification, token issuance, context estimation and operational settings are unchanged.

Additional auth-boundary verification: `auth-state-integration.test.ts` imports the real auth module and uses real synthetic JWT signing/verification, mocked DB/config, and request/response doubles (no HTTP server or WebSocket handshake). Fifteen HTTP middleware calls and fifteen WS verifier calls share one SQL lookup and refresh the JWT role from DB. Tests reject a user disabled during the pending read, preserve password-change revocation, return HTTP 503 / reject WS verification on DB failure, and allow a subsequent retry. Combined cache/revocation/password suite: 4 files / 15 tests passed; typecheck passed. Live network and cross-process revocation remain unverified.

### Legacy bcrypt scheduling

`verifyStoredPassword` uses `await bcrypt.compare` for legacy bcrypt values instead of `compareSync`; AES/bcrypt read compatibility remains, while new writes are now Argon2id. bcryptjs is JavaScript with cooperative chunk scheduling, not a worker-thread implementation: total CPU cost remains and other requests may still wait during chunks. A local single synthetic cost-12 sample measured sync verification 293ms / timer delay 294ms versus async verification 295ms / timer delay 202ms. This is illustrative only, not a production latency guarantee or evidence of actual account hash cost. `password-read-compatibility.test.ts` verifies correct/incorrect passwords and use of the asynchronous API. Combined auth suite: 4 files / 16 tests passed; typecheck passed; no deployment or live login load test.

Final local verification: a regression where a replacement read completes before an invalidated old read revealed an unnecessary third SQL lookup. Retry attempts now recheck the fresh cache, preserving the replacement result and requiring only two queries for that scenario. All tests under `services/auth`: 25 files / 223 tests passed. `npm run build`, `npm run typecheck`, and diff whitespace checks passed on the shared working tree. Build emitted bundle-size and outdated Browserslist-data warnings; generated output is not a deployment and is not included in the source change. Production/browser verification is still pending.

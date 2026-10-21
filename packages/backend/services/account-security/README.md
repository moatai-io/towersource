# Account Security

이 모듈은 관리자 지정 이메일 초대, 기존 사용자 이메일 확인, 브라우저 로그인 이메일 OTP와 일반 계정 비밀번호 이메일 복구를 소유합니다.

## 관리자 멤버 추가 UI

`UserManagement.tsx`의 기본 멤버 추가 경로는 `EmailInvitationManagement.tsx`의 이메일 초대입니다. 관리자는 이메일·권한만 지정하고, 수신자는 `AccountEmailLinkPage.tsx`에서 이름·아이디·비밀번호를 직접 설정합니다. 기존 관리자 계정 생성은 ‘계정 직접 생성’ 보조 기능으로 유지합니다. 초대 목록은 수락 대기·수락 완료·취소 및 만료 여부를 표시하고 기존 API로 재발송·취소합니다. 발송 오류 후에도 초대 레코드가 남을 수 있어 목록을 재조회하며, 오류를 발송 성공으로 표시하지 않습니다.

UI 회귀 테스트: `packages/frontend/src/components/admin/EmailInvitationManagement.dom.test.tsx`, `AdminPanel.account-email.source.test.ts`. 로컬 테스트는 실제 provider 메일 발송이나 운영 배포 검증을 대체하지 않습니다.

## 경계

- 이메일 정규화 키는 trim 후 소문자이며 공급자별 점·plus 변형을 적용하지 않습니다.
- 초대 수락·관리자 생성·기존 invite 코드·이메일 복구 경로의 신규 비밀번호는 `auth.ts:hashPassword` 비동기 Argon2id 공통 함수로 저장합니다.
- 이메일 주소는 관리자 지정 후 사용자가 메일 링크를 소비해야 확인됩니다.
- 확인 토큰과 OTP 원문은 DB·로그·감사 이벤트에 저장하지 않습니다.
- `TOWER_LOGIN_EMAIL_OTP=off`가 기본이며 기존 브라우저 로그인과 CLI 인증을 유지합니다. 별도 `TOWER_LOGIN_EMAIL_OTP_PILOT_USER_IDS`는 비밀번호 인증 후 숫자 사용자 ID로만 대상 브라우저 로그인에 OTP를 요구합니다. 빈 값은 파일럿 해제이며 CLI·서비스 토큰은 대상이 아닙니다.
- `required`에서 OTP 성공 전에는 JWT 또는 `tower_token`을 발급하지 않습니다.
- 외부 공급자는 `mail/AccountMailProvider` 뒤에 격리합니다. `TOWER_MAIL_PROVIDER=resend`이면 `mail/resend-provider.ts`가 활성화되며, 미설정 기본값은 발송 불가입니다.
- Resend 설정은 운영 비밀 주입 경로의 `RESEND_API_KEY`, 비밀이 아닌 `TOWER_MAIL_FROM` 및 선택적 `TOWER_MAIL_REPLY_TO`를 사용합니다. 키는 저장소 파일이나 `.env`에 넣지 않습니다. `TOWER_MAIL_FROM`에는 공급자에서 인증된 발신 주소를 지정합니다. 특정 운영 도메인을 공개 저장소 기본값으로 고정하지 않습니다.
- Gateway의 기본 키 공급은 `TOWER_ACCOUNT_MAIL_CREDENTIAL_ID`로 지정한 활성 team-shared Zuplo api_key Credential입니다. 백엔드는 시스템 계정 메일 목적으로 Vault에서 직접 해석하고 감사 이벤트를 남깁니다. 이는 백엔드 전용 격리를 제공하지 않습니다. Credential ID는 운영 설정에서만 지정하며 HTTP·도구 입력으로 받지 않습니다. 키 파일 방식과 동시에 지정하면 실패합니다. 원본 Resend 키는 Gateway에만 둡니다. 회귀 테스트: `mail/account-mail-credential.test.ts`.
- 대체 파일 방식에서 `TOWER_MAIL_PROVIDER=gateway-resend`는 `TOWER_ACCOUNT_MAIL_GATEWAY_URL`(HTTPS `/account-mail/emails`), `TOWER_ACCOUNT_MAIL_KEY_FILE`(저장소 밖 owner-only 0600 파일의 절대 경로; 메일 전용 virtual key), `TOWER_MAIL_FROM`을 사용합니다. 운영자는 앱 실행 계정 소유의 저장소 외부 0600 파일을 별도로 프로비저닝해야 합니다. 앱은 발송 시마다 파일을 다시 읽으므로 재시작 후에도 파일이 유지되면 키를 다시 PM2 환경에 주입할 필요가 없습니다. 경로는 비밀이 아닌 운영 설정으로 전달하며 실제 운영 프로비저닝은 별도 검증이 필요합니다. Project 사용자 ID를 빌려 Credential resolver를 호출하지 않으며 Resend 원본 키로 자동 우회하지 않습니다. Gateway의 실제 consumer metadata, rate limit, 발신 도메인·라우트 배포는 별도 검증이 필요합니다.
- 승인된 Fleet 코드 배포에서만 private registry의 VM별 `account_mail.enabled: true` opt-in을 통해 Gateway URL·발신 주소·기존 `gateway_credential` ID를 환경파일에 추가할 수 있습니다. `grant_verified: true`는 별도 승인으로 consumer의 `account_mail=send` 허용을 확인했다는 운영 선언이며 공급자 검증을 대신하지 않습니다. 누락·충돌·legacy keyFile·대상 Credential metadata 부재는 cutover 전 차단합니다. OTP 정책은 자동 변경하지 않습니다. 상세 경계와 테스트는 `docs/architecture/gateway-profile.md`의 계정 메일 metadata opt-in 절을 참조합니다.
- `checkConnection()`은 키·발신 주소 존재만 검사합니다. `connection='ok'`는 공급자 인증·발신 도메인·실제 전달 검증을 뜻하지 않으므로 운영에서 `required`를 활성화하기 전 승인된 발신·수신 주소로 별도 검증해야 합니다.

## 브라우저 로그인 OTP

- `login-otp-service.ts`가 verified primary email 조회, challenge 발급·재발송·취소·소비와 readiness 집계를 소유합니다.
- OTP는 6자리이며 10분 후 만료되고 5회 실패 시 폐기됩니다.
- 재발송은 60초 후 가능하며 계정별 15분 동안 최대 5회 발송할 수 있습니다. 프론트엔드는 코드의 10분 유효시간을 안내하며 초 단위 재발송 카운트다운은 표시하지 않습니다. 일반 OTP와 최초 이메일 등록 화면 모두 작은 미수신 보조 안내에 고정된 1분 대기 문구를 표시하고, 60초 후 “인증 코드 다시 받기”를 활성화합니다. 재발송 요청 중 버튼을 잠그며, 성공 응답이 확인된 경우에만 입력을 비우고 새 코드 발송을 안내합니다. 검증: `packages/frontend/src/components/auth/LoginPage.otp-resend.test.tsx` (가상 시간·mock 응답, 실메일 미발송).
- 새 challenge는 기존 pending challenge를 supersede하며, verify 성공 경로만 브라우저 JWT와 cookie를 발급할 수 있습니다.
- `login-otp-http-pg.integration.test.ts`는 임시 Docker PostgreSQL(`otp_test`)과 임의 loopback HTTP 포트, 프로세스 내부 capture 메일 공급자를 사용합니다. 공유 개발·운영 DB 또는 실제 메일 공급자에 연결하지 않습니다. `npx vitest run packages/backend/services/account-security/login-otp-http-pg.integration.test.ts --maxWorkers=1`로 off 회귀, readiness 차단, 성공·재사용 방지, 재발송·취소, 만료·5회 오답, 발송 실패 후 재시도를 검증합니다. 테스트 종료 후 임시 컨테이너가 제거되어야 합니다.
- 기본 전역 `required` readiness는 명시적 제외 ID를 뺀 활성 계정(`disabled=0`, `approval_status='active'`)의 verified primary email 100%와 Mail Provider 연결 상태를 요구합니다. `existing` 등록 전환 모드에서는 cutoff 이하의 이메일 미등록 활성 계정만 coverage blocker에서 제외하며, 이 계정은 이메일 확인 없이는 로그인할 수 없습니다. cutoff 밖 미등록 계정과 공급자 blocker는 그대로 차단합니다. 파일럿은 전체 계정의 coverage를 요구하지 않으며 대상 계정의 verified primary email 및 Mail Provider 준비만 확인합니다. 대상이 미준비이면 해당 계정만 세션 발급 없이 차단합니다.
- `required` readiness 실패나 발송 실패는 HTTP 503으로 차단하며 비밀번호-only 로그인으로 강등하지 않습니다.
- 기존 계정의 비밀번호 로그인은 유지합니다. 최초 관리자 `/auth/setup`만 이메일 없는 신규 생성 예외입니다. 그 외 관리자 신규 계정 생성은 email·passwordConfirm·displayName이 필요하며 공유 초대코드 신규 가입은 중단합니다. 기존 계정의 이메일 확인은 계정의 관리자 승인이나 비밀번호 변경을 대신하지 않습니다.
- email-managed 계정 생성은 Mail Provider readiness를 DB mutation 전에 검사하여, 공급자 미준비 상태에서 pending 사용자만 남는 부분 생성을 막습니다.

## 일반 계정 비밀번호 복구 (로컬 구현, 운영 미검증)

- `auth.ts:authenticateUser`는 기존 로그인 ID 또는 **확인된 기본 이메일**을 받습니다. trim/소문자 이메일 정규화만 적용하고 미확인 이메일은 alias가 아닙니다. 로그인 ID와 이메일 alias가 다른 사용자로 충돌하면 실패하며, OTP 대상 여부는 문자열이 아니라 비밀번호 검증을 마친 실제 user ID로 결정합니다. 브라우저/CLI의 기존 로그인 ID 경로를 보존합니다.
- `password-reset-service.ts`, additive `228_password_reset.sql`(새 테이블/인덱스), `229_login_otp_auth_epoch.sql`(OTP 인증 버전 컬럼)이 `POST /auth/password-reset/request` 및 `POST /auth/password-reset/confirm`을 소유합니다. 활성 member/guest/viewer의 verified primary email만 대상으로 하며 admin/operator, 미확인·비활성·pending/rejected는 링크를 발급하지 않습니다. 요청 응답은 계정 존재·역할·발송 여부와 무관하게 동일한 `{ok:true}`입니다. 알려진 계정에 대한 DB 조회 및 발송은 별도로 수행되므로 timing side channel의 절대적 균등성은 보장하지 않습니다.
- 32-byte 불투명 토큰은 원문이 아니라 HMAC 해시로 DB에 저장하며 링크 유효시간은 30분입니다. IP당 1시간 최대 10건(미등록 주소 포함), 계정당 1시간 최대 3건·60초 간격입니다. 재요청은 기존 유효 링크를 무효화하지 않고 독립 링크를 만듭니다. 미수신이면 1분 뒤 다시 요청할 수 있고, 어느 한 링크가 성공하면 같은 계정의 다른 pending 링크도 취소됩니다. 확인 POST는 IP당 15분 최대 10회이고, 존재하지 않거나 만료된 토큰은 Argon2 계산 전에 거부합니다.
- 소비 transaction은 사용자→기본 identity→challenge 순서로 잠그고 역할·활성 상태·verified primary·발급 당시 `auth_epoch`·만료·일회 상태를 재확인합니다. 성공할 때 Argon2id hash, `password_changed_at`, `auth_epoch` 증가, 다른 링크·OTP·등록 capability 취소 및 감사 이벤트를 원자적으로 저장합니다. 기존 브라우저/CLI/service JWT는 epoch 비교로 차단하고 현재 프로세스의 WebSocket을 닫습니다. 다른 프로세스의 열린 WebSocket에는 기존 인증 상태 재검사/최대 5초 캐시 경계가 남습니다. 자동 로그인하지 않으며 새 로그인에는 기존 이메일 OTP 정책이 그대로 적용됩니다.
- 발송은 `password_reset` / `password_changed_notice` kind를 사용합니다. 통제된 v1 template의 HTML/text 병행 전송은 로컬 구현이며 Gateway 선행 배포 전에는 신규 요청이 거절됩니다. 메일 본문은 토큰 링크를 포함하므로 DB·로그·감사 이벤트에는 남기지 않습니다. Gateway 전용 consumer allowlist를 로컬 `work/api-router-tower/modules/account-mail-request.ts`에 추가했지만 **Gateway 배포 전에는 Gateway 경유 실제 발송이 거절**됩니다. 기존 Resend 직접 공급자 여부도 실메일로 검증하지 않았습니다. 변경 알림 실패는 성공한 비밀번호 변경을 되돌리지 않고 실패 감사 이벤트를 남깁니다.
- 격리 회귀: `password-reset-pg.integration.test.ts`는 임시 Docker PostgreSQL과 capture 메일로 alias 충돌·역할/상태/재요청/동시 소비/만료/epoch/OTP/JWT를 검증합니다. 화면은 `PasswordReset.test.tsx`, 모바일 관리 화면은 `e2e/admin-users-mobile.spec.ts` mock API fixture가 검증합니다. 운영 migration·공급자·실메일·다중 프로세스는 검증 대상이 아닙니다.

## 운영 제외

이 모듈의 존재는 실제 공급자 연결, DNS 설정, 설치 인스턴스 배포 또는 `required` 활성화를 의미하지 않습니다. 해당 작업은 별도 운영 승인과 readiness 증거가 필요합니다.

## 가입 승인과 이메일 확인

### 초대 취소 API와 회귀 검증

- `EmailInvitationManagement.run()`의 취소 요청은 `POST /api/admin/account-email-invitations/:id/cancel`입니다. `DELETE /:id` 라우트는 제공하지 않습니다. 정상 취소는 `{ ok: true }`를 반환하고 화면은 목록을 다시 불러옵니다.
- `cancelAccountEmailInvitation()`은 pending 초대만 cancelled로 변경하고 취소 시각과 감사 이벤트를 기록합니다. 취소가 먼저 완료된 토큰은 조회·수락할 수 없으며 이미 수락한 계정에는 영향을 주지 않습니다.
- `packages/frontend/src/components/admin/EmailInvitationManagement.dom.test.tsx`는 요청 경로·메서드, 취소 결과 표시, 실패 응답, 확인 거절을 검증합니다.
- `login-otp-http-pg.integration.test.ts`의 초대 취소 테스트는 실제 API 라우터와 임시 PostgreSQL로 상태 변경·감사 이벤트·취소 토큰 거부·권한 경계를 확인합니다. 실메일 대신 capture 공급자를 사용하며 운영 DB나 배포를 검증하지 않습니다.
- 실행: `npx vitest run packages/frontend/src/components/admin/EmailInvitationManagement.dom.test.tsx packages/backend/services/account-security/login-otp-http-pg.integration.test.ts --maxWorkers=1`. 통합 테스트에는 로컬 Docker와 `postgres:16-alpine` 이미지가 필요합니다.


- 이메일 초대와 기존 계정 이메일 등록·재발송·취소는 admin/operator에게 허용합니다. operator는 member/viewer/guest만 관리하며 admin/operator 대상과 해당 권한으로의 초대는 거절합니다. 초대 목록도 이 범위로 필터링합니다. API는 저장된 대상 역할을 조회하며 조회 실패 시 차단합니다. `email-management-access.ts` 및 동명 테스트가 이 위임 경계를 소유합니다. 가입 심사 승인·거절과 메일 설정은 기존 admin 전용을 유지합니다.
- 이메일 초대는 관리자의 사전 승인이며, 수락 시 서버에 저장된 이메일·역할로 활성 계정을 만듭니다.
- 관리자 직접 생성 계정은 `approved_by`와 `approved_at`으로 사전 승인을 기록하되 이메일 확인 전까지 `pending`입니다.
- 기존 계정의 이메일 확인은 메일함 접근 확인일 뿐입니다. `pending` 계정은 위 두 사전 승인 필드가 모두 존재할 때만 활성화합니다. 승인 근거가 없는 가입 신청자는 이메일이 verified여도 pending을 유지합니다.
- 이전 버전에서 만든 pending 계정 중 승인 근거가 없는 계정은 자동 소급 승인하지 않습니다. 배포 전 별도 목록 점검과 관리자 승인이 필요합니다. 기존 active 계정의 이메일 등록은 상태를 변경하지 않습니다.
- 격리 PostgreSQL 회귀 테스트: `login-otp-http-pg.integration.test.ts`에서 미승인 신청자의 상태 보존과 관리자 직접 생성 계정의 활성화를 확인합니다. 운영 DB 변경·실메일·배포 검증을 의미하지 않습니다.

## 기존 계정의 로그인 중 최초 이메일 등록

- `login-email-enrollment.ts`와 additive migration `225_login_email_enrollment.sql`이 브라우저 등록 전용 challenge를 소유합니다. 기본 `TOWER_LOGIN_EMAIL_ENROLLMENT=off`는 기존 off/pilot/required 동작을 유지합니다.
- 활성화는 `TOWER_LOGIN_EMAIL_ENROLLMENT=existing`와 고정된 숫자 `TOWER_LOGIN_EMAIL_ENROLLMENT_MAX_USER_ID`를 함께 지정해야 합니다. cutoff는 전환 시작 전 기존 계정의 최대 ID를 운영자가 확인하고 동결합니다. 미설정·잘못된 설정은 실패하며 새 계정을 만드는 API나 공개 가입을 열지 않습니다. cutoff 이후 계정은 관리자 초대·이메일 사전 확인 경로를 사용해야 합니다.
- 실제 등록 대상은 기존 비밀번호가 맞고 `disabled=0`, `approval_status=active`이며 OTP 대상(`required` 또는 pilot)에 포함되고 cutoff 이하인, verified 이메일이 없는 계정입니다. pending/rejected/suspended/disabled는 진입할 수 없습니다. 이미 verified 이메일이 있으면 기존 로그인 OTP를 사용하며 등록 기능으로 덮어쓰지 않습니다.
- `/auth/login`의 202 `enrollmentRequired + emailRequired` 응답은 짧은 수명의 opaque 등록 전용 capability이며 JWT/cookie가 아닙니다. `/auth/login/enrollment/email`로 주소를 제출하고 `/verify`에서 6자리 등록 OTP를 소비한 성공 transaction만 verified identity와 primary 연결을 만듭니다. 그 성공 HTTP 응답에서 로그인 세션을 발급하므로 첫 로그인에 추가 OTP를 중복 요구하지 않습니다. 다음 로그인부터는 일반 OTP가 필요합니다.
- `/resend`와 `/cancel`은 같은 등록 capability만 사용합니다. 등록 draft와 코드의 수명은 각각 10분이며, 코드 발송 시 새 challenge로 바꾸고 이전 capability를 폐기합니다. 5회 오답·만료·취소·동시 소비·재사용은 세션을 발급하지 않습니다. 재발송은 60초 후이며 새 비밀번호 로그인을 반복해도 계정별 cooldown을 우회할 수 없습니다. 실제 발송 시도(실패 포함)는 일반 OTP와 합산하여 계정별 15분 최대 5회로 제한합니다. 메일을 보내지 않은 draft는 quota에 세지 않습니다.
- 등록 발송·소비에서 계정 차단/승인, 현재 정책과 cutoff, 최초 비밀번호 인증 당시 `password_changed_at` 및 `auth_epoch`(migration 227), 기존 verified identity를 재검사합니다. 동일 사용자의 변경은 account row lock으로 직렬화하고 이메일 중복은 정규화 unique key로 최종 방어합니다. **같은 계정의 `pending/existing_user` identity만** 기존 예약을 유지한 채 코드를 발송·재발송하고, OTP 소비 transaction에서 해당 row를 verified/primary로 전환합니다. 다른 소유자, `verified/superseded/cancelled`, 다른 purpose, pending invitation은 거부합니다. 성공 시 이전 관리자 확인 링크는 supersede합니다. 관리자 링크 확인도 사용자→identity→challenge 순으로 잠가 동시 소비 시 한 경로만 성공합니다. 취소된 identity의 globally unique key는 자동 복원하지 않으므로 별도 관리 정책이 필요합니다.
- **10분 만료는 등록 코드/등록 capability에 적용되며 pending 이메일 identity를 자동 삭제하거나 확인하지 않습니다.** 만료된 capability로 바로 재발송할 수 없습니다. 비밀번호로 새 로그인 후 동일 pending 주소를 제출하면 새 코드를 받습니다(계정별 60초 cooldown 및 15분 5회 quota 유지). 화면에서도 만료·상태 변경 시 새 로그인을 안내합니다.
- 메일은 공용 Gateway의 `login_otp` text kind를 재사용하지만 제목·본문에 **기존 계정 이메일 등록**임을 명시합니다. OTP 원문은 메일에만 전달하고 DB에는 HMAC hash를 저장합니다. 공급자 실패 응답은 provider 오류 원문을 HTTP/감사 로그에 복사하지 않고 `delivery_failed`로 닫으며 password-only로 강등하지 않습니다.
- 비상 계정은 코드에 admin ID를 하드코딩하지 않습니다. `TOWER_LOGIN_EMAIL_OTP_EXCLUDED_USER_IDS`에 운영자가 승인한 숫자 ID를 명시해야 하며 기본값은 비어 있습니다. 이 제외 계정은 브라우저 OTP와 등록 의무 및 coverage gate에서 제외되므로 최소 수량·별도 접근 제한·비밀번호 보호가 운영 전제입니다. CLI 인증은 기존과 같습니다.
- 전환 종료(cutover)는 먼저 대상 계정 이메일 확인을 완료하고 readiness를 확인한 뒤 `TOWER_LOGIN_EMAIL_ENROLLMENT=off`로 바꿉니다. `required`는 유지해야 합니다. 등록 기능 off는 pending 등록 capability를 무효화하고 기본 100% coverage gate를 복구합니다. `TOWER_LOGIN_EMAIL_OTP=off`와 pilot 해제는 보안 요구 자체를 낮추는 별도 운영 판단이며 자동 rollback하지 않습니다.
- 검증: `login-otp-http-pg.integration.test.ts` (Docker `postgres:16-alpine`, isolated `otp_test`, loopback, capture mail)와 `LoginPage.otp-resend.test.tsx` (mock callbacks/timers)가 기본 회귀·등록 성공·첫 세션·다음 OTP·중복·취소·만료·5회 오답·quota·동시 제출/소비·비밀번호 변경·계정 차단·cutoff·제외 ID를 보호합니다. 동일 계정 pending 예약 재사용·재발송·이전 코드/관리자 링크 무효화, 다른 사용자 및 다른 상태 차단, 만료 후 새 로그인, auth_epoch 변경, 관리자 링크/OTP 경쟁도 격리 PG에서 검증합니다. 실제 공급자, 실메일, 운영 migration/flag, 브라우저 E2E 검증은 별도입니다.

## 인증 오류의 화면 언어 (로컬 구현, 운영 미검증)

서버의 인증 의미·권한·HTTP 상태·오류 코드는 변경하지 않습니다. `packages/frontend/src/utils/auth-error-message.ts`는 기존 오류 문자열과 `LOGIN_OTP_*` 코드를 화면 언어(`ko`/`en`)로 매핑합니다. 로그인·OTP·이메일 등록·가입은 `App.tsx`, 프로필·비밀번호 변경은 `components/auth/UserSelfModals.tsx`, 이메일 초대 수락은 `components/auth/AccountEmailLinkPage.tsx`에서 사용합니다. 구체적인 알려진 문자열을 넓은 오류 코드보다 먼저 적용하므로 재발송 대기·만료 안내를 구분합니다. 알 수 없는 서버/공급자 진단은 성공으로 해석하거나 그대로 표시하지 않고, 요청 실패라는 중립적인 안내로 표시합니다. 이메일 주소 사용 불가 등 기존 실패 상태 분기와 토큰 발급/저장 조건은 보존합니다.

회귀 검사: `auth-error-message.test.ts`, `App.auth-errors.source.test.ts`, `UserSelfModals.auth-errors.test.tsx`. 로컬 단위·DOM·소스 검사는 실제 OTP 공급자, 실메일, 로그인 브라우저 E2E나 배포 검증을 대체하지 않습니다.

## 계정 메일 HTML/text v1 (로컬 구현, 운영 미검증)

`mail/account-mail-template.ts`가 초대(72시간), 이메일 확인(24시간), 로그인 OTP와 등록 OTP 변형(10분), 비밀번호 재설정(30분), 변경 알림의 한국어 제목·text·테이블형 인라인 CSS HTML을 동일한 semantic fields에서 만듭니다. 외부 자산/추적 픽셀 없이 코드 또는 단일 CTA, 안전 안내, footer를 포함합니다. 직접 Resend는 렌더 결과 일치 여부를 확인하고, Gateway는 v1 `template`만 보내서 Edge에서 렌더를 다시 수행합니다. 임의 HTML/subject/text는 template와 섞어 보낼 수 없고 Gateway의 기존 text-only 요청은 계속 허용됩니다. production 링크는 canonical HTTPS origin과 URL-safe 토큰만 허용합니다. 로컬 capture 테스트의 loopback HTTP 예외는 Gateway에서 허용하지 않습니다.

선행 배포 순서와 롤백은 `work/api-router-tower/modules/account-mail-password-reset.md`를 참조합니다. Gateway와 backend template 두 사본은 version 1이며 스냅샷 동등성 검사로 불일치를 방어합니다. 검증은 로컬 synthetic fixture에 한정되며 실메일·provider 인증·렌더러별 이메일 클라이언트·운영 배포를 뜻하지 않습니다.

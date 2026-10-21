import i18n from '../i18n';

/**
 * Presentation-only boundary for account errors. Do not change server codes,
 * authentication decisions, or expose arbitrary provider/server diagnostics.
 * Exact legacy messages take precedence over broader error codes.
 */
type Copy = readonly [ko: string, en: string];
const messages: Record<string, Copy> = {
  'Invalid credentials': ['아이디 또는 이메일과 비밀번호를 확인해 주세요.', 'Check your ID or email and password.'],
  'Account is pending admin approval': ['관리자의 가입 승인을 기다리고 있습니다.', 'Your account is waiting for administrator approval.'],
  'Account has been disabled': ['사용이 중지된 계정입니다. 관리자에게 문의해 주세요.', 'Your account has been disabled. Contact your administrator.'],
  'Account disabled or inactive': ['계정을 사용할 수 없습니다. 관리자에게 문의해 주세요.', 'Your account is disabled or inactive. Contact your administrator.'],
  'Admin already exists': ['이미 관리자 계정이 있습니다. 로그인해 주세요.', 'An administrator account already exists. Please sign in.'],
  'Username and password required': ['아이디와 비밀번호를 입력해 주세요.', 'Enter your username and password.'],
  'inviteCode, username, password, displayName required': ['초대 코드, 아이디, 비밀번호와 이름을 입력해 주세요.', 'Enter your invitation code, username, password, and name.'],
  'Username, password and display name are required': ['아이디, 비밀번호와 이름을 입력해 주세요.', 'Enter your username, password, and name.'],
  'Password must be at least 8 characters': ['비밀번호는 8자 이상이어야 합니다.', 'Your password must be at least 8 characters.'],
  'New password must be at least 8 characters': ['새 비밀번호는 8자 이상이어야 합니다.', 'Your new password must be at least 8 characters.'],
  'oldPassword and newPassword required': ['현재 비밀번호와 새 비밀번호를 입력해 주세요.', 'Enter your current and new passwords.'],
  'New password must differ from current password': ['새 비밀번호는 현재 비밀번호와 달라야 합니다.', 'Your new password must differ from your current password.'],
  'Current password is incorrect': ['현재 비밀번호가 올바르지 않습니다.', 'Your current password is incorrect.'],
  'Signup by shared invite code is no longer available. Contact an administrator.': ['공유 초대 코드로는 더 이상 가입할 수 없습니다. 관리자에게 이메일 초대를 요청해 주세요.', 'Signup by shared invitation code is no longer available. Ask an administrator for an email invitation.'],
  'Enrollment resend is not available yet': ['아직 이메일 인증 코드를 재발송할 수 없습니다. 잠시 후 다시 시도해 주세요.', 'You cannot resend the email verification code yet. Try again shortly.'],
  'Email code resend is not available yet': ['아직 이메일 인증 코드를 재발송할 수 없습니다. 잠시 후 다시 시도해 주세요.', 'You cannot resend the email verification code yet. Try again shortly.'],
  'Email code send limit exceeded': ['이메일 인증 코드 발송 횟수를 초과했습니다. 잠시 후 다시 시도해 주세요.', 'The email verification code send limit has been reached. Try again later.'],
  'Account credentials changed': ['계정 인증 정보가 변경되었습니다. 다시 로그인해 주세요.', 'Your account credentials have changed. Sign in again.'],
  'Display name is required': ['이름을 입력해 주세요.', 'Enter your name.'],
  'Invalid invite code': ['초대 코드가 유효하지 않거나 사용할 수 없습니다. 관리자에게 확인해 주세요.', 'The invitation code is invalid or unavailable. Check with your administrator.'],
  'Email enrollment unavailable': ['이메일 등록 요청을 완료할 수 없습니다. 다시 로그인해 주세요.', 'This email enrollment request cannot be completed. Sign in again.'],
  'Invite code is required': ['초대 코드를 입력해 주세요.', 'Enter your invitation code.'],
  'Invite code is invalid or expired': ['초대 코드가 유효하지 않거나 만료되었습니다. 관리자에게 확인해 주세요.', 'The invitation code is invalid or expired. Check with your administrator.'],
  'Enter a valid email address': ['올바른 이메일 주소를 입력해 주세요.', 'Enter a valid email address.'],
  'Email must be a string': ['올바른 이메일 주소를 입력해 주세요.', 'Enter a valid email address.'],
  'Email address is unavailable': ['이 이메일 주소는 사용할 수 없습니다. 다른 주소를 입력해 주세요.', 'This email address is unavailable. Enter a different address.'],
  'Invalid OTP': ['인증 코드가 올바르지 않습니다.', 'The verification code is incorrect.'],
  'OTP resend is not available yet': ['아직 인증 코드를 재발송할 수 없습니다. 잠시 후 다시 시도해 주세요.', 'You cannot resend the verification code yet. Try again shortly.'],
  'OTP send limit exceeded': ['인증 코드 발송 횟수를 초과했습니다. 잠시 후 다시 시도해 주세요.', 'The verification code send limit has been reached. Try again later.'],
  'Too many attempts. Try again later.': ['시도 횟수를 초과했습니다. 잠시 후 다시 시도해 주세요.', 'Too many attempts. Try again later.'],
  'Too many auth attempts. Try again later.': ['인증 시도 횟수를 초과했습니다. 잠시 후 다시 시도해 주세요.', 'Too many authentication attempts. Try again later.'],
  'Too many login attempts. Try again later.': ['로그인 시도 횟수를 초과했습니다. 잠시 후 다시 시도해 주세요.', 'Too many login attempts. Try again later.'],
  'Too many OTP attempts. Try again later.': ['인증 코드 확인 시도 횟수를 초과했습니다. 잠시 후 다시 시도해 주세요.', 'Too many verification code attempts. Try again later.'],
  'OTP challenge expired': ['인증 코드가 만료되었습니다. 다시 로그인해 주세요.', 'The verification code has expired. Sign in again.'],
  'OTP attempt limit exceeded': ['인증 코드 확인 시도 횟수를 초과했습니다. 다시 로그인해 주세요.', 'Too many verification code attempts. Sign in again.'],
  'OTP challenge cannot be used': ['이 인증 요청은 더 이상 사용할 수 없습니다. 다시 로그인해 주세요.', 'This verification request can no longer be used. Sign in again.'],
  'Enrollment expired': ['이메일 확인 요청이 만료되었습니다. 다시 로그인해 주세요.', 'The email verification request has expired. Sign in again.'],
  'Enrollment attempt limit exceeded': ['이메일 확인 시도 횟수를 초과했습니다. 다시 로그인해 주세요.', 'Too many email verification attempts. Sign in again.'],
  'Credential changed; login again': ['계정 인증 정보가 변경되었습니다. 다시 로그인해 주세요.', 'Your account credentials have changed. Sign in again.'],
  'Account identity changed; login again': ['계정 정보가 변경되었습니다. 다시 로그인해 주세요.', 'Your account identity has changed. Sign in again.'],
  'This reset link is invalid or expired. Request a new one.': ['비밀번호 재설정 링크가 유효하지 않거나 만료되었습니다. 새 링크를 요청해 주세요.', 'This reset link is invalid or expired. Request a new one.'],
  'Authentication state unavailable': ['현재 계정 인증 상태를 확인할 수 없습니다. 잠시 후 다시 시도해 주세요.', 'Your authentication status is unavailable. Try again shortly.'],
  'Token invalidated by credential change': ['계정 인증 정보가 변경되었습니다. 다시 로그인해 주세요.', 'Your account credentials have changed. Sign in again.'],
  'No token provided': ['로그인이 필요합니다. 다시 로그인해 주세요.', 'Sign in to continue.'],
  'Invalid token': ['로그인 정보를 확인할 수 없습니다. 다시 로그인해 주세요.', 'Your sign-in information is invalid. Sign in again.'],
  'Token revoked': ['로그인이 해제되었습니다. 다시 로그인해 주세요.', 'Your sign-in authorization has been revoked. Sign in again.'],
  'displayName must be a string': ['이름을 올바르게 입력해 주세요.', 'Enter a valid name.'],
  'affiliation must be a string': ['소속을 올바르게 입력해 주세요.', 'Enter a valid affiliation.'],
  'language must be en, ko, or null': ['사용할 언어를 다시 선택해 주세요.', 'Select your language again.'],
  'No fields to update': ['변경할 정보를 입력해 주세요.', 'Enter the information you want to change.'],
};

const codes: Record<string, Copy> = {
  INVALID_ACCOUNT_EMAIL: messages['Enter a valid email address'],
  LOGIN_OTP_INVALID: messages['Invalid OTP'],
  LOGIN_OTP_NOT_READY: ['이메일 인증을 사용할 준비가 되지 않았습니다. 관리자에게 문의해 주세요.', 'Email verification is not ready. Contact your administrator.'],
  LOGIN_OTP_DELIVERY: ['인증 코드를 보내지 못했습니다. 잠시 후 다시 시도해 주세요.', 'The verification code could not be sent. Try again shortly.'],
  LOGIN_OTP_NOT_FOUND: ['진행 중인 인증 요청을 찾을 수 없습니다. 다시 로그인해 주세요.', 'The pending verification request was not found. Sign in again.'],
  LOGIN_OTP_STATE: ['이 인증 요청을 완료할 수 없습니다. 다시 로그인해 주세요.', 'This verification request cannot be completed. Sign in again.'],
  LOGIN_OTP_RATE_LIMIT: messages['Too many OTP attempts. Try again later.'],
};

const fallback: Copy = ['요청을 처리하지 못했습니다. 잠시 후 다시 시도해 주세요.', 'The request could not be completed. Try again shortly.'];

/** Accept only recognized server messages/codes; unknown details become a neutral failure. */
export function authErrorMessage(error: unknown, code?: unknown, language = i18n.resolvedLanguage || i18n.language || 'ko'): string {
  const message = typeof error === 'string' ? error : '';
  let copy = Object.hasOwn(messages, message) ? messages[message] : undefined;
  if (!copy && /^Username '[^'\r\n]*' is already taken$/.test(message)) {
    copy = ['이미 사용 중인 아이디입니다. 다른 아이디를 입력해 주세요.', 'This username is already taken. Choose another username.'];
  }
  if (!copy && /^Invalid username '[^'\r\n]*'\. Must match \/\^\[a-z0-9\]\[a-z0-9\._-\]\{1,39\}\$\/ \(lowercase, digits, \._-, 2-40 chars\)\.$/.test(message)) {
    copy = ['아이디는 영문 소문자나 숫자로 시작하며, 소문자·숫자·마침표·밑줄·하이픈을 사용해 2~40자로 입력해야 합니다.', 'Use 2–40 lowercase letters, digits, dots, underscores, or hyphens, starting with a letter or digit.'];
  }
  if (!copy && typeof code === 'string' && Object.hasOwn(codes, code)) copy = codes[code];
  return (copy || fallback)[language.toLowerCase().split(/[-_]/)[0] === 'en' ? 1 : 0];
}

export type LoginEmailOtpPolicy = 'off' | 'required';

export function parseLoginEmailOtpPolicy(value: string | undefined): LoginEmailOtpPolicy {
  const policy = value?.trim() || 'off';
  if (policy !== 'off' && policy !== 'required') {
    throw new Error(`TOWER_LOGIN_EMAIL_OTP must be off or required, received: ${policy}`);
  }
  return policy;
}

export function parseLoginOtpPilotUserIds(value: string | undefined): ReadonlySet<number> {
  if (!value?.trim()) return new Set();
  const ids = value.split(',').map(part => part.trim());
  if (ids.some(id => !/^[1-9]\d*$/.test(id) || !Number.isSafeInteger(Number(id)))) {
    throw new Error('TOWER_LOGIN_EMAIL_OTP_PILOT_USER_IDS must contain positive integer user IDs');
  }
  return new Set(ids.map(Number));
}

export function loginEmailEnrollmentCutoff(env: NodeJS.ProcessEnv = process.env): number {
  const mode = env.TOWER_LOGIN_EMAIL_ENROLLMENT?.trim() || 'off';
  if (mode !== 'off' && mode !== 'existing') throw new Error('TOWER_LOGIN_EMAIL_ENROLLMENT must be off or existing');
  if (mode === 'off') return 0;
  const cutoff = env.TOWER_LOGIN_EMAIL_ENROLLMENT_MAX_USER_ID;
  if (!cutoff || !/^[1-9]\d*$/.test(cutoff) || !Number.isSafeInteger(Number(cutoff))) {
    throw new Error('TOWER_LOGIN_EMAIL_ENROLLMENT_MAX_USER_ID must be an existing positive integer cutoff');
  }
  return Number(cutoff);
}

export function enrollmentEnabledFor(userId: number, env: NodeJS.ProcessEnv = process.env): boolean {
  return userId <= loginEmailEnrollmentCutoff(env);
}

export function requiresBrowserLoginOtp(userId: number, env: NodeJS.ProcessEnv = process.env): boolean {
  const policy = parseLoginEmailOtpPolicy(env.TOWER_LOGIN_EMAIL_OTP);
  if (parseLoginOtpPilotUserIds(env.TOWER_LOGIN_EMAIL_OTP_EXCLUDED_USER_IDS).has(userId)) return false;
  return policy === 'required' || parseLoginOtpPilotUserIds(env.TOWER_LOGIN_EMAIL_OTP_PILOT_USER_IDS).has(userId);
}

export function getAccountSecurityConfig(env: NodeJS.ProcessEnv = process.env) {
  return {
    loginEmailOtpPolicy: parseLoginEmailOtpPolicy(env.TOWER_LOGIN_EMAIL_OTP),
    pepperConfigured: Boolean(env.TOWER_ACCOUNT_SECURITY_PEPPER),
    mailProvider: env.TOWER_MAIL_PROVIDER || '',
    mailFrom: env.TOWER_MAIL_FROM || '',
    mailReplyTo: env.TOWER_MAIL_REPLY_TO || '',
  };
}

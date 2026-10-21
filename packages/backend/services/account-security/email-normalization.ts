const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_EMAIL_LENGTH = 320;

export class AccountEmailValidationError extends Error {
  readonly code = 'INVALID_ACCOUNT_EMAIL';
}

export function normalizeAccountEmail(value: unknown): { email: string; normalized: string } {
  if (typeof value !== 'string') throw new AccountEmailValidationError('Email must be a string');
  const email = value.trim();
  if (!email || email.length > MAX_EMAIL_LENGTH || !EMAIL_PATTERN.test(email)) {
    throw new AccountEmailValidationError('Enter a valid email address');
  }
  return { email, normalized: email.toLowerCase() };
}

export function maskAccountEmail(value: string): string {
  const { email } = normalizeAccountEmail(value);
  const at = email.lastIndexOf('@');
  const local = email.slice(0, at);
  const domain = email.slice(at + 1);
  const visible = local.slice(0, Math.min(1, local.length));
  return `${visible}${'*'.repeat(Math.max(3, local.length - visible.length))}@${domain}`;
}

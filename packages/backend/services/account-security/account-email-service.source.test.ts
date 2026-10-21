import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const service = readFileSync(new URL('./account-email-service.ts', import.meta.url), 'utf8');
const routes = readFileSync(new URL('../../routes/api.ts', import.meta.url), 'utf8');
const migration = readFileSync(new URL('../../db/migrations/217_account_email_security.sql', import.meta.url), 'utf8');

describe('account email phase-one source contracts', () => {
  it('stores only invitation and verification token hashes', () => {
    expect(migration).toContain('token_hash TEXT NOT NULL UNIQUE');
    expect(migration).not.toMatch(/token_plain|otp_plain|password_plain.*account_email/i);
    expect(service).toContain('hashAccountSecret(token, pepper())');
  });

  it('requires the user to consume a verification link before an existing email becomes verified', () => {
    expect(service).toContain("VALUES ($1,$2,$3,'pending','existing_user'");
    expect(service).toContain("SET state='verified',verified_at=NOW()");
    expect(service).toContain("status='consumed',consumed_at=NOW()");
  });

  it('does not leave an existing account pending when verification delivery fails', () => {
    const existing = service.slice(service.indexOf('export async function registerExistingUserEmail'), service.indexOf('export async function cancelPendingExistingUserEmail'));
    expect(existing.match(/status='delivery_failed'/g)).toHaveLength(2);
    expect(existing.match(/SET state='cancelled',updated_at=NOW\(\)/g)).toHaveLength(3);
    expect(existing).toContain("status IN ('consumed','pending')");
    expect(existing).toContain("throw new AccountEmailDeliveryError");
  });

  it('reuses the same account identity on retry without allowing another account to claim it', () => {
    const registration = service.slice(service.indexOf('export async function registerExistingUserEmail'), service.indexOf('export async function resendExistingUserEmail'));
    expect(registration).toContain('WHERE email_normalized=$1 FOR UPDATE');
    expect(registration).toContain("existing.user_id !== input.userId || existing.state === 'verified'");
    expect(registration).toContain("UPDATE account_email_identities SET email=$2,state='pending'");
    expect(registration).toContain("WHERE email_identity_id=$1 AND status='pending'");
    expect(registration.indexOf('getAccountMailProvider().checkConnection()')).toBeLessThan(registration.indexOf('const created = await transaction'));
  });

  it('keeps admin email management separate from generic user profile updates', () => {
    expect(routes).toContain("'/admin/users/:id/account-email'");
    expect(routes).toContain("'/admin/users/:id/account-email/resend'");
    expect(routes).toContain("'/admin/users/:id/account-email/pending'");
  });

  it('binds invitation acceptance to the server-side invitation email and role', () => {
    expect(routes).toContain("'/auth/account-invitation/:token/accept'");
    expect(routes).not.toContain('acceptAccountEmailInvitation({ token: req.params.token as string, email');
    expect(service).toContain("invite.email, invite.email_normalized");
    expect(service).toContain('invite.role');
  });

  it('requires email-backed admin creation', () => {
    expect(routes).toContain("if (!username || !password) return res.status(400).json({ error: 'username and password required' });");
    expect(routes).toContain('email, passwordConfirm, and displayName are required for new accounts');
    expect(routes).not.toContain("const user = await createUser(username, password, role || 'member'");
    expect(service).toContain("VALUES ($1,$2,$3,$4,$5,'pending',NOW(),$6,NOW())");
    expect(service).toContain("AND approved_by IS NOT NULL AND approved_at IS NOT NULL");
    expect(service).toContain("if (input.password !== input.passwordConfirm)");
  });

  it('checks mail readiness before creating an email-managed account',()=>{
    const readinessCheck=service.indexOf('const mailReadiness=await getAccountMailProvider().checkConnection()');
    const transactionStart=service.indexOf('const created=await transaction',readinessCheck);
    expect(readinessCheck).toBeGreaterThan(-1);
    expect(transactionStart).toBeGreaterThan(readinessCheck);
    expect(service.slice(readinessCheck,transactionStart)).toContain("throw new AccountEmailDeliveryError('Account mail provider is not ready')");
  });
});

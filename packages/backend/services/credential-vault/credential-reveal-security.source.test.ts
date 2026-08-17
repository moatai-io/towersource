import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const service = readFileSync(new URL('./credential-reveal-service.ts', import.meta.url), 'utf8');
const route = readFileSync(new URL('../../routes/credential-vault-api.ts', import.meta.url), 'utf8');
const migration = readFileSync(new URL('../../db/migrations/156_credential_reveal_challenges.sql', import.meta.url), 'utf8');

describe('credential reveal security contract', () => {
  it('binds challenge consumption and rejects expired, reused, or mismatched targets', () => {
    expect(service).toContain('challenge.actor_user_id === input.actorUserId');
    expect(service).toContain('challenge.credential_id === input.credentialId');
    expect(service).toContain('challenge.field_id === input.fieldId');
    expect(service).toContain('challenge.purpose === input.purpose');
    expect(service).toContain('challenge.mode === input.mode');
    expect(service).toContain("challenge.status === 'pending'");
    expect(service).toContain('new Date(challenge.expires_at).getTime() > Date.now()');
    expect(service).toContain("WHERE id = $1 AND status = 'pending' AND consumed_at IS NULL AND expires_at > now()");
  });

  it('limits challenge creation and failed password attempts', () => {
    expect(service).toContain("created_at > now() - interval '1 minute'");
    expect(service).toContain("created_at > now() - interval '15 minutes'");
    expect(service).toContain('coalesce(sum(failed_attempts), 0)');
    expect(service).toContain('failed_attempts + 1 >= 3');
  });

  it('allows reveal only through an active Admin session while compare keeps password step-up', () => {
    const revealRoute = route.slice(route.indexOf("router.post('/credentials/:credentialId/reveal'"), route.indexOf("router.post('/credentials/:credentialId/compare'"));
    const compareRoute = route.slice(route.indexOf("router.post('/credentials/:credentialId/compare'"));
    expect(revealRoute).toContain('const allowed = assertAdmin(req)');
    expect(revealRoute).toContain('revealCredentialFieldAsAdmin({');
    expect(revealRoute).not.toContain("bodyRawString(req, 'password')");
    expect(revealRoute).not.toContain('challengeId');
    expect(compareRoute).toContain("bodyRawString(req, 'password')");
    expect(service).toContain("authorization: 'active_admin_session'");
  });

  it('keeps sensitive request fields out of migration and audit metadata', () => {
    expect(migration).not.toMatch(/secret_value|password|candidate/i);
    expect(service).not.toMatch(/targetRef:\s*\{[^}]*\b(?:password|candidate|value)\b/s);
    expect(route).toContain("res.setHeader('Cache-Control', 'no-store, private')");
    expect(route).toContain("res.setHeader('Pragma', 'no-cache')");
  });
});

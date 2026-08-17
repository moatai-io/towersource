import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const api = readFileSync(new URL('../../routes/api.ts', import.meta.url), 'utf8');
const admin = readFileSync(new URL('../../../frontend/src/components/admin/AdminPanel.tsx', import.meta.url), 'utf8');

describe('Google OAuth production preflight contract', () => {
  it('has exactly two supported OAuth start routes and one audience-routed callback', () => {
    expect(api.match(/router\.get\('\/auth\/google\/agent'/g)).toHaveLength(1);
    expect(api.match(/router\.get\('\/auth\/google\/organization'/g)).toHaveLength(1);
    expect(api.match(/router\.get\('\/auth\/google\/callback'/g)).toHaveLength(1);
    expect(api).toContain("payload?.aud === 'google-agent-oauth-state'");
    expect(api).toContain("payload?.aud === 'google-organization-oauth-state'");
  });

  it('requires explicit create or reauth mode for organization OAuth', () => {
    const route = api.slice(api.indexOf("router.get('/auth/google/organization'"), api.indexOf("router.get('/auth/google/callback'"));
    expect(route).toContain("req.query.mode === 'reauth'");
    expect(route).toContain("req.query.mode === 'create'");
    expect(route).toContain('mode must be create or reauth');
  });

  it('exposes only organization OAuth in global Admin Connection creation', () => {
    expect(admin).toContain("const query = credentialId ? `?mode=reauth&credentialId=");
    expect(admin).toContain(": '?mode=create'");
    expect(admin).not.toContain('기존 개인 OAuth provider 상태 보기');
    expect(admin).not.toContain("isPersonalCredentialMode ? '로그인 계정' : '내 Google Workspace 연결'");
  });

  it('returns provider errors without exposing raw callback errors in the URL', () => {
    const callback = api.slice(api.indexOf("router.get('/auth/google/callback'"), api.indexOf('// Telegram Bot Linking'));
    expect(callback).toContain('message=oauth_callback_failed');
    expect(callback).not.toContain('encodeURIComponent(err.message)');
  });
});

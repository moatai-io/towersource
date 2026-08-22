import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const source = fs.readFileSync(path.resolve(import.meta.dirname, './google-oauth.ts'), 'utf8');
const api = fs.readFileSync(path.resolve(import.meta.dirname, '../../routes/api.ts'), 'utf8');

describe('self-host Google OAuth readiness contract', () => {
  it('requires a configured client, a secure callback, and an exact PUBLIC_URL callback', () => {
    expect(source).toContain('configured && secureRedirect && redirectMatchesPublicUrl');
    expect(source).toContain("parsed.protocol === 'https:'");
    expect(source).toContain("`${publicUrl}/api/auth/google/callback`");
    expect(source).toContain("'client_not_configured'");
    expect(source).toContain("'https_required'");
    expect(source).toContain("'redirect_uri_mismatch'");
  });

  it('allows HTTP only for local development loopback callbacks', () => {
    expect(source).toContain("hostname === 'localhost'");
    expect(source).toContain("hostname === '127.0.0.1'");
    expect(source).toContain("parsed.protocol === 'http:' && isLoopbackHostname(parsed.hostname)");
  });

  it('does not expose OAuth client credentials through the readiness route', () => {
    const route = api.slice(api.indexOf("router.get('/auth/google/readiness'"), api.indexOf("router.get('/auth/google/agent'"));
    expect(route).toContain('expectedRedirectUri: readiness.expectedRedirectUri');
    expect(route).not.toContain('googleClientId');
    expect(route).not.toContain('googleClientSecret');
    expect(route).not.toContain('redirectUri: readiness.redirectUri');
  });
});

import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';

const source = fs.readFileSync(path.join(__dirname, 'api.ts'), 'utf8');

describe('Google OAuth state contract', () => {
  it('uses short-lived audience-scoped state for Agent and organization connections', () => {
    expect(source).toContain("aud: 'google-agent-oauth-state', expiresIn: '10m'");
    expect(source).toContain("aud: 'google-organization-oauth-state', expiresIn: '10m'");
    expect(source).toContain('userId: user.userId');
    expect(source).toContain('username: user.username');
    expect(source).toContain('role: user.role');
    expect(source).not.toContain('getGoogleAuthUrl(rawToken');
  });

  it('accepts only the dedicated Agent or organization OAuth callback audience', () => {
    expect(source).toContain("payload?.aud === 'google-agent-oauth-state'");
    expect(source).toContain("payload?.aud === 'google-organization-oauth-state'");
    expect(source).toContain('!isAgentFlow && !isOrganizationFlow');
    expect(source).toContain('invalid_or_expired_state');
  });

  it('reports unavailable server configuration as a service readiness failure', () => {
    expect(source).toContain("res.status(503).json({ error: 'Google OAuth is not configured on this Tower server' })");
  });
});

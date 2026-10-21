import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const manager = readFileSync(new URL('./runtime-box-manager.ts', import.meta.url), 'utf8');

describe('GWS profile selection contract', () => {
  it('does not fall back to another credential kind when personal was requested', () => {
    expect(manager).toContain('if (wantsPersonal || isAuthLogin)');
    expect(manager).toContain('AGENT_GWS_CONNECTION_REQUIRED');
  });

  it('does not fall back to another credential kind when finance was requested', () => {
    expect(manager).toContain('if (!encodedConfig && wantsFinance && !isAuthLogin)');
    expect(manager).toContain('FINANCE_CREDENTIAL_NOT_AVAILABLE');
  });

  it('requires a project-selected Connection instead of silently falling back to personal', () => {
    expect(manager).toContain('if (!encodedConfig && !wantsPersonal && !wantsFinance && !isAuthLogin)');
    expect(manager).toContain('const selected = await selectProjectGwsConnection');
    expect(manager).toContain('PROJECT_GWS_CREDENTIAL_NOT_AVAILABLE');
    expect(manager).not.toContain('if (!encodedConfig && !wantsPersonal && !wantsFinance) {\n    try {\n      encodedConfig = await getSecret(GWS_PERSONAL_CONFIG_SECRET_NAME, opts.userId)');
  });

  it('never materializes requester-personal credentials into the Agent runtime', () => {
    expect(manager).not.toContain('getSecret(GWS_PERSONAL_CONFIG_SECRET_NAME, opts.userId)');
    expect(manager).not.toContain('oauthManager.getValidToken(opts.userId, \'google\')');
    expect(manager).toContain('withRuntimeBoxTowerIdentityEnv(env, req.userId)');
  });
});

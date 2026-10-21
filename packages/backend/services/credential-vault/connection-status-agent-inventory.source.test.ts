import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

const reliability = readFileSync(new URL('./connection-reliability.ts', import.meta.url), 'utf8');
const tool = readFileSync(new URL('../../engines/pi-connection-status-tool.ts', import.meta.url), 'utf8');

describe('connection_status effective Credential inventory contract', () => {
  it('discovers every shared Credential and current-Agent dedicated Credential', () => {
    expect(reliability).toContain("c.scope = 'workspace'");
    expect(reliability).toContain("c.scope = 'project' AND c.project_id = $1");
    expect(reliability).not.toContain('project_credential_policies');
  });

  it('separates Runtime materialization from Provider auth without returning env values', () => {
    expect(reliability).toContain('resolveRuntimeBoxApiKeyEnv');
    expect(reliability).toContain('runtime.injected.map(item => item.credentialId)');
    expect(reliability).toContain("reasonCode: 'MaterializationFailed'");
    expect(reliability).toContain("reasonCode: invalidHiggsfield ? 'InvalidCredential' : 'ProviderAuthUnverified'");
    expect(reliability).not.toContain('runtime.env');
  });

  it('marks complete team/Agent coverage and warns against save-failure inference', () => {
    expect(reliability).toContain("coverage: 'team-shared-and-agent-dedicated'");
    expect(tool).toContain('not proof that saving failed');
    expect(tool).toContain('verify Runtime materialization before suggesting re-entry');
  });
});

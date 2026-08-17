import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

const reliability = readFileSync(new URL('./connection-reliability.ts', import.meta.url), 'utf8');
const tool = readFileSync(new URL('../../engines/pi-connection-status-tool.ts', import.meta.url), 'utf8');

describe('connection_status Agent Credential inventory contract', () => {
  it('discovers current-project Agent API credentials instead of relying only on a provider allowlist', () => {
    expect(reliability).toContain('diagnoseAgentBoundCredentials');
    expect(reliability).toContain("c.scope = 'project'");
    expect(reliability).toContain("c.kind = 'api_key'");
    expect(reliability).toContain("c.metadata->>'connection_type' = 'agent'");
    expect(reliability).toContain("c.metadata->>'agent_project_id' = $1");
    expect(reliability).toContain('p.credential_id = c.id AND p.project_id = $1');
  });

  it('uses secret-free resolver metadata and separates Runtime materialization from Provider auth', () => {
    expect(reliability).toContain('resolveRuntimeBoxApiKeyEnv');
    expect(reliability).toContain('runtime.injected.map(item => item.credentialId)');
    expect(reliability).toContain("reasonCode: 'MaterializationFailed'");
    expect(reliability).toContain("nextAction: 'inspect'");
    expect(reliability).toContain("reasonCode: 'ProviderAuthUnverified'");
    expect(reliability).toContain("nextAction: 'test'");
    expect(reliability).not.toContain('runtime.env');
  });

  it('marks the returned inventory coverage and forbids save-failure inference from absence', () => {
    expect(tool).toContain('diagnoseProjectConnectionStatus');
    expect(reliability).toContain('inventoryComplete: true');
    expect(reliability).toContain("coverage: 'known-and-agent-bound'");
    expect(tool).toContain('not proof that saving failed');
    expect(tool).toContain('verify Runtime materialization before suggesting re-entry');
  });
});

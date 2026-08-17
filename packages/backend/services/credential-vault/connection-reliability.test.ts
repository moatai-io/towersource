import { beforeEach, describe, expect, it, vi } from 'vitest';

const query = vi.fn();
const queryOne = vi.fn();
const resolveProjectCredentialSecretValue = vi.fn();
const resolveRuntimeBoxApiKeyEnv = vi.fn();
vi.mock('../../db/pg-repo.js', () => ({ query, queryOne }));
vi.mock('./credential-vault-service.js', () => ({ resolveProjectCredentialSecretValue, resolveRuntimeBoxApiKeyEnv }));

const { diagnoseProjectConnections, diagnoseProjectConnectionStatus } = await import('./connection-reliability.js');
const completeInventory = [
  { id: 'new-higgsfield-id', enabled: true, default_env_name: 'HIGGSFIELD_API_KEY_ID' },
  { id: 'new-higgsfield-secret', enabled: true, default_env_name: 'HIGGSFIELD_API_KEY_SECRET' },
];

function mockQueries(agentCredentials: any[] = [], gwsCredentials: any[] = []) {
  query.mockImplementation(async (sql: string) => {
    if (sql.includes("c.provider = 'higgsfield'")) return completeInventory;
    if (sql.includes("c.kind = 'gws'")) return gwsCredentials;
    return agentCredentials;
  });
}

describe('connection reliability diagnostics', () => {
  beforeEach(() => {
    query.mockReset();
    queryOne.mockReset();
    resolveProjectCredentialSecretValue.mockReset();
    resolveRuntimeBoxApiKeyEnv.mockReset();
  });

  it('reports only Agent-allowed GWS Connections instead of assuming a fixed default id', async () => {
    queryOne.mockImplementation(async (sql: string, params: any[]) => sql.includes('workspace_credentials') ? { id: params[0], enabled: true } : null);
    mockQueries();
    resolveProjectCredentialSecretValue.mockImplementation(async (input: any) => input.credentialId === 'agent-store-default' ? { value: 'hidden', credentialId: input.credentialId } : null);
    resolveRuntimeBoxApiKeyEnv.mockResolvedValue({ env: {}, injected: [], skippedExisting: [], skipped: [] });
    const result = await diagnoseProjectConnections({ projectId: 'p1', userId: 7 });
    expect(result.find(item => item.capability === 'google_workspace')).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain('hidden');
  });

  it('requires the complete Higgsfield cloud pair by target contract, not legacy credential ids', async () => {
    queryOne.mockResolvedValue({ id: 'available', enabled: true });
    mockQueries();
    resolveProjectCredentialSecretValue.mockResolvedValue({ value: 'hidden', credentialId: 'x' });
    resolveRuntimeBoxApiKeyEnv.mockResolvedValue({ env: {}, injected: [{ credentialId: 'new-higgsfield-id', envName: 'HIGGSFIELD_API_KEY_ID' }], skippedExisting: [], skipped: [] });
    const result = await diagnoseProjectConnections({ projectId: 'p1', userId: 7 });
    expect(result.find(item => item.capability === 'video_generation')).toMatchObject({ status: 'needs_attention', stoppedAt: 'project_access', reasonCode: 'ProjectAccessRequired' });
  });

  it('turns observed Higgsfield 401 evidence into a non-retryable auth action', async () => {
    queryOne.mockResolvedValue({ id: 'available', enabled: true });
    mockQueries();
    resolveProjectCredentialSecretValue.mockResolvedValue({ value: 'hidden', credentialId: 'x' });
    resolveRuntimeBoxApiKeyEnv.mockResolvedValue({ env: {}, injected: [
      { credentialId: 'new-higgsfield-id', envName: 'HIGGSFIELD_API_KEY_ID' },
      { credentialId: 'new-higgsfield-secret', envName: 'HIGGSFIELD_API_KEY_SECRET' },
    ], skippedExisting: [], skipped: [] });
    const result = await diagnoseProjectConnections({ projectId: 'p1', userId: 7, providerEvidence: { higgsfieldInvalidCredential: true } });
    expect(result.find(item => item.capability === 'video_generation')).toMatchObject({ status: 'needs_attention', stoppedAt: 'provider_auth', reasonCode: 'InvalidCredential', nextAction: 'reauth' });
  });

  it('includes a newly saved generic Agent Credential and separates materialization from Provider auth', async () => {
    queryOne.mockResolvedValue({ id: 'available', enabled: true });
    mockQueries([{ id: 'neon-api-key', provider: 'neon', display_name: 'Neon API Key', metadata: { connection_type: 'agent', agent_project_id: 'p1' }, mode: 'allow' }]);
    resolveProjectCredentialSecretValue.mockResolvedValue({ value: 'hidden', credentialId: 'x' });
    resolveRuntimeBoxApiKeyEnv.mockResolvedValue({
      env: { NEON_API_KEY: 'must-not-escape' },
      injected: [{ credentialId: 'neon-api-key', envName: 'NEON_API_KEY' }],
      skippedExisting: [],
      skipped: [],
    });

    const result = await diagnoseProjectConnectionStatus({ projectId: 'p1', userId: 7 });
    expect(result).toMatchObject({ inventoryComplete: true, coverage: 'known-and-agent-bound' });
    expect(result.connections.find(item => item.connectionId === 'neon-api-key')).toMatchObject({
      status: 'unverified',
      stoppedAt: 'provider_health',
      reasonCode: 'ProviderAuthUnverified',
      nextAction: 'test',
      stages: [
        { stage: 'inventory', status: 'pass' },
        { stage: 'project_access', status: 'pass' },
        { stage: 'materialization', status: 'pass' },
        { stage: 'provider_health', status: 'unknown' },
      ],
    });
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain('must-not-escape');
    expect(serialized).not.toContain('NEON_API_KEY');
  });

  it('does not tell the user to re-enter a stored and bound Credential when materialization is missing', async () => {
    queryOne.mockResolvedValue({ id: 'available', enabled: true });
    mockQueries([{ id: 'neon-api-key', provider: 'neon', display_name: 'Neon API Key', metadata: { connection_type: 'agent', agent_project_id: 'p1' }, mode: 'allow' }]);
    resolveProjectCredentialSecretValue.mockResolvedValue({ value: 'hidden', credentialId: 'x' });
    resolveRuntimeBoxApiKeyEnv.mockResolvedValue({ env: {}, injected: [], skippedExisting: [], skipped: [] });

    const result = await diagnoseProjectConnections({ projectId: 'p1', userId: 7 });
    expect(result.find(item => item.connectionId === 'neon-api-key')).toMatchObject({
      status: 'needs_attention',
      stoppedAt: 'materialization',
      reasonCode: 'MaterializationFailed',
      nextAction: 'inspect',
    });
  });
});

import { beforeEach, describe, expect, it, vi } from 'vitest';

const query = vi.fn();
const resolveProjectCredentialSecretValue = vi.fn();
const resolveRuntimeBoxApiKeyEnv = vi.fn();
const resolveRuntimeBoxCredentialFileMaterialization = vi.fn();
vi.mock('../../db/pg-repo.js', () => ({ query }));
vi.mock('./credential-vault-service.js', () => ({ resolveProjectCredentialSecretValue, resolveRuntimeBoxApiKeyEnv, resolveRuntimeBoxCredentialFileMaterialization }));

const { diagnoseProjectConnections, diagnoseProjectConnectionStatus } = await import('./connection-reliability.js');

describe('connection reliability diagnostics', () => {
  beforeEach(() => {
    query.mockReset();
    resolveProjectCredentialSecretValue.mockReset();
    resolveRuntimeBoxApiKeyEnv.mockReset();
    resolveRuntimeBoxCredentialFileMaterialization.mockReset();
    resolveRuntimeBoxCredentialFileMaterialization.mockResolvedValue({ materialize: [], skipped: [] });
  });

  it('reports complete team-shared and current-Agent inventory without secret values', async () => {
    query.mockResolvedValue([
      { id: 'shared-key', provider: 'openai', kind: 'api_key', display_name: 'Shared OpenAI', metadata: {}, scope: 'workspace' },
      { id: 'agent-key', provider: 'neon', kind: 'api_key', display_name: 'Agent Neon', metadata: { agent_project_id: 'p1' }, scope: 'project' },
    ]);
    resolveRuntimeBoxApiKeyEnv.mockResolvedValue({ env: { OPENAI_API_KEY: 'must-not-escape' }, injected: [{ credentialId: 'shared-key', envName: 'OPENAI_API_KEY' }, { credentialId: 'agent-key', envName: 'NEON_API_KEY' }], skippedExisting: [], skipped: [] });

    const result = await diagnoseProjectConnectionStatus({ projectId: 'p1', userId: 7 });
    expect(result).toMatchObject({ inventoryComplete: true, coverage: 'team-shared-and-agent-dedicated' });
    expect(result.connections.map(item => item.connectionId)).toEqual(['shared-key', 'agent-key']);
    expect(JSON.stringify(result)).not.toContain('must-not-escape');
    expect(JSON.stringify(result)).not.toContain('OPENAI_API_KEY');
  });

  it('marks missing Runtime materialization for inspection rather than credential re-entry', async () => {
    query.mockResolvedValue([{ id: 'agent-key', provider: 'neon', kind: 'api_key', display_name: 'Agent Neon', metadata: { agent_project_id: 'p1' }, scope: 'project' }]);
    resolveRuntimeBoxApiKeyEnv.mockResolvedValue({ env: {}, injected: [], skippedExisting: [], skipped: [{ credentialId: 'agent-key', reason: 'secret unavailable' }] });
    const result = await diagnoseProjectConnections({ projectId: 'p1', userId: 7 });
    expect(result[0]).toMatchObject({ status: 'needs_attention', stoppedAt: 'materialization', reasonCode: 'MaterializationFailed', nextAction: 'inspect' });
  });

  it('recognizes SSH private keys materialized as temporary path files without exposing values', async () => {
    query.mockResolvedValue([{ id: 'router-ssh', provider: 'ssh', kind: 'api_key', display_name: 'Router SSH', metadata: {}, scope: 'workspace' }]);
    resolveRuntimeBoxApiKeyEnv.mockResolvedValue({ env: {}, injected: [], skippedExisting: [], skipped: [{ credentialId: 'router-ssh', reason: 'file credential is materialized as path env; raw env not injected' }] });
    resolveRuntimeBoxCredentialFileMaterialization.mockResolvedValue({ materialize: [{ credentialId: 'router-ssh', envName: 'ROUTER_SSH_KEY_FILE', value: 'must-not-escape' }], skipped: [] });
    const result = await diagnoseProjectConnections({ projectId: 'p1', userId: 7 });
    expect(result[0]).toMatchObject({ status: 'unverified', stoppedAt: 'provider_health', reasonCode: 'ProviderAuthUnverified' });
    expect(result[0].summary).toContain('주입 계획까지');
    expect(result[0].summary).toContain('실제 프로세스 주입과 Provider 인증은 아직 확인하지 않았습니다');
    expect(result[0].stages).toContainEqual(expect.objectContaining({ stage: 'materialization', status: 'pass' }));
    expect(JSON.stringify(result)).not.toContain('must-not-escape');
    expect(JSON.stringify(result)).not.toContain('ROUTER_SSH_KEY_FILE');
  });

  it('treats lower-priority duplicate env Credentials as safely shadowed, not broken', async () => {
    query.mockResolvedValue([
      { id: 'agent-key', provider: 'openai', kind: 'api_key', display_name: 'Agent OpenAI', metadata: {}, scope: 'project' },
      { id: 'shared-key', provider: 'openai', kind: 'api_key', display_name: 'Shared OpenAI', metadata: {}, scope: 'workspace' },
    ]);
    resolveRuntimeBoxApiKeyEnv.mockResolvedValue({ env: {}, injected: [{ credentialId: 'agent-key', envName: 'OPENAI_API_KEY' }], skippedExisting: [], skipped: [{ credentialId: 'shared-key', envName: 'OPENAI_API_KEY', reason: 'duplicate target env; Agent-dedicated credential selected first' }] });
    const result = await diagnoseProjectConnections({ projectId: 'p1', userId: 7 });
    expect(result).toHaveLength(2);
    expect(result.every(item => item.status === 'unverified')).toBe(true);
    expect(result.find(item => item.connectionId === 'shared-key')?.stages).toContainEqual(expect.objectContaining({ stage: 'materialization', status: 'pass', summary: expect.stringContaining('안전하게 대기') }));
  });

  it('uses direct materialization for non-env Google Workspace credentials', async () => {
    query.mockResolvedValue([{ id: 'gws-agent', provider: 'google', kind: 'gws', display_name: 'Agent Google', metadata: { agent_project_id: 'p1' }, scope: 'project' }]);
    resolveRuntimeBoxApiKeyEnv.mockResolvedValue({ env: {}, injected: [], skippedExisting: [], skipped: [] });
    resolveProjectCredentialSecretValue.mockResolvedValue({ credentialId: 'gws-agent', provider: 'google', kind: 'gws', secretName: 'GWS_AGENT', value: 'hidden' });
    const result = await diagnoseProjectConnections({ projectId: 'p1', userId: 7 });
    expect(result[0]).toMatchObject({ capability: 'google', status: 'unverified', reasonCode: 'ProviderAuthUnverified' });
    expect(JSON.stringify(result)).not.toContain('hidden');
  });

  it('turns observed Higgsfield auth rejection into reauthentication action', async () => {
    query.mockResolvedValue([{ id: 'hf', provider: 'higgsfield', kind: 'api_key', display_name: 'Higgsfield', metadata: {}, scope: 'workspace' }]);
    resolveRuntimeBoxApiKeyEnv.mockResolvedValue({ env: {}, injected: [{ credentialId: 'hf', envName: 'HIGGSFIELD_API_KEY' }], skippedExisting: [], skipped: [] });
    const result = await diagnoseProjectConnections({ projectId: 'p1', userId: 7, providerEvidence: { higgsfieldInvalidCredential: true } });
    expect(result[0]).toMatchObject({ stoppedAt: 'provider_auth', reasonCode: 'InvalidCredential', nextAction: 'reauth' });
  });
});

it('isolates a failed GWS binding and redacts exception details', async () => {
  query.mockResolvedValue([
    { id: 'broken', provider: 'google', kind: 'gws', display_name: 'Broken', metadata: {}, scope: 'workspace' },
    { id: 'healthy', provider: 'google', kind: 'gws', display_name: 'Healthy', metadata: {}, scope: 'workspace' },
  ]);
  resolveRuntimeBoxApiKeyEnv.mockResolvedValue({ injected: [], skipped: [] });
  resolveRuntimeBoxCredentialFileMaterialization.mockResolvedValue({ materialize: [], skipped: [] });
  resolveProjectCredentialSecretValue.mockImplementation(async ({ credentialId }) => {
    if (credentialId === 'broken') throw new Error('synthetic-private-detail');
    return { value: 'synthetic-secret' };
  });
  const result = await diagnoseProjectConnectionStatus({ projectId: 'p1', userId: 7 });
  expect(result.inventoryComplete).toBe(true);
  expect(result.connections[0].reasonCode).toBe('MaterializationFailed');
  expect(result.connections[1].status).toBe('unverified');
  expect(JSON.stringify(result)).not.toContain('synthetic-');
});

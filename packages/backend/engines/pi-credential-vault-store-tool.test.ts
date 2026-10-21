import { beforeEach, describe, expect, it, vi } from 'vitest';

const upsertApiKeyCredential = vi.fn();
const queryOne = vi.fn();
vi.mock('../services/credential-vault/credential-vault-service.js', () => ({ upsertApiKeyCredential }));
vi.mock('../db/pg-repo.js', () => ({ queryOne }));
vi.mock('../services/pm/project-access.js', () => ({ isPrivilegedRole: (role?: string) => role === 'admin' || role === 'operator' }));

const { createCredentialVaultStoreTool } = await import('./pi-credential-vault-store-tool.js');

const secretValue = 'chat-secret-value-that-must-not-be-returned';
const params = {
  value: secretValue,
  id: 'openai-default',
  provider: 'openai',
  displayName: 'OpenAI API Key',
  envName: 'OPENAI_API_KEY',
  scope: 'project',
  purpose: 'OpenAI API access',
};

describe('credential_vault_store', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    queryOne.mockImplementation(async (sql: string) => sql.includes('FROM users') ? { role: 'member' } : { creator_user_id: 99, membership_role: 'member' });
    upsertApiKeyCredential.mockResolvedValue({
      id: 'openai-default', provider: 'openai', default_env_name: 'OPENAI_API_KEY', scope: 'project',
    });
  });

  it('is unavailable to restricted or externally deployed Agents', () => {
    expect(createCredentialVaultStoreTool({ userId: 1, userRole: 'member', projectId: 'p1', channelSafeToolsOnly: true })).toBeUndefined();
  });

  it('stores a user-supplied secret for the current Agent without returning it', async () => {
    const tool: any = createCredentialVaultStoreTool({ userId: 1, userRole: 'member', projectId: 'p1' });
    const result = await tool.execute('t1', params);

    expect(upsertApiKeyCredential).toHaveBeenCalledWith(expect.objectContaining({
      id: 'openai-default', provider: 'openai', secretName: 'OPENAI_API_KEY', secretValue,
      defaultEnvName: 'OPENAI_API_KEY', scope: 'project', projectId: 'p1', actorUserId: 1,
      metadata: expect.objectContaining({ source: 'trusted_agent_chat' }),
    }));
    expect(JSON.stringify(result)).not.toContain(secretValue);
    expect(result.details).toMatchObject({ stored: true, credentialId: 'openai-default', scope: 'project' });
  });

  it('refuses team-shared storage for a non-admin', async () => {
    const tool: any = createCredentialVaultStoreTool({ userId: 1, userRole: 'member', projectId: 'p1' });
    const result = await tool.execute('t1', { ...params, scope: 'workspace' });

    expect(result.isError).toBe(true);
    expect(upsertApiKeyCredential).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain(secretValue);
  });

  it.each(['operator', 'admin'])('allows a current %s to store an explicitly team-shared Credential', async role => {
    queryOne.mockImplementation(async (sql: string) => sql.includes('FROM users') ? { role } : { creator_user_id: 99, membership_role: null });
    upsertApiKeyCredential.mockResolvedValue({
      id: 'openai-default', provider: 'openai', default_env_name: 'OPENAI_API_KEY', scope: 'workspace',
    });
    const tool: any = createCredentialVaultStoreTool({ userId: 1, userRole: 'member', projectId: 'p1' });
    const result = await tool.execute('t1', { ...params, scope: 'workspace' });

    expect(upsertApiKeyCredential).toHaveBeenCalledWith(expect.objectContaining({ scope: 'workspace', projectId: undefined }));
    expect(JSON.stringify(result)).not.toContain(secretValue);
  });

  it('refuses storage when the user cannot manage the current Agent', async () => {
    queryOne.mockResolvedValue(null);
    const tool: any = createCredentialVaultStoreTool({ userId: 1, userRole: 'member', projectId: 'p1' });
    const result = await tool.execute('t1', params);

    expect(result.isError).toBe(true);
    expect(upsertApiKeyCredential).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain(secretValue);
  });
});


it('rejects stale admin after demotion without writing or exposing the supplied value', async () => {
  queryOne.mockImplementation(async (sql: string) => sql.includes('FROM users') ? { role: 'member' } : { creator_user_id: 99, membership_role: 'member' });
  upsertApiKeyCredential.mockClear();
  const result = await (createCredentialVaultStoreTool({ userId: 1, userRole: 'admin', projectId: 'p1' }) as any).execute('t1', { ...params, scope: 'workspace' });
  expect(result.isError).toBe(true); expect(upsertApiKeyCredential).not.toHaveBeenCalled(); expect(JSON.stringify(result)).not.toContain(secretValue);
});

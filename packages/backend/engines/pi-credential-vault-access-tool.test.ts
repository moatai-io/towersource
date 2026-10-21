import { beforeEach, describe, expect, it, vi } from 'vitest';

const revealCredentialValue = vi.fn();
const copyProjectCredential = vi.fn();
const queryOne = vi.fn();
vi.mock('../services/credential-vault/credential-vault-service.js', () => ({ revealCredentialValue, copyProjectCredential }));
vi.mock('../db/pg-repo.js', () => ({ queryOne }));
vi.mock('../services/pm/project-access.js', () => ({ isPrivilegedRole: (role?: string) => role === 'admin' || role === 'operator' }));

const { createCredentialVaultAccessTool } = await import('./pi-credential-vault-access-tool.js');

describe('credential_vault_access', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    queryOne.mockImplementation(async (sql: string) => sql.includes('FROM users') ? { role: 'member' } : { creator_user_id: 99, membership_role: 'member' });
  });

  it('is unavailable to externally deployed/channel-safe Agents', () => {
    expect(createCredentialVaultAccessTool({ userId: 1, userRole: 'member', projectId: 'p1', channelSafeToolsOnly: true })).toBeUndefined();
  });

  it('reveals a Credential available to the trusted current Agent', async () => {
    revealCredentialValue.mockResolvedValue({ credential: { id: 'c1' }, value: 'secret-value' });
    const tool: any = createCredentialVaultAccessTool({ userId: 1, userRole: 'member', projectId: 'p1' });
    const result = await tool.execute('t1', { action: 'reveal', credentialId: 'c1', purpose: 'repair' });
    expect(revealCredentialValue).toHaveBeenCalledWith({ projectId: 'p1', credentialId: 'c1', actorUserId: 1, purpose: 'repair' });
    expect(result.content[0].text).toContain('secret-value');
  });

  it('imports only after confirming source Project access', async () => {
    copyProjectCredential.mockResolvedValue({ id: 'copy-1' });
    const tool: any = createCredentialVaultAccessTool({ userId: 1, userRole: 'member', projectId: 'p1' });
    const result = await tool.execute('t1', { action: 'import', credentialId: 'c2', sourceProjectId: 'p2' });
    expect(copyProjectCredential).toHaveBeenCalledWith({ sourceProjectId: 'p2', sourceCredentialId: 'c2', targetProjectId: 'p1', actorUserId: 1 });
    expect(result.content[0].text).not.toContain('secret-value');
  });
});


it('does not reveal through stale model/tool context after membership revocation', async () => {
  queryOne.mockImplementation(async (sql: string) => sql.includes('FROM users') ? { role: 'member' } : { creator_user_id: 99, membership_role: 'viewer' });
  revealCredentialValue.mockClear();
  const result = await (createCredentialVaultAccessTool({ userId: 1, userRole: 'admin', projectId: 'p1' }) as any).execute('t1', { action: 'reveal', credentialId: 'c1' });
  expect(result.isError).toBe(true); expect(revealCredentialValue).not.toHaveBeenCalled();
});
it('does not copy from a source with read-only membership', async () => {
  queryOne.mockImplementation(async (sql: string, args: unknown[]) => sql.includes('FROM users') ? { role: 'member' } : { creator_user_id: 99, membership_role: args[0] === 'p1' ? 'member' : 'viewer' });
  copyProjectCredential.mockClear();
  const result = await (createCredentialVaultAccessTool({ userId: 1, userRole: 'member', projectId: 'p1' }) as any).execute('t1', { action: 'import', credentialId: 'c1', sourceProjectId: 'p2' });
  expect(result.isError).toBe(true); expect(copyProjectCredential).not.toHaveBeenCalled();
});

import { beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('../../db/pg-repo.js', () => ({ query: vi.fn(), queryOne: vi.fn(), execute: vi.fn(), transaction: vi.fn(), withClient: vi.fn() }));
vi.mock('../secret/secret-store.js', () => ({ getSecretForProjectBinding: vi.fn(), setSecret: vi.fn() }));
import { query } from '../../db/pg-repo.js';
import { getSecretForProjectBinding } from '../secret/secret-store.js';
import { classifyRuntimeBoxFileCredential, resolveRuntimeBoxCredentialFileMaterialization } from './credential-vault-service.js';
const row = (id: string) => ({ credential_id: id, provider: 'ssh', kind: 'api_key', secret_name: 'TEST_SSH_PRIVATE_KEY', default_env_name: 'TEST_SSH_PRIVATE_KEY', metadata: {}, scope: 'project' });
beforeEach(() => { vi.resetAllMocks(); vi.mocked(getSecretForProjectBinding).mockResolvedValue('synthetic-only'); });
describe('file Credential selection', () => {
  it('reads one secret for repeated rows and duplicate target envs', async () => {
    vi.mocked(query).mockResolvedValue([row('first'), row('first'), { ...row('shared'), scope: 'workspace' }]);
    const result = await resolveRuntimeBoxCredentialFileMaterialization({ projectId: 'p', userId: 1 });
    expect(result.materialize.map(x => x.credentialId)).toEqual(['first']);
    expect(getSecretForProjectBinding).toHaveBeenCalledTimes(1);
    expect(result.skipped).toHaveLength(2);
    expect(result.skipped[0].reason).toContain('duplicate target file env');
    expect(vi.mocked(query).mock.calls[0][0]).toContain("ORDER BY CASE c.scope WHEN 'project' THEN 0 ELSE 1 END");
  });
  it('does not fall back to a different identity when the preferred secret fails', async () => {
    vi.mocked(query).mockResolvedValue([row('first'), row('shared')]);
    vi.mocked(getSecretForProjectBinding).mockRejectedValue(new Error('synthetic-sensitive-message'));
    const result = await resolveRuntimeBoxCredentialFileMaterialization({ projectId: 'p', userId: 1 });
    expect(result.materialize).toEqual([]);
    expect(getSecretForProjectBinding).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(result)).not.toContain('synthetic-sensitive-message');
  });
  it('does not read unrequested or caller-supplied files', async () => {
    vi.mocked(query).mockResolvedValue([row('first')]);
    await resolveRuntimeBoxCredentialFileMaterialization({ projectId: 'p', userId: 1, requestedEnvNames: new Set() });
    await resolveRuntimeBoxCredentialFileMaterialization({ projectId: 'p', userId: 1, existingEnv: { TEST_SSH_KEY_FILE: '/caller/key' } });
    expect(getSecretForProjectBinding).not.toHaveBeenCalled();
  });
});
describe('SSH password file classification', () => {
  const input = { credentialId: 'test-password', provider: 'ssh', kind: 'api_key', secretName: 'TEST_SSH_PASSWORD', defaultEnvName: 'TEST_SSH_PASSWORD', targetEnvName: null, metadata: {} };
  it('keeps the file-only password contract without private-key newline normalization', () => {
    expect(classifyRuntimeBoxFileCredential(input)).toEqual({ credentialType: 'ssh_password', envName: 'TEST_SSH_PASSWORD_FILE', fileName: 'test-password', mode: '0600' });
  });
  it('honors explicit metadata over name inference', () => {
    expect(classifyRuntimeBoxFileCredential({ ...input, metadata: { credential_type: 'ssh_private_key' } })?.credentialType).toBe('ssh_private_key');
    expect(classifyRuntimeBoxFileCredential({ ...input, secretName: 'TEST_LOGIN', defaultEnvName: 'TEST_LOGIN', metadata: { credential_type: 'password' } })?.credentialType).toBe('password');
  });
});

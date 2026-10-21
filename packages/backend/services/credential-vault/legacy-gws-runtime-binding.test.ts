import { beforeEach, expect, it, vi } from 'vitest';
vi.mock('../../db/pg-repo.js', () => ({ query: vi.fn(), queryOne: vi.fn(), execute: vi.fn(), transaction: vi.fn(), withClient: vi.fn() }));
vi.mock('../secret/secret-store.js', () => ({ getSecretForProjectBinding: vi.fn(), getSecretForLegacyGwsBinding: vi.fn(), setSecret: vi.fn() }));
import { queryOne, execute } from '../../db/pg-repo.js';
import { getSecretForProjectBinding, getSecretForLegacyGwsBinding } from '../secret/secret-store.js';
import { resolveProjectCredentialSecretValue } from './credential-vault-service.js';
const row = { credential_id: 'synthetic-gws', provider: 'google', kind: 'gws', secret_name: 'SYNTHETIC', metadata: {} };
const run = () => resolveProjectCredentialSecretValue({ projectId: 'agent-a', userId: 7, credentialId: row.credential_id, targetType: 'test' });
beforeEach(() => { vi.resetAllMocks(); vi.mocked(queryOne).mockResolvedValue(row); vi.mocked(getSecretForProjectBinding).mockResolvedValue('synthetic-global'); vi.mocked(getSecretForLegacyGwsBinding).mockResolvedValue(null); });
it('keeps unregistered connections on the existing path', async () => { expect((await run())?.value).toBe('synthetic-global'); });
it('uses exact approved legacy binding and audits without secret values', async () => {
  vi.mocked(getSecretForLegacyGwsBinding).mockResolvedValue('synthetic-legacy');
  expect((await run())?.value).toBe('synthetic-legacy');
  expect(getSecretForLegacyGwsBinding).toHaveBeenCalledWith('synthetic-gws', 7);
  expect(getSecretForProjectBinding).not.toHaveBeenCalled();
  expect(JSON.stringify(vi.mocked(execute).mock.calls)).not.toContain('synthetic-legacy');
});
it('never falls back on revoked or disabled binding', async () => {
  vi.mocked(getSecretForLegacyGwsBinding).mockRejectedValue(new Error('denied'));
  await expect(run()).rejects.toThrow('denied'); expect(getSecretForProjectBinding).not.toHaveBeenCalled();
});
it('does not return a value if audit fails', async () => { vi.mocked(execute).mockRejectedValue(new Error('audit failed')); await expect(run()).rejects.toThrow('audit failed'); });
it('does not use bridge without Agent connection access', async () => { vi.mocked(queryOne).mockResolvedValue(null); expect(await run()).toBeNull(); expect(getSecretForLegacyGwsBinding).not.toHaveBeenCalled(); });
it('keeps quarantined personal migration records blocked', async () => { vi.mocked(queryOne).mockResolvedValue({ ...row, metadata: { legacy_personal_owner_user_id: 7 } }); await expect(run()).rejects.toThrow('re-registration'); expect(getSecretForLegacyGwsBinding).not.toHaveBeenCalled(); });

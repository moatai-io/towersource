import { beforeEach, expect, it, vi } from 'vitest';
vi.mock('../../../db/pg-repo.js', () => ({ queryOne: vi.fn() }));
vi.mock('../../secret/secret-store.js', () => ({ getSecretForProjectBinding: vi.fn() }));
vi.mock('../../credential-vault/credential-vault-service.js', () => ({ auditCredentialEvent: vi.fn() }));
import { queryOne } from '../../../db/pg-repo.js';
import { getSecretForProjectBinding } from '../../secret/secret-store.js';
import { auditCredentialEvent } from '../../credential-vault/credential-vault-service.js';
import { resolveAccountMailCredential } from './account-mail-credential.js';
beforeEach(() => vi.resetAllMocks());
it('resolves only the explicit active workspace Zuplo binding and audits system use', async () => {
  vi.mocked(queryOne).mockResolvedValue({ id: 'mail-key', secret_name: 'SYNTHETIC' });
  vi.mocked(getSecretForProjectBinding).mockResolvedValue('synthetic-key');
  expect(await resolveAccountMailCredential('mail-key')).toBe('synthetic-key');
  expect(queryOne).toHaveBeenCalledWith(expect.stringContaining("scope='workspace' AND provider='zuplo' AND kind='api_key'"), ['mail-key']);
  expect(auditCredentialEvent).toHaveBeenCalledWith(expect.objectContaining({ targetType: 'system-account-mail', credentialId: 'mail-key' }));
});
it('rejects invalid or unavailable bindings without resolving any secret', async () => {
  await expect(resolveAccountMailCredential('../key')).rejects.toThrow();
  vi.mocked(queryOne).mockResolvedValue(null);
  await expect(resolveAccountMailCredential('mail-key')).rejects.toThrow('unavailable');
  expect(getSecretForProjectBinding).not.toHaveBeenCalled();
});

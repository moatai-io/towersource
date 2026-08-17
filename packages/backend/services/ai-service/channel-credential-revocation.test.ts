import { beforeEach, describe, expect, it, vi } from 'vitest';

const execute = vi.fn();
const queryOne = vi.fn();
vi.mock('../../db/pg-repo.js', () => ({ execute, queryOne }));

const { revokeChannelCredential, assertChannelCredentialNotRevoked } = await import('./channel-credential-revocation.js');

describe('AI Service Channel credential revocation', () => {
  beforeEach(() => vi.clearAllMocks());

  it('stores only a token hash plus scoped claims', async () => {
    execute.mockResolvedValue({ changes: 1 });
    const result = await revokeChannelCredential({
      token: 'tasc_v1.payload.signature',
      claims: { serviceId: 'svc-1', channelId: 'ch-1', tenantKey: 'tenant-1', userKey: 'user-1', exposure: 'auth-required', iat: 1000, exp: 2000, nonce: 'nonce-1' },
      revokedByUserId: 7,
      reason: 'operator-test',
    });
    expect(result.tokenHash).toMatch(/^[a-f0-9]{64}$/);
    expect(execute).toHaveBeenCalledWith(expect.stringContaining('ai_service_channel_credential_revocations'), [
      result.tokenHash, 'svc-1', 'ch-1', 'nonce-1', 'operator-test', 7, 2000,
    ]);
  });

  it('rejects revoked token hashes', async () => {
    queryOne.mockResolvedValue({ token_hash: 'hash' });
    await expect(assertChannelCredentialNotRevoked('tasc_v1.payload.signature')).rejects.toThrow('credential revoked');
  });

  it('allows non-revoked token hashes', async () => {
    queryOne.mockResolvedValue(undefined);
    await expect(assertChannelCredentialNotRevoked('tasc_v1.payload.signature')).resolves.toBeUndefined();
  });
});

import { describe, expect, it, vi } from 'vitest';

vi.mock('../../config.js', () => ({ config: { jwtSecret: 'test-channel-secret-with-enough-entropy' } }));

const { ChannelCredentialError, channelCredentialTokenHash, credentialFromAuthHeader, issueChannelCredential, verifyChannelCredential } = await import('./channel-credential.js');

describe('AI Service Channel credentials', () => {
  it('issues and verifies one service/channel/tenant/user tuple', () => {
    const issued = issueChannelCredential({ serviceId: 'svc-1', channelId: 'ch-1', tenantKey: 'tenant-1', userKey: 'user-1', exposure: 'auth-required', ttlSeconds: 600, nowSeconds: 1000 });
    const claims = verifyChannelCredential(issued.token, { serviceId: 'svc-1', channelId: 'ch-1', nowSeconds: 1200 });
    expect(claims).toMatchObject({ serviceId: 'svc-1', channelId: 'ch-1', tenantKey: 'tenant-1', userKey: 'user-1', exposure: 'auth-required', iat: 1000, exp: 1600 });
    expect(issued.expiresAt).toBe(new Date(1600 * 1000).toISOString());
  });

  it('rejects tampered credentials', () => {
    const issued = issueChannelCredential({ serviceId: 'svc-1', channelId: 'ch-1', tenantKey: 'tenant-1', userKey: 'user-1', nowSeconds: 1000 });
    const tampered = `${issued.token.slice(0, -1)}x`;
    expect(() => verifyChannelCredential(tampered, { nowSeconds: 1001 })).toThrow(ChannelCredentialError);
  });

  it('rejects expired and mismatched credentials', () => {
    const issued = issueChannelCredential({ serviceId: 'svc-1', channelId: 'ch-1', tenantKey: 'tenant-1', userKey: 'user-1', ttlSeconds: 60, nowSeconds: 1000 });
    expect(() => verifyChannelCredential(issued.token, { nowSeconds: 1061 })).toThrow('expired');
    expect(() => verifyChannelCredential(issued.token, { serviceId: 'svc-2', nowSeconds: 1001 })).toThrow('service mismatch');
    expect(() => verifyChannelCredential(issued.token, { channelId: 'ch-2', nowSeconds: 1001 })).toThrow('channel mismatch');
  });

  it('hashes credentials for revocation without exposing token plaintext', () => {
    const hash = channelCredentialTokenHash('tasc_v1.example.signature');
    expect(hash).toMatch(/^[a-f0-9]{64}$/);
    expect(hash).not.toContain('example');
  });

  it('extracts bearer credentials only from Authorization header', () => {
    expect(credentialFromAuthHeader('Bearer abc.def')).toBe('abc.def');
    expect(() => credentialFromAuthHeader('Basic abc')).toThrow('Bearer AI Service Channel credential required');
  });
});

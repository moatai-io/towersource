import { beforeEach, describe, expect, it, vi } from 'vitest';

const resolveProjectApiKeySecretValue = vi.fn();
const upsertApiKeyCredential = vi.fn();
const assertCredentialManagementAccess = vi.fn();
vi.mock('../credential-vault/credential-vault-service.js', () => ({ resolveProjectApiKeySecretValue, upsertApiKeyCredential }));
vi.mock('../credential-vault/credential-management-access.js', () => ({ assertCredentialManagementAccess }));

const { issueOrRotateZuploKeyAndStore } = await import('./zuplo-key-issuance.js');

const managementSecret = 'synthetic-management-secret';
const issuedSecret = 'synthetic-issued-virtual-key';
const base = {
  operation: 'issue' as const,
  actorUserId: 7,
  projectId: 'project-1',
  account: 'demo-account',
  bucketId: 'bckt_demo',
  consumerName: 'vm-demo',
  credentialId: 'zuplo-virtual-key-vm-demo',
  credentialEnvName: 'ZUPLO_VIRTUAL_KEY',
  credentialDisplayName: 'VM demo gateway key',
  confirmed: true as const,
};

describe('issueOrRotateZuploKeyAndStore', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resolveProjectApiKeySecretValue.mockResolvedValue({ credentialId: 'zuplo-admin', envName: 'ZUPLO_API_KEY', value: managementSecret });
    upsertApiKeyCredential.mockResolvedValue({ id: base.credentialId, default_env_name: base.credentialEnvName });
  });

  it('stores the provider-issued value in Vault and returns identifiers only', async () => {
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
      expect((init.headers as Record<string, string>).Authorization).toBe(`Bearer ${managementSecret}`);
      return new Response(JSON.stringify({ id: 'csmr_demo', apiKeys: [{ id: 'key_demo', key: issuedSecret }] }), { status: 200 });
    }) as any;

    const result = await issueOrRotateZuploKeyAndStore({ ...base, fetchImpl });

    expect(assertCredentialManagementAccess).toHaveBeenNthCalledWith(1, { actorUserId: 7, scope: 'project', projectId: 'project-1' });
    expect(assertCredentialManagementAccess).toHaveBeenNthCalledWith(2, { actorUserId: 7, scope: 'workspace', action: 'admin' });
    expect(upsertApiKeyCredential).toHaveBeenCalledWith(expect.objectContaining({
      id: base.credentialId,
      provider: 'zuplo',
      secretValue: issuedSecret,
      scope: 'workspace',
      actorUserId: 7,
      metadata: expect.objectContaining({ zuplo_key_id: 'key_demo', zuplo_consumer_id: 'csmr_demo' }),
    }));
    expect(result).toMatchObject({ consumerId: 'csmr_demo', keyId: 'key_demo', credentialId: base.credentialId, stored: true });
    expect(JSON.stringify(result)).not.toContain(issuedSecret);
    expect(JSON.stringify(result)).not.toContain(managementSecret);
  });

  it('does not call Zuplo or Vault when current authority fails', async () => {
    assertCredentialManagementAccess.mockRejectedValueOnce(new Error('denied'));
    const fetchImpl = vi.fn();
    await expect(issueOrRotateZuploKeyAndStore({ ...base, fetchImpl: fetchImpl as any })).rejects.toThrow('denied');
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(upsertApiKeyCredential).not.toHaveBeenCalled();
  });

  it('requires an explicit old-key expiry for rotation', async () => {
    const fetchImpl = vi.fn();
    await expect(issueOrRotateZuploKeyAndStore({ ...base, operation: 'rotate', fetchImpl: fetchImpl as any })).rejects.toMatchObject({ code: 'ZUPLO_KEY_EXPIRY_REQUIRED' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('returns a recovery-required error without exposing a key when Vault storage fails', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ id: 'csmr_demo', apiKeys: [{ id: 'key_demo', key: issuedSecret }] }), { status: 200 })) as any;
    upsertApiKeyCredential.mockRejectedValue(new Error(`failed while storing ${issuedSecret}`));

    let error: any;
    try { await issueOrRotateZuploKeyAndStore({ ...base, fetchImpl }); } catch (caught) { error = caught; }
    expect(error).toMatchObject({ code: 'ZUPLO_KEY_VAULT_STORE_FAILED' });
    expect(String(error?.message)).not.toContain(issuedSecret);
  });

  it('does not reflect a provider error body containing sensitive material', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ detail: issuedSecret }), { status: 403 })) as any;
    let error: any;
    try { await issueOrRotateZuploKeyAndStore({ ...base, fetchImpl }); } catch (caught) { error = caught; }
    expect(error).toMatchObject({ code: 'ZUPLO_KEY_PROVIDER_REJECTED' });
    expect(String(error?.message)).not.toContain(issuedSecret);
    expect(upsertApiKeyCredential).not.toHaveBeenCalled();
  });
});

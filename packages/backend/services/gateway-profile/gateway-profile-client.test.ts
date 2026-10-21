import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../db/pg-repo.js', () => ({ query: vi.fn() }));
vi.mock('../credential-vault/credential-vault-service.js', () => ({ resolveProjectCredentialSecretValue: vi.fn() }));

import { query } from '../../db/pg-repo.js';
import { resolveProjectCredentialSecretValue } from '../credential-vault/credential-vault-service.js';
import { resolveGatewayApiClient, resolveGatewayProfileClient } from './gateway-profile-client.js';

const readyRow = {
  id: 'tower-shared-api-v1', gateway_base_url: 'https://gateway.example.com/', credential_id: 'tower-key', status: 'ready',
  api_id: 'naver', route_prefix: '/naver', readiness: 'ready', enabled: true,
};

describe('Gateway Profile client resolver', () => {
  beforeEach(() => vi.resetAllMocks());

  it('resolves a ready provider route and never returns credential metadata as a secret', async () => {
    vi.mocked(query).mockResolvedValue([readyRow]);
    vi.mocked(resolveProjectCredentialSecretValue).mockResolvedValue({ credentialId: 'tower-key', provider: 'zuplo', kind: 'api_key', secretName: 'ZUPLO_KEY', value: 'synthetic-key' });
    const result = await resolveGatewayApiClient({ actorUserId: 7, projectId: 'project-1', apiId: 'naver' });
    expect(result).toMatchObject({ profileId: 'tower-shared-api-v1', apiId: 'naver', baseUrl: 'https://gateway.example.com/naver', credentialId: 'tower-key', apiKey: 'synthetic-key', readiness: 'ready' });
    expect(query).toHaveBeenCalledWith(expect.stringContaining('ce.api_id = $2'), ['tower-shared-api-v1', 'naver']);
    expect(resolveProjectCredentialSecretValue).toHaveBeenCalledWith({ projectId: 'project-1', userId: 7, credentialId: 'tower-key', kind: 'api_key', provider: 'zuplo', targetType: 'gateway:naver' });
  });

  it.each([
    [{ gateway_base_url: null, credential_id: null, status: 'pending' }, 'GATEWAY_PROFILE_NOT_PROVISIONED'],
    [{ gateway_base_url: 'https://gateway.example.com', credential_id: 'tower-key', status: 'disabled' }, 'GATEWAY_PROFILE_DISABLED'],
    [{ ...readyRow, api_id: null }, 'GATEWAY_API_NOT_ALLOWED'],
    [{ ...readyRow, enabled: false }, 'GATEWAY_API_NOT_ALLOWED'],
  ])('rejects unprovisioned or explicitly disallowed state', async (profile, code) => {
    vi.mocked(query).mockResolvedValue([{ id: 'tower-shared-api-v1', ...profile }]);
    await expect(resolveGatewayApiClient({ actorUserId: 7, projectId: 'project-1', apiId: 'naver' })).rejects.toMatchObject({ code });
    expect(resolveProjectCredentialSecretValue).not.toHaveBeenCalled();
  });

  it.each(['unverified', 'degraded', 'ready'] as const)('allows enabled APIs regardless of %s verification evidence', async readiness => {
    vi.mocked(query).mockResolvedValue([{ ...readyRow, status: 'pending', readiness }]);
    vi.mocked(resolveProjectCredentialSecretValue).mockResolvedValue({ credentialId: 'tower-key', provider: 'zuplo', kind: 'api_key', secretName: 'ZUPLO_KEY', value: 'synthetic-key' });
    await expect(resolveGatewayApiClient({ actorUserId: 7, projectId: 'project-1', apiId: 'naver' })).resolves.toMatchObject({ readiness });
  });

  it('fails closed when the Gateway Credential is outside the current Project scope', async () => {
    vi.mocked(query).mockResolvedValue([readyRow]);
    vi.mocked(resolveProjectCredentialSecretValue).mockResolvedValue(null);
    await expect(resolveGatewayApiClient({ actorUserId: 7, projectId: 'project-2', apiId: 'naver' })).rejects.toMatchObject({ code: 'GATEWAY_CREDENTIAL_NOT_AVAILABLE' });
    expect(resolveProjectCredentialSecretValue).toHaveBeenCalledWith(expect.objectContaining({ projectId: 'project-2', credentialId: 'tower-key' }));
  });

  it('keeps the Jev compatibility resolver on the catalog route', async () => {
    vi.mocked(query).mockResolvedValue([{ ...readyRow, api_id: 'openrouter-jev', route_prefix: '/inference/openrouter' }]);
    vi.mocked(resolveProjectCredentialSecretValue).mockResolvedValue({ credentialId: 'tower-key', provider: 'zuplo', kind: 'api_key', secretName: 'ZUPLO_KEY', value: 'synthetic-key' });
    await expect(resolveGatewayProfileClient({ actorUserId: 7, projectId: 'project-1' })).resolves.toMatchObject({ apiId: 'openrouter-jev', baseUrl: 'https://gateway.example.com/inference/openrouter' });
    expect(query).toHaveBeenCalledWith(expect.any(String), ['tower-shared-api-v1', 'openrouter-jev']);
  });
});

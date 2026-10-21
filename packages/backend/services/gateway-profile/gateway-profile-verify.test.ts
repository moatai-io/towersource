import { beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('../../db/pg-repo.js', () => ({ query: vi.fn(), execute: vi.fn() }));
vi.mock('../credential-vault/credential-vault-service.js', () => ({ revealCredentialValue: vi.fn() }));
import { execute, query } from '../../db/pg-repo.js';
import { revealCredentialValue } from '../credential-vault/credential-vault-service.js';
import { verifyGatewayProfile } from './gateway-profile-verify.js';

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(query).mockResolvedValue([{ id: 'tower-shared-api-v1', gateway_base_url: 'https://gateway.example.com', credential_id: 'gateway-key', status: 'pending', api_id: 'agent-store', enabled: true }]);
  vi.mocked(revealCredentialValue).mockResolvedValue({ credential: {} as any, value: 'synthetic-secret' });
  vi.mocked(execute).mockResolvedValue({ changes: 1 });
});

describe('bounded Gateway Profile verification', () => {
  it('marks the profile and only the checked provider ready after a valid MCP initialize response', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { protocolVersion: '2025-03-26' } }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    const result = await verifyGatewayProfile({ actorUserId: 7, fetcher });
    expect(result).toMatchObject({ status: 'ready', verified: true, httpStatus: 200, checkedApi: 'agent-store' });
    expect(fetcher).toHaveBeenCalledWith('https://gateway.example.com/agent-store/mcp', expect.objectContaining({ method: 'POST', redirect: 'error' }));
    expect(JSON.stringify(result)).not.toContain('synthetic-secret');
    expect(execute).toHaveBeenNthCalledWith(1, expect.stringContaining('UPDATE gateway_profiles'), expect.arrayContaining(['ready']));
    expect(execute).toHaveBeenNthCalledWith(2, expect.stringContaining('api_id = $2'), ['tower-shared-api-v1', 'agent-store', 'ready', expect.any(String), '']);
  });

  it.each([
    [new Response('denied', { status: 401 }), 'gateway_http_401'],
    [new Response(JSON.stringify({ result: {} }), { status: 200 }), 'gateway_invalid_initialize_response'],
  ])('marks degraded for rejected or invalid gateway response', async (response, code) => {
    const result = await verifyGatewayProfile({ actorUserId: 7, fetcher: vi.fn().mockResolvedValue(response) });
    expect(result).toMatchObject({ status: 'degraded', verified: false, errorCode: code });
    expect(execute).toHaveBeenNthCalledWith(2, expect.any(String), ['tower-shared-api-v1', 'agent-store', 'degraded', expect.any(String), code]);
  });

  it('verifies Naver without changing the profile-level Agent Store status', async () => {
    vi.mocked(query).mockResolvedValue([{ id: 'tower-shared-api-v1', gateway_base_url: 'https://gateway.example.com', credential_id: 'gateway-key', status: 'ready', api_id: 'naver', enabled: true }]);
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ total: 1, start: 1, display: 1, items: [{ title: 'Tower' }] }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    const result = await verifyGatewayProfile({ actorUserId: 7, apiId: 'naver', fetcher });
    expect(result).toMatchObject({ status: 'ready', verified: true, checkedApi: 'naver', httpStatus: 200 });
    expect(fetcher).toHaveBeenCalledWith('https://gateway.example.com/naver/search/news.json?query=Tower&display=1&start=1&sort=sim', expect.objectContaining({ method: 'GET', redirect: 'error' }));
    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledWith(expect.stringContaining('api_id = $2'), ['tower-shared-api-v1', 'naver', 'ready', expect.any(String), '']);
    expect(revealCredentialValue).toHaveBeenCalledWith(expect.objectContaining({ purpose: expect.stringContaining('naver') }));
  });

  it('degrades only Naver when its response shape is invalid', async () => {
    vi.mocked(query).mockResolvedValue([{ id: 'tower-shared-api-v1', gateway_base_url: 'https://gateway.example.com', credential_id: 'gateway-key', status: 'ready', api_id: 'naver', enabled: true }]);
    const result = await verifyGatewayProfile({ actorUserId: 7, apiId: 'naver', fetcher: vi.fn().mockResolvedValue(new Response(JSON.stringify({ items: [] }), { status: 200 })) });
    expect(result).toMatchObject({ status: 'degraded', errorCode: 'gateway_invalid_naver_response', checkedApi: 'naver' });
    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledWith(expect.any(String), ['tower-shared-api-v1', 'naver', 'degraded', expect.any(String), 'gateway_invalid_naver_response']);
  });

  it('marks only openrouter-jev ready after a valid bounded Choice response', async () => {
    vi.mocked(query).mockResolvedValue([{ id: 'tower-shared-api-v1', gateway_base_url: 'https://gateway.example.com', credential_id: 'gateway-key', status: 'ready', api_id: 'openrouter-jev', enabled: true }]);
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      provider: 'TypeSafe',
      model: 'typesafe/jev-1.13-20260917',
      answers: { readiness: { type: 'choice', choice: 'ready', probabilities: { ready: 0.99, not_ready: 0.01 }, confidence: 0.99 } },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    const result = await verifyGatewayProfile({ actorUserId: 7, apiId: 'openrouter-jev', fetcher });
    expect(result).toMatchObject({ status: 'ready', verified: true, checkedApi: 'openrouter-jev', httpStatus: 200 });
    expect(fetcher).toHaveBeenCalledWith('https://gateway.example.com/inference/openrouter/api/alpha/decisions', expect.objectContaining({ method: 'POST', redirect: 'error' }));
    const init = fetcher.mock.calls[0][1] as RequestInit;
    expect(JSON.parse(String(init.body))).toMatchObject({ model: 'typesafe/jev-1.13', state: { canary: 'gateway-readiness' }, questions: { readiness: { type: 'choice' } } });
    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledWith(expect.stringContaining('api_id = $2'), ['tower-shared-api-v1', 'openrouter-jev', 'ready', expect.any(String), '']);
    expect(revealCredentialValue).toHaveBeenCalledWith(expect.objectContaining({ purpose: expect.stringContaining('openrouter-jev') }));
  });

  it.each([
    [{ provider: 'TypeSafe', model: 'typesafe/jev-1.13', answers: { readiness: { type: 'choice', choice: 'not_ready', probabilities: { ready: 0, not_ready: 1 }, confidence: 1 } } }, 'explicit not_ready choice'],
    [{ provider: 'TypeSafe', model: 'other/model', answers: { readiness: { type: 'choice', choice: 'ready', probabilities: { ready: 1 }, confidence: 1 } } }, 'wrong model'],
    [{ provider: 'TypeSafe', model: 'typesafe/jev-1.13', answers: {} }, 'missing answer'],
    [{ model: 'typesafe/jev-1.13', answers: { readiness: { type: 'choice', choice: 'ready', probabilities: { ready: 1 }, confidence: 1 } } }, 'missing provider'],
  ])('degrades only openrouter-jev for invalid %s response shape', async (body) => {
    vi.mocked(query).mockResolvedValue([{ id: 'tower-shared-api-v1', gateway_base_url: 'https://gateway.example.com', credential_id: 'gateway-key', status: 'ready', api_id: 'openrouter-jev', enabled: true }]);
    const result = await verifyGatewayProfile({ actorUserId: 7, apiId: 'openrouter-jev', fetcher: vi.fn().mockResolvedValue(new Response(JSON.stringify(body), { status: 200 })) });
    expect(result).toMatchObject({ status: 'degraded', verified: false, checkedApi: 'openrouter-jev', errorCode: 'gateway_invalid_openrouter_jev_response' });
    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledWith(expect.any(String), ['tower-shared-api-v1', 'openrouter-jev', 'degraded', expect.any(String), 'gateway_invalid_openrouter_jev_response']);
  });

  it('marks only openai-image ready after receiving a bounded PNG result', async () => {
    vi.mocked(query).mockResolvedValue([{ id: 'tower-shared-api-v1', gateway_base_url: 'https://gateway.example.com', credential_id: 'gateway-key', status: 'ready', api_id: 'openai-image', enabled: true }]);
    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('synthetic')]);
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ data: [{ b64_json: png.toString('base64') }] }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    const result = await verifyGatewayProfile({ actorUserId: 7, apiId: 'openai-image', fetcher });
    expect(result).toMatchObject({ status: 'ready', verified: true, checkedApi: 'openai-image', httpStatus: 200 });
    expect(fetcher).toHaveBeenCalledWith('https://gateway.example.com/openai/images/generations', expect.objectContaining({ method: 'POST', redirect: 'error' }));
    const init = fetcher.mock.calls[0][1] as RequestInit;
    expect(JSON.parse(String(init.body))).toMatchObject({ model: 'gpt-image-2.5-sunburst', size: '1024x1024', quality: 'low', n: 1, output_format: 'png' });
    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledWith(expect.stringContaining('api_id = $2'), ['tower-shared-api-v1', 'openai-image', 'ready', expect.any(String), '']);
  });

  it.each([
    [{ data: [] }, 'empty result'],
    [{ data: [{ b64_json: Buffer.from('not-a-png').toString('base64') }] }, 'non-PNG result'],
  ])('degrades only openai-image for %s', async (body) => {
    vi.mocked(query).mockResolvedValue([{ id: 'tower-shared-api-v1', gateway_base_url: 'https://gateway.example.com', credential_id: 'gateway-key', status: 'ready', api_id: 'openai-image', enabled: true }]);
    const result = await verifyGatewayProfile({ actorUserId: 7, apiId: 'openai-image', fetcher: vi.fn().mockResolvedValue(new Response(JSON.stringify(body), { status: 200 })) });
    expect(result).toMatchObject({ status: 'degraded', verified: false, checkedApi: 'openai-image', errorCode: 'gateway_invalid_openai_image_response' });
    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledWith(expect.any(String), ['tower-shared-api-v1', 'openai-image', 'degraded', expect.any(String), 'gateway_invalid_openai_image_response']);
  });

  it('records a bounded generic error without returning secret-bearing provider detail', async () => {
    const result = await verifyGatewayProfile({ actorUserId: 7, fetcher: vi.fn().mockRejectedValue(new Error('synthetic-secret leaked upstream')) });
    expect(result).toMatchObject({ status: 'degraded', errorCode: 'gateway_verify_request_failed' });
    expect(JSON.stringify(result)).not.toContain('synthetic-secret');
  });

  it('rejects unsupported or disabled APIs before credential access', async () => {
    await expect(verifyGatewayProfile({ actorUserId: 7, apiId: 'corepin', fetcher: vi.fn() })).rejects.toThrow('Gateway API verification is not supported');
    vi.mocked(query).mockResolvedValue([{ id: 'tower-shared-api-v1', gateway_base_url: 'https://gateway.example.com', credential_id: 'gateway-key', api_id: null, enabled: null }]);
    await expect(verifyGatewayProfile({ actorUserId: 7, apiId: 'naver', fetcher: vi.fn() })).rejects.toThrow('Gateway API is not enabled');
    expect(revealCredentialValue).not.toHaveBeenCalled();
  });

  it('fails before network when profile is not provisioned', async () => {
    vi.mocked(query).mockResolvedValue([{ id: 'tower-shared-api-v1', gateway_base_url: null, credential_id: null }]);
    const fetcher = vi.fn();
    await expect(verifyGatewayProfile({ actorUserId: 7, fetcher })).rejects.toThrow('Gateway Profile is not provisioned');
    expect(fetcher).not.toHaveBeenCalled();
    expect(revealCredentialValue).not.toHaveBeenCalled();
  });
});

import { beforeEach, describe, expect, it, vi } from 'vitest';

const resolveGatewayApiClient = vi.fn();
vi.mock('../gateway-profile/gateway-profile-client.js', () => ({ resolveGatewayApiClient }));

const { AgentCharacterGenerationError, generateAgentCharacter } = await import('./generated-character.js');

beforeEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

describe('generateAgentCharacter', () => {
  it('uses the Project-aware OpenAI Image Gateway route', async () => {
    resolveGatewayApiClient.mockResolvedValue({ apiId: 'openai-image', baseUrl: 'https://gateway.example.com/openai', apiKey: 'synthetic-virtual-key' });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: [{ b64_json: Buffer.from('png').toString('base64') }] }),
    }));

    const result = await generateAgentCharacter({ projectId: 'p1', userId: 7, prompt: '전략 담당자' });

    expect(resolveGatewayApiClient).toHaveBeenCalledWith({
      actorUserId: 7, projectId: 'p1', apiId: 'openai-image',
    });
    expect(fetch).toHaveBeenCalledWith('https://gateway.example.com/openai/images/generations', expect.objectContaining({
      headers: expect.objectContaining({ Authorization: 'Bearer synthetic-virtual-key' }),
    }));
    expect(result.face).toMatch(/^generated:/);
  });

  it('returns a typed credential error when the Gateway is unavailable', async () => {
    resolveGatewayApiClient.mockRejectedValue(new Error('GATEWAY_CREDENTIAL_NOT_AVAILABLE'));
    await expect(generateAgentCharacter({ projectId: 'p1', userId: 7, prompt: '분석가' }))
      .rejects.toMatchObject({ name: 'AgentCharacterGenerationError', kind: 'credential_unavailable' });
  });

  it('does not propagate an OpenAI API error containing a key fragment', async () => {
    resolveGatewayApiClient.mockResolvedValue({ apiId: 'openai-image', baseUrl: 'https://gateway.example.com/openai', apiKey: 'synthetic-virtual-key' });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      json: async () => ({ error: { message: 'Incorrect API key provided: sk-sensitive-fragment' } }),
    }));

    let caught: unknown;
    try {
      await generateAgentCharacter({ projectId: 'p1', userId: 7, prompt: '분석가' });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(AgentCharacterGenerationError);
    expect(String((caught as Error).message)).toBe('provider_rejected');
    expect(String((caught as Error).message)).not.toContain('sk-sensitive-fragment');
  });
});

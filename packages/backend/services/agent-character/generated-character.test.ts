import { beforeEach, describe, expect, it, vi } from 'vitest';

const resolveProjectApiKeySecretValue = vi.fn();
vi.mock('../credential-vault/credential-vault-service.js', () => ({ resolveProjectApiKeySecretValue }));

const { AgentCharacterGenerationError, generateAgentCharacter } = await import('./generated-character.js');

beforeEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

describe('generateAgentCharacter', () => {
  it('uses the Project Vault OpenAI Image credential instead of the general OpenAI key', async () => {
    resolveProjectApiKeySecretValue.mockResolvedValue({ credentialId: 'openai-image-default', envName: 'OPENAI_IMAGE_API_KEY', value: 'secret-value' });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: [{ b64_json: Buffer.from('png').toString('base64') }] }),
    }));

    const result = await generateAgentCharacter({ projectId: 'p1', userId: 7, prompt: '전략 담당자' });

    expect(resolveProjectApiKeySecretValue).toHaveBeenCalledWith({
      projectId: 'p1', userId: 7, envName: 'OPENAI_IMAGE_API_KEY', targetType: 'agent-character-generation',
    });
    expect(fetch).toHaveBeenCalledWith('https://api.openai.com/v1/images/generations', expect.objectContaining({
      headers: expect.objectContaining({ Authorization: 'Bearer secret-value' }),
    }));
    expect(result.face).toMatch(/^generated:/);
  });

  it('returns a typed credential error without exposing provider text', async () => {
    resolveProjectApiKeySecretValue.mockResolvedValue(null);
    await expect(generateAgentCharacter({ projectId: 'p1', userId: 7, prompt: '분석가' }))
      .rejects.toMatchObject({ name: 'AgentCharacterGenerationError', kind: 'credential_unavailable' });
  });

  it('does not propagate an OpenAI API error containing a key fragment', async () => {
    resolveProjectApiKeySecretValue.mockResolvedValue({ credentialId: 'openai-image-default', envName: 'OPENAI_IMAGE_API_KEY', value: 'secret-value' });
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

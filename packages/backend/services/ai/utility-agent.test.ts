import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockQuickReply = vi.fn();
const mockGetEngine = vi.fn(async () => ({ quickReply: mockQuickReply }));

describe('utility-agent', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    mockQuickReply.mockReset();
    mockGetEngine.mockReset();
    mockGetEngine.mockImplementation(async () => ({ quickReply: mockQuickReply }));
    vi.doMock('../../engines/index.js', () => ({
      getEngine: mockGetEngine,
    }));
  });

  it('engineFromModel returns pi for provider/model ids', async () => {
    const mod = await import('./utility-agent.ts');
    expect(mod.engineFromModel('azure-openai-responses/gpt-5.4')).toBe('pi');
    expect(mod.engineFromModel('openrouter/anthropic/claude-sonnet-4.6')).toBe('pi');
    expect(mod.engineFromModel('litellm-responses/mini')).toBe('pi');
  });

  it('engineFromModel returns claude for claude model ids', async () => {
    const mod = await import('./utility-agent.ts');
    expect(mod.engineFromModel('claude-haiku-4-5-20251001')).toBe('claude');
  });

  it('runUtilityTextTask loads engine from model and calls quickReply when Claude is explicitly enabled', async () => {
    mockQuickReply.mockResolvedValueOnce('result text');
    vi.doMock('../../config.js', () => ({
      config: { claudeEnabled: true, piEnabled: true },
      loadModelsFile: () => ({ claude: [], pi: [] }),
    }));
    const mod = await import('./utility-agent.ts');

    const result = await mod.runUtilityTextTask({
      prompt: 'hello',
      systemPrompt: 'system',
      model: 'claude-haiku-4-5-20251001',
      fallbackText: 'fallback',
    });

    expect(mockGetEngine).toHaveBeenCalledWith('claude');
    expect(mockQuickReply).toHaveBeenCalledTimes(1);
    expect(mockQuickReply.mock.calls[0][0]).toBe('hello');
    expect(mockQuickReply.mock.calls[0][1]).toMatchObject({
      model: 'claude-haiku-4-5-20251001',
      systemPrompt: 'system',
    });
    expect(result).toBe('result text');
  });

  it('keeps LiteLLM utility aliases on Pi instead of falling back to Claude', async () => {
    mockQuickReply.mockResolvedValueOnce('mini title');
    vi.doMock('../../config.js', () => ({
      config: { claudeEnabled: false, piEnabled: true },
      loadModelsFile: () => ({
        claude: [
          { id: 'claude-haiku-4-5-20251001', name: 'Haiku 4.5', enabled: true },
        ],
        pi: [],
      }),
    }));
    const mod = await import('./utility-agent.ts');

    const result = await mod.runUtilityTextTask({
      prompt: 'hello',
      systemPrompt: 'system',
      model: 'litellm-responses/mini',
      fallbackText: 'fallback',
    });

    expect(mockGetEngine).toHaveBeenCalledWith('pi');
    expect(mockQuickReply.mock.calls[0][1]).toMatchObject({
      model: 'litellm-responses/mini',
      systemPrompt: 'system',
    });
    expect(result).toBe('mini title');
  });

  it('uses a Claude utility fallback for unsupported Pi default providers', async () => {
    mockQuickReply.mockResolvedValueOnce('title text');
    vi.doMock('../../config.js', () => ({
      config: { claudeEnabled: true, piEnabled: true },
      loadModelsFile: () => ({
        claude: [
          { id: 'claude-sonnet-4-6', name: 'Sonnet 4.6', enabled: true },
          { id: 'claude-haiku-4-5-20251001', name: 'Haiku 4.5', enabled: true },
        ],
        pi: [],
      }),
    }));
    const mod = await import('./utility-agent.ts');

    const result = await mod.runUtilityTextTask({
      prompt: 'hello',
      systemPrompt: 'system',
      model: 'openai-codex/gpt-5.5',
      fallbackText: 'fallback',
    });

    expect(mockGetEngine).toHaveBeenCalledWith('claude');
    expect(mockQuickReply.mock.calls[0][1]).toMatchObject({
      model: 'claude-haiku-4-5-20251001',
      systemPrompt: 'system',
    });
    expect(result).toBe('title text');
  });

  it('returns fallback text when engine call fails', async () => {
    mockQuickReply.mockRejectedValueOnce(new Error('boom'));
    const mod = await import('./utility-agent.ts');

    const result = await mod.runUtilityTextTask({
      prompt: 'hello',
      systemPrompt: 'system',
      model: 'claude-haiku-4-5-20251001',
      fallbackText: 'fallback',
    });

    expect(result).toBe('fallback');
  });
});

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ load: vi.fn(), save: vi.fn(), credentials: vi.fn() }));
vi.mock('../../config.js', () => ({ loadModelsFile: mocks.load, saveModelsFile: mocks.save }));
vi.mock('./litellm-credentials.js', () => ({ resolveLiteLLMCredentials: mocks.credentials }));

import { isModelPolicyId, normalizeLiteLLMModels, refreshLiteLLMModelCatalog, setLiteLLMModelSelectable } from './litellm-model-catalog.js';

beforeEach(() => {
  vi.restoreAllMocks();
  mocks.save.mockReset();
  mocks.credentials.mockResolvedValue({ baseUrl: 'https://router.example.com/v1', apiKey: 'synthetic' });
  mocks.load.mockReturnValue({ claude: [], pi: [{ provider: 'litellm-responses', modelId: 'smartest', name: 'Smartest', enabled: true }], defaults: {} });
});

describe('LiteLLM model catalog', () => {
  it('normalizes and deduplicates provider models', () => {
    expect(normalizeLiteLLMModels({ data: [
      { id: 'gpt-5.6', owned_by: 'openai' }, { id: 'gpt-5.6' }, { id: 'bad id' }, { id: '' },
    ] })).toEqual([{ modelId: 'gpt-5.6', ownedBy: 'openai' }]);
  });

  it('accepts only valid numeric LiteLLM per-token prices', () => {
    expect(normalizeLiteLLMModels({ data: [
      { id: 'priced', input_cost_per_token: 0.0000025, output_cost_per_token: 0 },
      { id: 'nested', model_info: { input_cost_per_token: 0.000001, output_cost_per_token: 0.000003 } },
      { id: 'unpriced', input_cost_per_token: '0.000001', output_cost_per_token: -1 },
    ] })).toEqual([
      { modelId: 'nested', inputCostPerToken: 0.000001, outputCostPerToken: 0.000003 },
      { modelId: 'priced', inputCostPerToken: 0.0000025, outputCostPerToken: 0 },
      { modelId: 'unpriced' },
    ]);
  });

  it('keeps policy aliases separate from direct models', () => {
    expect(isModelPolicyId('litellm-responses/smartest')).toBe(true);
    expect(isModelPolicyId('litellm-responses/gpt-5.6')).toBe(false);
  });

  it('uses the Team-scoped /models result as the direct-model visibility snapshot', async () => {
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ data: [{ id: 'gpt-5.6', owned_by: 'openai' }] }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ data: [
        { model_name: 'gpt-5.6', model_info: { input_cost_per_token: 0.0000025, output_cost_per_token: 0.00001 } },
        { model_name: 'not-team-visible', model_info: { input_cost_per_token: 1, output_cost_per_token: 1 } },
      ] }) }));
    await refreshLiteLLMModelCatalog();
    expect(mocks.save).toHaveBeenCalledWith(expect.objectContaining({
      pi: expect.arrayContaining([expect.objectContaining({ modelId: 'gpt-5.6', modelKind: 'direct', enabled: true, selectable: true, hidden: false, catalogInputCostPerToken: 0.0000025, catalogOutputCostPerToken: 0.00001 })]),
      litellmCatalog: expect.objectContaining({ syncedAt: expect.any(String) }),
    }));
    expect(mocks.save.mock.calls[0][0].pi.some((row: { modelId: string }) => row.modelId === 'not-team-visible')).toBe(false);
  });

  it('initializes Sol to high and Astra to low without replacing saved preferences on refresh', async () => {
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ data: [{ id: 'gpt-6-sol' }, { id: 'gpt-6-astra' }] }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ data: [] }) }));
    await refreshLiteLLMModelCatalog();
    const entries = mocks.save.mock.calls[0][0].pi;
    expect(entries.find((row: { modelId: string }) => row.modelId === 'gpt-6-sol').defaultReasoning).toBe('high');
    expect(entries.find((row: { modelId: string }) => row.modelId === 'gpt-6-astra').defaultReasoning).toBe('low');
  });

  it('does not reintroduce gpt55 when the Router still advertises the legacy alias', async () => {
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ data: [{ id: 'gpt55' }, { id: 'gpt-6-sol' }] }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ data: [] }) }));
    await refreshLiteLLMModelCatalog();
    expect(mocks.save.mock.calls[0][0].pi.some((row: { modelId: string }) => row.modelId === 'gpt55')).toBe(false);
  });

  it('does not expose a Tower-local visibility mutation for router models', () => {
    for (const id of ['smartest', 'smart', 'mini']) {
      expect(() => setLiteLLMModelSelectable(id, true)).toThrow('Team /models controls model visibility');
    }
  });

  it('does not allow a second Tower-local visibility toggle', () => {
    expect(() => setLiteLLMModelSelectable('gpt-5.6-sol', true)).toThrow('Team /models controls model visibility');
  });
});


describe('catalog token limits', () => {
  it('takes conservative explicit input/output limits and never interprets max_tokens as context', () => {
    const models = normalizeLiteLLMModels({ data: [
      { id: 'model-a', max_input_tokens: 922000, max_output_tokens: 128000 },
      { model_name: 'model-a', model_info: { max_input_tokens: 1000000, max_output_tokens: 64000 } },
      { id: 'unknown', max_tokens: 1000000, max_input_tokens: -1, max_output_tokens: '128000' },
    ] });
    expect(models[0]).toMatchObject({ contextWindow: 922000, maxTokens: 64000 });
    expect(models[1]).not.toHaveProperty('contextWindow');
    expect(models[1]).not.toHaveProperty('maxTokens');
  });

  it('fills missing limits while preserving explicit operator overrides', async () => {
    mocks.load.mockReturnValue({ claude: [], pi: [
      { provider: 'litellm-responses', modelId: 'existing', contextWindow: 400000, maxTokens: 32000 },
      { provider: 'litellm-responses', modelId: 'missing' },
    ], defaults: {} });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ data: [
      { id: 'existing', max_input_tokens: 922000, max_output_tokens: 128000 },
      { id: 'missing', max_input_tokens: 922000, max_output_tokens: 128000 },
      { id: 'new', max_input_tokens: 922000, max_output_tokens: 128000 },
    ] }) }));
    await refreshLiteLLMModelCatalog();
    const saved = mocks.save.mock.calls[0][0].pi;
    expect(saved.find((m: any) => m.modelId === 'existing')).toMatchObject({ contextWindow: 400000, maxTokens: 32000 });
    for (const id of ['missing', 'new']) expect(saved.find((m: any) => m.modelId === id)).toMatchObject({ contextWindow: 922000, maxTokens: 128000 });
  });
});

import { describe, expect, it } from 'vitest';
import type { loadModelsFile } from '../../config.js';
import { customerAiDefaults, initializeCustomerAiDefaults } from './customer-model-bootstrap.js';

type File = ReturnType<typeof loadModelsFile>;
const at = '2026-01-01T00:00:00.000Z';
const seed = (): File => ({
  claude: [], pi: [
    { provider: 'litellm-responses', modelId: 'gpt-6.1-sol', name: 'GPT-6.1 Sol', enabled: true, contextWindow: 922_000, maxTokens: 128_000, api: 'openai-responses' },
    { provider: 'openrouter', modelId: 'explicit-model', name: 'Explicit choice', enabled: true },
  ],
  defaults: { session: 'litellm-responses/gpt-6.1-sol', ai_task: 'litellm-responses/mini', ai_reply: 'litellm-responses/mini' },
});
const catalog = () => ({ data: [
  { id: 'gpt-6.1-sol', max_input_tokens: 922_000, max_output_tokens: 128_000 },
  { id: '~deepseek/deepseek-pro-latest', max_input_tokens: 1_048_576, max_output_tokens: 65_536, input_cost_per_token: 0.0000001901, output_cost_per_token: 0.0000042 },
  { id: 'z-ai/glm-5.3', max_input_tokens: 1_048_576, max_output_tokens: 131_072 },
] });

describe('customer first-connection model defaults', () => {
  it('initializes both Core and Lite to DeepSeek and keeps GPT/GLM selectable', () => {
    const previous = seed();
    const result = initializeCustomerAiDefaults(previous, catalog(), at);
    expect(result.initialized).toBe(true);
    expect(result.file.defaults).toMatchObject({ session: 'litellm-responses/~deepseek/deepseek-pro-latest', ai_task: 'litellm-responses/~deepseek/deepseek-pro-latest', ai_reply: 'litellm-responses/~deepseek/deepseek-pro-latest' });
    for (const id of customerAiDefaults.requiredModels) expect(result.file.pi.find(x => x.modelId === id)).toMatchObject({ provider: 'litellm-responses', selectable: true, enabled: true, hidden: false });
    expect(result.file.pi.find(x => x.modelId === 'gpt-6.1-sol')?.name).toBe('GPT-6.1 Sol');
    expect(result.file.pi.find(x => x.provider === 'openrouter')?.modelId).toBe('explicit-model');
    expect(result.file.customerAiBootstrap?.version).toBe(1);
    expect(previous).toEqual(seed());
  });
  it('maps all logical policy workloads consistently without enabling reserved Ultra', () => {
    const file = initializeCustomerAiDefaults(seed(), catalog(), at).file;
    for (const id of ['medium', 'high', 'extra-high', 'max', 'background', 'low', 'title', 'summary']) expect(file.modelPolicies?.policies[id].model).toBe('litellm-responses/~deepseek/deepseek-pro-latest');
    expect(file.modelPolicies?.policies.ultra.enabled).toBe(false);
  });
  it('does not reset a later administrator selection on re-entry', () => {
    const file = initializeCustomerAiDefaults(seed(), catalog(), at).file;
    file.defaults!.session = 'litellm-responses/z-ai/glm-5.3';
    file.defaults!.ai_task = 'litellm-responses/gpt-6.1-sol';
    file.modelPolicies!.policies.high.model = 'litellm-responses/z-ai/glm-5.3';
    const next = initializeCustomerAiDefaults(file, { data: [] }, '2026-02-01T00:00:00.000Z');
    expect(next.initialized).toBe(false);
    expect(next.file).toEqual(file);
    expect(next.file).not.toBe(file);
  });
  it('preserves an existing configured VM even without the new provenance field', () => {
    const file = seed();
    file.inferenceProviders = { 'litellm-responses': { baseUrl: 'https://router.example.com/v1', secretName: 'EXISTING_KEY_REFERENCE', configuredAt: at } };
    expect(initializeCustomerAiDefaults(file, catalog(), at)).toEqual({ file, initialized: false });
  });
  it('uses only actual Team-visible model IDs, not an assumed global catalog', () => {
    expect(() => initializeCustomerAiDefaults(seed(), { data: [{ id: 'gpt-6.1-sol' }] }, at)).toThrow('missing required');
    expect(() => initializeCustomerAiDefaults(seed(), { data: [{ id: 'deepseek-pro-latest' }, { id: 'glm-5.3' }, { id: 'gpt-6.1-sol' }] }, at)).toThrow('missing required');
  });
  it('keeps catalog-reported physical limits and prices instead of inventing them', () => {
    const file = initializeCustomerAiDefaults(seed(), catalog(), at).file;
    expect(file.pi.find(x => x.modelId === '~deepseek/deepseek-pro-latest')).toMatchObject({ contextWindow: 1_048_576, maxTokens: 65_536, catalogInputCostPerToken: 0.0000001901, catalogOutputCostPerToken: 0.0000042 });
  });
  it('rejects invalid timestamp and never mutates the input', () => {
    const file = seed();
    expect(() => initializeCustomerAiDefaults(file, catalog(), 'not-time')).toThrow('Invalid');
    expect(file).toEqual(seed());
  });
});

it('explicit GPT profile initializes Core and Lite without weakening normal defaults',()=>{
 const one={data:[{id:'gpt-6.1-sol'}]};
 expect(()=>initializeCustomerAiDefaults(seed(),one,at)).toThrow('missing required');
 const result=initializeCustomerAiDefaults(seed(),one,at,'gpt-only');
 expect(result.file.customerAiBootstrap).toMatchObject({coreModel:'litellm-responses/gpt-6.1-sol',liteModel:'litellm-responses/gpt-6.1-sol',visibleModelIds:['gpt-6.1-sol']});
 expect(result.file.defaults).toMatchObject({session:'litellm-responses/gpt-6.1-sol',ai_reply:'litellm-responses/gpt-6.1-sol',ai_task:'litellm-responses/gpt-6.1-sol'});
 expect(initializeCustomerAiDefaults(result.file,catalog(),at).initialized).toBe(false);
});

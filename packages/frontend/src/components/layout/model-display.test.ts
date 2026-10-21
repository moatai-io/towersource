import { describe, expect, it } from 'vitest';
import type { ModelOption } from '../../stores/model-store';
import { getModelDisplayName, getModelPriceLabel } from './model-display';

const t = (key: string) => ({
  coreRoute: 'Core',
  liteRoute: 'Lite',
} as Record<string, string>)[key] ?? key;

const option = (modelId: string, policyAlias?: ModelOption['policyAlias']): ModelOption => ({
  id: policyAlias ? `pi:preset/${policyAlias}` : `pi:litellm-responses/${modelId}`,
  name: modelId,
  badge: '',
  kind: policyAlias ? 'policy' : 'direct',
  policyAlias,
  runtimeModelId: policyAlias ? `litellm-responses/${modelId}` : undefined,
});

describe('model picker display names', () => {
  it('shows stable Tower aliases while keeping mapped runtime model IDs', () => {
    expect(getModelDisplayName(option('gpt-5.6-sol', 'core'), t)).toBe('Core - gpt-5.6-sol');
    expect(getModelDisplayName(option('gpt-5.6-luna', 'lite'), t)).toBe('Lite - gpt-5.6-luna');
    expect(getModelDisplayName(option('gpt-5.6-sol'), t)).toBe('gpt-5.6-sol');
    expect(option('gpt-5.6-sol', 'core').id).toBe('pi:preset/core');
    expect(option('gpt-5.6-sol', 'core').runtimeModelId).toBe('litellm-responses/gpt-5.6-sol');
  });

  it('follows updated mappings without changing preset identity', () => {
    const core = option('gpt-6-sol', 'core');
    expect(getModelDisplayName(core, t)).toBe('Core - gpt-6-sol');
    expect(getModelDisplayName({ ...core, runtimeModelId: 'pi:openrouter/moonshotai/kimi-k3' }, t)).toBe('Core - moonshotai/kimi-k3');
    expect(core.id).toBe('pi:preset/core');
    expect(getModelDisplayName(option('mini', 'lite'), t)).toBe('Lite - mini');
  });

  it('does not invent targets for missing or recursive mappings', () => {
    for (const runtimeModelId of [undefined, '', ' ', 'preset/core', 'policy/core', 'litellm-responses/']) {
      expect(getModelDisplayName({ ...option('gpt-6-sol', 'core'), runtimeModelId }, t)).toBe('Core');
    }
  });

  it('shows only reported pairs of token rates without inventing missing prices', () => {
    expect(getModelPriceLabel({ ...option('gpt-5.6-sol'), inputPricePerMillion: 2.5, outputPricePerMillion: 10 })).toEqual({ input: '2.5', output: '10.0' });
    expect(getModelPriceLabel({ ...option('gpt-5.6-sol'), inputPricePerMillion: 2.54, outputPricePerMillion: 12.26 })).toEqual({ input: '2.5', output: '12.3' });
    expect(getModelPriceLabel({ ...option('gpt-5.6-sol'), inputPricePerMillion: 2.5 })).toBeNull();
    expect(getModelPriceLabel({ ...option('gpt-5.6-sol'), inputPricePerMillion: 0, outputPricePerMillion: 0 })).toEqual({ input: '0.0', output: '0.0' });
  });
});

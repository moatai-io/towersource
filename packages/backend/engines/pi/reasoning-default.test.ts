import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ load: vi.fn() }));
vi.mock('../../config.js', () => ({ loadModelsFile: mocks.load }));
import { resolveTurnReasoning } from './reasoning-default.js';
beforeEach(() => mocks.load.mockReturnValue({ pi: [
  { provider: 'litellm-responses', modelId: 'gpt-6-sol', defaultReasoning: 'high', reasoning: true, reasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max'] },
  { provider: 'litellm-responses', modelId: 'gpt-6-astra', defaultReasoning: 'low', reasoning: true, reasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max'] },
] }));
describe('per-turn model reasoning defaults', () => {
  it('uses Sol high and Astra low, including model switches', () => {
    expect(resolveTurnReasoning({ provider: 'litellm-responses', id: 'gpt-6-sol' })).toBe('high');
    expect(resolveTurnReasoning({ provider: 'litellm-responses', id: 'gpt-6-astra' })).toBe('low');
  });
  it('reads a changed registry on the next turn', () => {
    const model = { provider: 'litellm-responses', id: 'gpt-6-sol' };
    expect(resolveTurnReasoning(model)).toBe('high');
    mocks.load.mockReturnValue({ pi: [{ ...model, modelId: model.id, defaultReasoning: 'xhigh', reasoning: true, reasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max'] }] });
    expect(resolveTurnReasoning(model)).toBe('xhigh');
  });
  it('preserves explicit execution policies including max', () => {
    for (const effort of ['low', 'medium', 'high', 'xhigh', 'max']) expect(resolveTurnReasoning(undefined, effort)).toBe(effort);
    expect(resolveTurnReasoning(undefined)).toBe('medium');
  });
});

import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ load: vi.fn() }));
vi.mock('../../config.js', () => ({ loadModelsFile: mocks.load }));
import { reasoningEffortsForChoice, reasoningEffortsForModel } from './reasoning-efforts.js';

const full = ['low', 'medium', 'high', 'xhigh', 'max'];
beforeEach(() => mocks.load.mockReturnValue({
  defaults: { session: 'litellm-responses/gpt-6-sol', ai_task: 'litellm-responses/gpt-6-luna' },
  pi: [
    { provider: 'litellm-responses', modelId: 'gpt-6-sol', reasoning: true, reasoningEfforts: full },
    { provider: 'litellm-responses', modelId: 'limited', reasoning: true, reasoningEfforts: ['low', 'medium'] },
    { provider: 'openrouter', modelId: 'plain', reasoning: false },
  ],
}));

describe('model reasoning effort capabilities', () => {
  it('resolves direct models and Core aliases to their exact capability', () => {
    expect(reasoningEffortsForChoice('preset/core')).toEqual(full);
    expect(reasoningEffortsForChoice(undefined)).toEqual(full);
    expect(reasoningEffortsForChoice('litellm-responses/limited')).toEqual(['low', 'medium']);
  });
  it('does not expose reasoning controls for non-reasoning models', () => {
    expect(reasoningEffortsForModel('openrouter', 'plain')).toEqual([]);
  });
});

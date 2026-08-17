import { describe, expect, it } from 'vitest';
import { resolveAgentExecutionPolicy, resolveModelPolicy } from './model-policy.js';

describe('model policy', () => {
  it('preserves medium as the default Smartest execution policy', () => {
    expect(resolveModelPolicy('medium')).toMatchObject({
      id: 'medium',
      revision: 1,
      effectiveModel: 'litellm-responses/smartest',
      requestedEffort: 'medium',
      effectiveEffort: 'medium',
      effortDowngraded: false,
    });
  });

  it('routes title work to the cheap utility model', () => {
    expect(resolveModelPolicy('title')).toMatchObject({
      effectiveModel: 'litellm-responses/mini',
      effectiveEffort: 'low',
    });
  });

  it('maps Extra High to Pi xhigh', () => {
    expect(resolveModelPolicy('extra-high')).toMatchObject({
      requestedEffort: 'xhigh',
      effectiveEffort: 'xhigh',
      effortDowngraded: false,
    });
  });

  it('keeps Max selectable while recording the current Pi downgrade to xhigh', () => {
    expect(resolveModelPolicy('max')).toMatchObject({
      requestedEffort: 'max',
      effectiveEffort: 'xhigh',
      effortDowngraded: true,
    });
  });

  it('keeps Ultra reserved and disabled', () => {
    expect(() => resolveModelPolicy('ultra')).toThrow('MODEL_POLICY_DISABLED: ultra');
  });

  it('lets an Agent override model and effort over a logical policy', () => {
    expect(resolveAgentExecutionPolicy({
      modelPolicy: 'high',
      model: 'litellm-responses/smart',
      effort: 'medium',
    })).toMatchObject({
      id: 'high',
      effectiveModel: 'litellm-responses/smart',
      requestedEffort: 'medium',
      effectiveEffort: 'medium',
    });
  });
});

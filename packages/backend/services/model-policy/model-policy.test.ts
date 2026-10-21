import { installModelRegistryFixture } from '../../__tests__/fixtures/model-registry.js';
import { beforeEach as beforeRegistryTest, afterEach as afterRegistryTest } from 'vitest';
beforeRegistryTest(() => { installModelRegistryFixture(); });
afterRegistryTest(() => vi.restoreAllMocks());
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as configuration from '../../config.js';
import { getModelDefaults, loadModelsFile } from '../../config.js';
import { resolveAgentExecutionPolicy, resolveModelPolicy } from './model-policy.js';

describe('model policy', () => {
  afterEach(() => vi.restoreAllMocks());

  it('routes background work to Core even when a legacy config still maps it to Lite', () => {
    const defaults = getModelDefaults();
    const file = loadModelsFile();
    vi.spyOn(configuration, 'loadModelsFile').mockReturnValue({
      ...file,
      modelPolicies: { revision: 42, policies: {
        background: { model: defaults.ai_task, effort: 'high' },
      } },
    });
    expect(resolveModelPolicy('background')).toMatchObject({
      revision: 42, requestedModel: defaults.session,
      effectiveModel: defaults.session, effectiveEffort: 'high',
    });
    // Lite utilities are unchanged, and explicit Agent model overrides remain explicit.
    expect(resolveModelPolicy('title').effectiveModel).toBe(defaults.ai_reply);
    expect(resolveModelPolicy('summary').effectiveModel).toBe(defaults.ai_reply);
    expect(resolveAgentExecutionPolicy({ modelPolicy: 'background', model: defaults.ai_task }).effectiveModel).toBe(defaults.ai_task);
  });

  it('uses Core for an unconfigured background policy without changing the effort', () => {
    const file = loadModelsFile();
    vi.spyOn(configuration, 'loadModelsFile').mockReturnValue({ ...file, modelPolicies: undefined });
    expect(resolveModelPolicy('background')).toMatchObject({ effectiveModel: getModelDefaults().session, effectiveEffort: 'medium' });
  });

  it('does not revive a disabled background policy', () => {
    const file = loadModelsFile();
    vi.spyOn(configuration, 'loadModelsFile').mockReturnValue({ ...file, modelPolicies: {
      revision: 42, policies: { background: { model: getModelDefaults().ai_task, effort: 'medium', enabled: false } },
    } });
    expect(() => resolveModelPolicy('background')).toThrow('MODEL_POLICY_DISABLED: background');
  });
  it('preserves medium as the default provider execution policy', () => {
    expect(resolveModelPolicy('medium')).toMatchObject({
      id: 'medium',
      revision: loadModelsFile().modelPolicies?.revision,
      effectiveModel: getModelDefaults().session,
      requestedEffort: 'medium',
      effectiveEffort: 'medium',
      effortDowngraded: false,
    });
  });

  it('routes title work to the configured default provider', () => {
    expect(resolveModelPolicy('title')).toMatchObject({
      effectiveModel: getModelDefaults().ai_reply,
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
      model: 'openrouter/openrouter/auto',
      effort: 'medium',
    })).toMatchObject({
      id: 'high',
      effectiveModel: 'openrouter/openrouter/auto',
      requestedEffort: 'medium',
      effectiveEffort: 'medium',
    });
  });
});

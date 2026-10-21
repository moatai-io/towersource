import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.stubGlobal('localStorage', {
  getItem: vi.fn(() => null),
  setItem: vi.fn(),
});

import { getNewSessionModel, reconcileSelectedModel, useModelStore } from './model-store';

describe('Core session model', () => {
  beforeEach(() => {
    useModelStore.setState({
      selectedModel: 'pi:some/old-model',
      availableModels: [],
      localModels: [],
      piModels: [{ id: 'pi:preset/core', name: 'Core', badge: '', policyAlias: 'core' }],
    });
  });

  it('uses the current Core preset regardless of the previously selected model', () => {
    expect(getNewSessionModel()).toBe('pi:preset/core');
  });

  it('recovers a missing selected model to Core', () => {
    reconcileSelectedModel();
    expect(useModelStore.getState().selectedModel).toBe('pi:preset/core');
  });
});

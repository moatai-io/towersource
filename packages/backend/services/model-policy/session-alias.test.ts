import fs from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { getModelDefaults, getModelsConfigPath } from '../../config.js';
import { choiceAfterPiTurn, isPiPresetMappingReady, persistPiSessionChoice, presetForPiTurn, presetMappingRevision, resolvePiSessionChoice } from './session-alias.js';

describe('Tower Core/Lite session intent', () => {
  it('ships GPT-6.1 Sol as Core and retires Smartest selections', () => {
    const packaged = JSON.parse(fs.readFileSync(new URL('../../models.json', import.meta.url), 'utf8'));
    expect(packaged.defaults.session).toBe('litellm-responses/gpt-6.1-sol');
    expect(packaged.pi.find((entry: { modelId: string }) => entry.modelId === 'gpt-6.1-sol')).toMatchObject({
      provider: 'litellm-responses', enabled: true, api: 'openai-responses',
    });
    expect(resolvePiSessionChoice('preset/core')).toBe(getModelDefaults().session);
    expect(persistPiSessionChoice('litellm-responses/smartest')).toBe('preset/core');
    expect(resolvePiSessionChoice('litellm-responses/smartest')).toBe(getModelDefaults().session);
    expect(Object.values(packaged.modelPolicies.policies).every((policy: any) => policy.model !== 'litellm-responses/smartest')).toBe(true);
  });
  it('retains an explicit alias across session creation, re-entry, and turn completion', () => {
    expect(persistPiSessionChoice('pi:preset/core')).toBe('preset/core');
    expect(persistPiSessionChoice('pi:policy/core')).toBe('preset/core');
    expect(resolvePiSessionChoice('preset/core')).toBe(getModelDefaults().session);
    expect(presetMappingRevision()).toBeGreaterThan(0);
    expect(isPiPresetMappingReady('preset/core')).toBe(true);
    expect(resolvePiSessionChoice('policy/core')).toBe(getModelDefaults().session);
    expect(presetForPiTurn('policy/core', 'litellm-responses/mini')).toBe('core');
    expect(choiceAfterPiTurn('policy/core', 'litellm-responses/mini', getModelDefaults().session)).toBe('preset/core');
    expect(presetForPiTurn(undefined, 'policy/core')).toBe('core');
    expect(choiceAfterPiTurn(undefined, 'policy/core', getModelDefaults().session)).toBe('preset/core');
    expect(persistPiSessionChoice('policy/lite')).toBe('preset/lite');
    expect(persistPiSessionChoice('preset/lite')).toBe('preset/lite');
    expect(resolvePiSessionChoice('policy/lite')).toBe(getModelDefaults().ai_task);
    expect(presetForPiTurn(undefined, 'policy/lite')).toBe('lite');
  });

  it('rejects missing or recursive preset mappings without changing the selected slot', () => {
    const configPath = getModelsConfigPath();
    const originalRead = fs.readFileSync;
    const source = JSON.parse(originalRead(configPath, 'utf8') as string);
    const spy = vi.spyOn(fs, 'readFileSync').mockImplementation(((file: any, ...args: any[]) =>
      String(file) === configPath ? JSON.stringify(source) : (originalRead as any)(file, ...args)) as typeof fs.readFileSync);
    try {
      source.defaults = { ...source.defaults, session: 'litellm-responses/absent' };
      expect(isPiPresetMappingReady('preset/core')).toBe(false);
      source.defaults.session = 'preset/core';
      expect(isPiPresetMappingReady('preset/core')).toBe(false);
      expect(isPiPresetMappingReady(undefined)).toBe(false);
      source.defaults.session = 'litellm-responses/gpt55';
      expect(isPiPresetMappingReady('preset/core')).toBe(false);
      expect(isPiPresetMappingReady('litellm-responses/gpt55')).toBe(false);
      source.defaults.session = '';
      expect(isPiPresetMappingReady(undefined)).toBe(false);
      expect(persistPiSessionChoice('preset/core')).toBe('preset/core');
      source.defaults.session = 'litellm-responses/smartest';
      expect(resolvePiSessionChoice('preset/core')).toBe('litellm-responses/smartest');
      source.defaults.session = 'litellm-responses/mini';
      expect(resolvePiSessionChoice('preset/core')).toBe('litellm-responses/mini');
      expect(persistPiSessionChoice('preset/core')).toBe('preset/core');
    } finally {
      spy.mockRestore();
    }
  });

  it('keeps absent and retired selections on Core after the first completed turn', () => {
    for (const choice of [undefined, null, 'litellm-responses/gpt55']) {
      expect(resolvePiSessionChoice(choice)).toBe(getModelDefaults().session);
      expect(presetForPiTurn(undefined, choice)).toBe('core');
      expect(choiceAfterPiTurn(undefined, choice, getModelDefaults().session)).toBe('preset/core');
    }
  });

  it('does not infer policy from a direct router model, even if it matches an alias target', () => {
    const direct = getModelDefaults().session;
    expect(presetForPiTurn(direct, 'policy/lite')).toBeUndefined();
    expect(choiceAfterPiTurn(direct, 'policy/lite', direct)).toBe(direct);
    expect(presetForPiTurn(undefined, direct)).toBeUndefined();
    expect(persistPiSessionChoice(direct)).toBe(direct);
  });
});

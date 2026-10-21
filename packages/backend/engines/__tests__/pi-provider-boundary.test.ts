import fs from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { isAllowedTowerPiModel, isAllowedTowerPiProvider } from '../pi/provider-boundary.js';
import { PiModelRegistryManager } from '../pi/model-registry.js';
import { quickReplyWithPiProviders } from '../pi/quick-reply.js';
import { getModelsConfigPath, isPiModelEntryEnabledForThisVm, normalizePiSessionModelId } from '../../config.js';

const retired = [
  'openai-codex/gpt-5.5',
  'azure-openai-responses/gpt-5.4',
  'azure-openai-responses-eastus2/gpt-5.5',
  'openai/gpt-5.5',
  'openai-responses-compatible/gpt-5.5',
  'codex-lb/gpt-5.5',
  'litellm/gpt-5.5',
  'litellm-responses/gpt55',
];

describe('Tower Pi provider boundary', () => {
  it('permits the Router and OpenRouter including Kimi', () => {
    for (const spec of ['litellm-responses/smartest', 'litellm-responses/mini', 'openrouter/moonshotai/kimi-k2.6']) {
      expect(isAllowedTowerPiModel(spec)).toBe(true);
      const [provider, ...ids] = spec.split('/');
      expect(isAllowedTowerPiProvider(provider)).toBe(true);
      expect(isPiModelEntryEnabledForThisVm({ provider, modelId: ids.join('/'), name: spec, enabled: true })).toBe(true);
    }
  });

  it.each(retired)('blocks stale VM model, resume and registry resolution: %s', (spec) => {
    const [provider, ...ids] = spec.split('/');
    expect(isAllowedTowerPiModel(spec)).toBe(false);
    expect(isPiModelEntryEnabledForThisVm({ provider, modelId: ids.join('/'), name: spec, enabled: true })).toBe(false);
    expect(normalizePiSessionModelId(spec)).toBe(normalizePiSessionModelId(null));
    const manager = new PiModelRegistryManager();
    // Even when an SDK built-in model exists, resolution cannot use it.
    expect(manager.resolvePiModel(spec)).toBeNull();
    expect(() => manager.resolveSessionModel(spec)).toThrow('retired');
  });

  it.each(retired)('quick reply rejects %s before fetching any provider', async (spec) => {
    const fetchMock = vi.spyOn(globalThis, 'fetch');
    try {
      await expect(quickReplyWithPiProviders('test', { model: spec, systemPrompt: '', onChunk: () => {} }, {} as any)).rejects.toThrow('retired');
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      fetchMock.mockRestore();
    }
  });

  it('rejects an allowed namespace using the wrong transport instead of silently switching models', () => {
    const manager = new PiModelRegistryManager();
    (manager as any).modelRegistry = {
      find: (_provider: string, id: string) => ({ id, provider: 'litellm-responses', api: 'azure-openai-responses' }),
      getAvailable: () => [],
    };
    expect(manager.resolvePiModel('litellm-responses/smartest')).toBeNull();
    expect(() => manager.resolveSessionModel('litellm-responses/smartest')).toThrow('not available');
  });

  it('resolves Core at each execution and never resolves the GPT-5.5 legacy mapping', () => {
    const configPath = getModelsConfigPath();
    const originalRead = fs.readFileSync;
    const source = JSON.parse(originalRead(configPath, 'utf8') as string);
    const spy = vi.spyOn(fs, 'readFileSync').mockImplementation(((file: any, ...args: any[]) =>
      String(file) === configPath ? JSON.stringify(source) : (originalRead as any)(file, ...args)) as typeof fs.readFileSync);
    const manager = new PiModelRegistryManager();
    const find = vi.fn((provider: string, id: string) => ({ provider, id, api: 'openai-responses' }));
    (manager as any).modelRegistry = { find };
    try {
      source.defaults.session = 'litellm-responses/mini';
      expect(manager.resolveSessionModel()).toMatchObject({ id: 'mini' });
      expect(manager.resolveSessionModel('preset/core')).toMatchObject({ id: 'mini' });
      source.defaults.session = 'litellm-responses/gpt55';
      find.mockClear();
      expect(() => manager.resolveSessionModel()).toThrow('MODEL_PRESET_UNAVAILABLE');
      expect(find).not.toHaveBeenCalled();
      source.defaults.session = '';
      expect(() => manager.resolveSessionModel('preset/core')).toThrow('MODEL_PRESET_UNAVAILABLE');
    } finally {
      spy.mockRestore();
    }
  });

  it('does not fall back to OpenRouter or another model when the configured Router default is missing', () => {
    const manager = new PiModelRegistryManager();
    (manager as any).modelRegistry = { find: () => null, getAvailable: () => [{ provider: 'openrouter', id: 'openrouter/auto', api: 'openai-completions' }] };
    expect(() => manager.resolveSessionModel()).toThrow('Configured Pi default is not available');
  });
});

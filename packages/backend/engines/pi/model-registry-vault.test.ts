import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ resolve: vi.fn(), setKey: vi.fn(), configured: vi.fn() }));
vi.mock('@earendil-works/pi-coding-agent', () => ({ ModelRegistry: class {}, ModelRuntime: class {} }));
vi.mock('../../services/credential-vault/credential-vault-service.js', () => ({ resolveProjectApiKeySecretValue: mocks.resolve }));
vi.mock('../../services/ai/inference-provider-setup.js', () => ({ resolveConfiguredInferenceProviderSecret: mocks.configured }));
import { PiModelRegistryManager } from './model-registry.js';

function manager() {
  const result = new PiModelRegistryManager();
  vi.spyOn(result, 'getModelRuntime').mockResolvedValue({ setRuntimeApiKey: mocks.setKey } as any);
  return result;
}
beforeEach(() => { vi.resetAllMocks(); });
describe('project Vault override behavior', () => {
  it('uses project and principal authorization context for explicit OpenRouter', async () => {
    mocks.resolve.mockResolvedValue({ value: 'synthetic-test-key', credentialId: 'fixture-key' });
    await manager().applyProjectVaultApiKeyOverrides({ projectId: 'project-fixture', userId: 123, model: 'openrouter/model-fixture' });
    expect(mocks.resolve).toHaveBeenCalledWith({ projectId: 'project-fixture', userId: 123, envName: 'OPENROUTER_API_KEY', targetType: 'pi-model-runtime:openrouter' });
    expect(mocks.setKey).toHaveBeenCalledWith('openrouter', 'synthetic-test-key');
  });
  it.each([undefined, 'preset/core', 'litellm-responses/model-fixture'])('does not query Vault for unsupported model %s', async model => {
    await manager().applyProjectVaultApiKeyOverrides({ projectId: 'project-fixture', userId: 123, model });
    expect(mocks.resolve).not.toHaveBeenCalled();
    expect(mocks.setKey).not.toHaveBeenCalled();
  });
  it('does not overwrite runtime credentials when no granted secret exists', async () => {
    mocks.resolve.mockResolvedValue(null);
    await manager().applyProjectVaultApiKeyOverrides({ projectId: 'project-fixture', userId: 123, model: 'openrouter/model-fixture' });
    expect(mocks.setKey).not.toHaveBeenCalled();
  });
  it('propagates resolver failure instead of manufacturing a credential', async () => {
    mocks.resolve.mockRejectedValue(new Error('fixture authorization failure'));
    await expect(manager().applyProjectVaultApiKeyOverrides({ projectId: 'project-fixture', userId: 123, model: 'openrouter/model-fixture' })).rejects.toThrow('fixture authorization failure');
    expect(mocks.setKey).not.toHaveBeenCalled();
  });
  it('applies VM fallback before project override and returns project provenance', async () => {
    mocks.configured.mockResolvedValue({ apiKey: 'synthetic-vm-key' });
    mocks.resolve.mockResolvedValue({ value: 'synthetic-project-key', credentialId: 'fixture-project-key' });
    const result = await manager().applyProjectVaultApiKeyOverrides({ projectId: 'project-fixture', userId: 123, model: 'openrouter/model-fixture' });
    expect(mocks.setKey.mock.calls).toEqual([['openrouter', 'synthetic-vm-key'], ['openrouter', 'synthetic-project-key']]);
    expect(result).toEqual([{ provider: 'openrouter', credentialId: 'fixture-project-key' }]);
  });
  it('does not resolve credentials without an authenticated user', async () => {
    await manager().applyProjectVaultApiKeyOverrides({ projectId: 'project-fixture', model: 'openrouter/model-fixture' });
    expect(mocks.configured).not.toHaveBeenCalled();
    expect(mocks.resolve).not.toHaveBeenCalled();
  });

});

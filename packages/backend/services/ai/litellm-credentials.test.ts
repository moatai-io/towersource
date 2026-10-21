import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ load: vi.fn(), secret: vi.fn() }));
vi.mock('../../config.js', () => ({ loadModelsFile: mocks.load }));
vi.mock('../secret/secret-store.js', () => ({ getSecret: mocks.secret }));
import { resolveLiteLLMCredentials } from './litellm-credentials.js';
beforeEach(() => {
  vi.resetAllMocks(); mocks.load.mockReturnValue({});
  vi.stubEnv('LITELLM_BASE_URL', 'https://router.example.com/v1');
  vi.stubEnv('LITELLM_API_KEY', 'synthetic-legacy');
});
afterEach(() => vi.unstubAllEnvs());
describe('VM LiteLLM credential boundary', () => {
  it('preserves legacy env without a binding', async () => {
    expect(await resolveLiteLLMCredentials()).toEqual({baseUrl:'https://router.example.com/v1',apiKey:'synthetic-legacy'});
    expect(mocks.secret).not.toHaveBeenCalled();
  });
  it('uses the explicit VM secret rather than legacy shared env', async () => {
    mocks.load.mockReturnValue({inferenceProviders:{'litellm-responses':{baseUrl:'https://private.example.com/v1/',secretName:'VM_TEST'}}});
    mocks.secret.mockResolvedValue('synthetic-vault');
    expect(await resolveLiteLLMCredentials()).toEqual({baseUrl:'https://private.example.com/v1',apiKey:'synthetic-vault'});
    expect(mocks.secret).toHaveBeenCalledWith('VM_TEST',0);
  });
  it('does not fall back or expose secret-store errors', async () => {
    mocks.load.mockReturnValue({inferenceProviders:{litellm:{baseUrl:'https://router.example.com',secretName:'VM_TEST'}}});
    mocks.secret.mockRejectedValue(new Error('sensitive-error-detail'));
    await expect(resolveLiteLLMCredentials()).rejects.toThrow('LiteLLM VM credential is unavailable');
  });
  it('rejects URLs containing embedded credentials', async () => {
    vi.stubEnv('LITELLM_BASE_URL','https://user:synthetic@example.com');
    await expect(resolveLiteLLMCredentials()).rejects.toThrow('LiteLLM VM connection is not configured');
  });
  it('rejects empty credentials', async () => {
    vi.stubEnv('LITELLM_API_KEY','');
    await expect(resolveLiteLLMCredentials()).rejects.toThrow('LiteLLM VM connection is not configured');
  });
});

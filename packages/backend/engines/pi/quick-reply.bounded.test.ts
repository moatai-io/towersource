import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
vi.mock('../../services/ai/litellm-credentials.js', () => ({ resolveLiteLLMCredentials: vi.fn().mockResolvedValue({ baseUrl: 'https://router.example.com', apiKey: 'synthetic-key' }) }));
vi.mock('./provider-boundary.js', () => ({ isAllowedTowerPiModel: vi.fn().mockReturnValue(true) }));
vi.mock('./provider-safeguards.js', () => ({ buildTowerPromptCacheKey: vi.fn() }));
vi.mock('../../services/ai/inference-provider-setup.js', () => ({ resolveConfiguredInferenceProviderSecret: vi.fn().mockResolvedValue({ apiKey: 'synthetic-key' }) }));
import { quickReplyWithPiProviders } from './quick-reply.js';
const fetchMock = vi.fn();
beforeEach(() => { vi.stubGlobal('fetch', fetchMock); fetchMock.mockReset(); });
afterEach(() => vi.unstubAllGlobals());
describe('bounded Pi tool-free quickReply', () => {
  it('passes Responses token cap and cancellation signal without adding tools', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ output: [{ type: 'message', content: [{ text: 'hello' }] }] }), { status: 200 }));
    const controller = new AbortController();
    expect(await quickReplyWithPiProviders('data', { model: 'litellm-responses/mini', systemPrompt: 'system', onChunk: () => {}, signal: controller.signal, maxOutputTokens: 500 }, {} as any)).toBe('hello');
    const [, init] = fetchMock.mock.calls[0]; const body = JSON.parse(init.body);
    expect(body.max_output_tokens).toBe(500); expect(body.tools).toBeUndefined();
    controller.abort(); expect(init.signal.aborted).toBe(true);
  });
  it('passes OpenRouter token cap and cancellation signal', async () => {
    const data = 'data: {"choices":[{"delta":{"content":"hello"}}]}\n\ndata: [DONE]\n';
    fetchMock.mockResolvedValue(new Response(data, { status: 200 }));
    const controller = new AbortController();
    expect(await quickReplyWithPiProviders('data', { model: 'openrouter/model', systemPrompt: 'system', onChunk: () => {}, signal: controller.signal, maxOutputTokens: 500 }, {} as any)).toBe('hello');
    const [, init] = fetchMock.mock.calls[0]; expect(init.signal).toBe(controller.signal);
    expect(JSON.parse(init.body).max_completion_tokens).toBe(500); expect(JSON.parse(init.body).tools).toBeUndefined();
  });
  it('fails before network for cancellation and invalid cap', async () => {
    const controller = new AbortController(); controller.abort();
    await expect(quickReplyWithPiProviders('data', { model: 'litellm-responses/mini', systemPrompt: 'sys', onChunk: () => {}, signal: controller.signal }, {} as any)).rejects.toThrow();
    await expect(quickReplyWithPiProviders('data', { model: 'litellm-responses/mini', systemPrompt: 'sys', onChunk: () => {}, maxOutputTokens: 9000 }, {} as any)).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

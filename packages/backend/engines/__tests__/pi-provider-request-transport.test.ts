import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { isContextOverflow } from '@earendil-works/pi-ai';
import { installPiProviderSafeguards, piFetchCorrelation } from '../pi/provider-safeguards.js';
import { classifyPiFailure } from '../pi-failure-classifier.js';

const savedFetch = globalThis.fetch;
let priorInstalled: unknown;
beforeEach(() => {
  priorInstalled = (globalThis as any).__piPhase0bInstalled;
  (globalThis as any).__piPhase0bInstalled = false;
  vi.stubEnv('PI_PROVIDER_MAX_REQUEST_BODY_BYTES', '1000');
});
afterEach(() => {
  globalThis.fetch = savedFetch;
  (globalThis as any).__piPhase0bInstalled = priorInstalled;
  vi.unstubAllEnvs();
});

describe('final provider transport admission and SDK recovery', () => {
  it('caps output for successive calls without changing input or abort signal', async () => {
    const upstream = vi.fn(async (_url: unknown, _init?: RequestInit) => new Response('{}'));
    globalThis.fetch = upstream as typeof fetch;
    installPiProviderSafeguards();
    const signal = new AbortController().signal;
    const input = [{ role: 'user', content: 'hello' }];
    await piFetchCorrelation.run({ sessionId: 'budget-test', runId: 'test', contextWindow: 10000 }, async () => {
      for (let i = 0; i < 2; i++) {
        await fetch('https://model.example.test/v1/responses', { method: 'POST', signal, body: JSON.stringify({ model: 'test', input, max_output_tokens: 128000 }) });
      }
    });
    expect(upstream).toHaveBeenCalledTimes(2);
    for (const [, init] of upstream.mock.calls) {
      const sent = JSON.parse(String(init?.body));
      expect(sent.max_output_tokens).toBeLessThan(9700);
      expect(sent.max_output_tokens).toBeGreaterThan(1024);
      expect(sent.input).toEqual(input);
      expect(init?.signal).toBe(signal);
    }
  });
  it.each([
    'https://openrouter.ai/api/v1/chat/completions',
    'https://model.example.test/v1/responses',
    'https://example.openai.azure.com/openai/responses',
    'https://chatgpt.com/backend-api/codex/responses',
  ])('blocks serialized body before upstream fetch on %s without changing original images', async url => {
    const upstream = vi.fn(async () => new Response('{}', { status: 200 }));
    globalThis.fetch = upstream as typeof fetch;
    installPiProviderSafeguards();
    const body = JSON.stringify({ model: 'test', input: [{ role: 'user', content: [
      { type: 'input_image', image_url: 'data:image/png;base64,' + 'A'.repeat(2000) },
    ] }] });
    const original = body;
    const response = await fetch(url, { method: 'POST', body });
    const error = await response.text();
    expect(upstream).not.toHaveBeenCalled();
    expect(response.status).toBe(422);
    expect(error).toContain('tower_transport_budget_exceeded');
    expect(isContextOverflow({ role: 'assistant', stopReason: 'error', errorMessage: `422 ${error}` } as any)).toBe(false);
    expect(classifyPiFailure(error)).toMatchObject({ kind: 'provider_request_too_large', recoverable: false });
    expect(body).toBe(original);
  });

  it('prevents native compaction on per-request image-count admission too', async () => {
    vi.stubEnv('PI_PROVIDER_MAX_REQUEST_BODY_BYTES', '100000');
    vi.stubEnv('PI_RESPONSES_MAX_INLINE_FILE_IMAGES', '2');
    const upstream = vi.fn(async () => new Response('{}', { status: 200 }));
    globalThis.fetch = upstream as typeof fetch; installPiProviderSafeguards();
    const body = JSON.stringify({ input: Array.from({ length: 3 }, () => ({ type: 'input_image', image_url: 'data:image/png;base64,AAAA' })) });
    const response = await fetch('https://model.example.test/v1/responses', { method: 'POST', body });
    const error = await response.text();
    expect(upstream).not.toHaveBeenCalled();
    expect(error).toContain('tower_transport_budget_exceeded');
    expect(isContextOverflow({ role: 'assistant', stopReason: 'error', errorMessage: error } as any)).toBe(false);
  });

  it('also checks a Request object without consuming its original body', async () => {
    const upstream = vi.fn(async () => new Response('{}', { status: 200 }));
    globalThis.fetch = upstream as typeof fetch; installPiProviderSafeguards();
    const request = new Request('https://model.example.test/v1/responses', {
      method: 'POST', body: JSON.stringify({ input: ['x'.repeat(2000)] }),
    });
    const response = await fetch(request);
    expect(response.status).toBe(422); expect(upstream).not.toHaveBeenCalled();
    expect(request.bodyUsed).toBe(false);
  });

  it('admits small provider requests and does not intercept unrelated uploads', async () => {
    const upstream = vi.fn(async () => new Response('{}', { status: 200 }));
    globalThis.fetch = upstream as typeof fetch; installPiProviderSafeguards();
    expect((await fetch('https://model.example.test/v1/responses', { method: 'POST', body: JSON.stringify({ input: ['hello'] }) })).status).toBe(200);
    expect((await fetch('https://app.example.test/api/attachments', { method: 'POST', body: 'a'.repeat(3000) })).status).toBe(200);
    expect(upstream).toHaveBeenCalledTimes(2);
  });

  it('distinguishes real upstream HTTP 413 from token overflow before native SDK sees it', async () => {
    const upstream = vi.fn(async () => new Response('nginx Request Entity Too Large', { status: 413 }));
    globalThis.fetch = upstream as typeof fetch; installPiProviderSafeguards();
    const response = await fetch('https://model.example.test/v1/responses', { method: 'POST', body: '{}' });
    const error = await response.text();
    expect(upstream).toHaveBeenCalledOnce(); expect(response.status).toBe(422);
    expect(error).not.toMatch(/request_too_large|Request Entity Too Large|413/);
    expect(isContextOverflow({ role: 'assistant', stopReason: 'error', errorMessage: error } as any)).toBe(false);
    expect(classifyPiFailure(error).recoverable).toBe(false);
  });
});

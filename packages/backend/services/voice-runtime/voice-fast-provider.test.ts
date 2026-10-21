import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const models = vi.hoisted(() => ({ entries: [{ provider: 'litellm-responses', modelId: 'fast-test', enabled: true, name: 'fixture' }] }));
vi.mock('../../config.js', () => ({ loadModelsFile: () => ({ pi: models.entries }), isPiModelEntryEnabledForThisVm: (entry: any) => entry.enabled }));
import { boundedVoiceFastReply } from '../../engines/pi/voice-fast-reply.js';
import { routeFastVoice } from './voice-fast-router.js';
const input = () => ({ model: 'litellm-responses/fast-test', systemPrompt: 'JSON only', intent: 'greeting', signal: new AbortController().signal, maxOutputTokens: 160 });
const message = (text = '{"kind":"direct","answer":"안녕"}') => ({ type: 'message', id: 'msg-fixture', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text, annotations: [] }] });
const terminal = (status = 'completed', output: unknown[] = [message()]) => ({ type: `response.${status}`, response: { id: 'resp-fixture', status, output, usage: { input_tokens: 8, output_tokens: 8, total_tokens: 16 } } });
function frames(...events: any[]) {
  return events.flatMap((e) => e.type === 'response.completed' || e.type === 'response.incomplete'
    ? [...(e.response.output || []).flatMap((item: unknown, output_index: number) => [{ type: 'response.output_item.added', output_index, item }, { type: 'response.output_item.done', output_index, item }]), e] : [e]);
}
function sse(...events: unknown[]) {
  return new Response(frames(...events).map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } });
}
async function wireBody(fetch: ReturnType<typeof vi.spyOn>) {
  const [url, init] = fetch.mock.calls[0] as unknown as [RequestInfo, RequestInit];
  return JSON.parse(typeof init?.body === 'string' ? init.body : await (url as Request).clone().text());
}
beforeEach(() => { vi.stubEnv('LITELLM_BASE_URL', 'https://router.example/v1'); vi.stubEnv('LITELLM_API_KEY', 'test-only'); models.entries[0].enabled = true; });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });
describe('actual Pi Responses SDK adapter with fake HTTP only', () => {
  it('sends stream=true, canonical intent, no tools, bounded tokens and opaque correlation', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(sse(terminal()));
    await expect(boundedVoiceFastReply(input())).resolves.toContain('direct');
    const body = await wireBody(fetch);
    expect(body).toMatchObject({ stream: true, tools: [], tool_choice: 'none', max_output_tokens: 160, store: false });
    expect(JSON.stringify(body.input)).toContain('greeting');
    expect(body.client_metadata).toEqual({ tower_request_kind: 'voice_fast', tower_voice_fast_request_id: expect.stringMatching(/^[a-f0-9-]{36}$/) });
    expect(body.client_metadata).not.toHaveProperty('tower_session_id');
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('rejects unregistered/disabled models and invalid limits before network', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch');
    await expect(boundedVoiceFastReply({ ...input(), model: 'litellm-responses/missing' })).rejects.toThrow();
    models.entries[0].enabled = false; await expect(boundedVoiceFastReply(input())).rejects.toThrow(); models.entries[0].enabled = true;
    for (const n of [NaN, -1, Infinity, 0]) await expect(boundedVoiceFastReply({ ...input(), maxOutputTokens: n })).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });
  it('does not retry a provider 502 or leak its error body', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{"error":{"message":"private-fixture-body"}}', { status: 502 }));
    await expect(boundedVoiceFastReply(input())).rejects.toThrow('VOICE_FAST_PROVIDER_FAILED');
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it.each([
    terminal('incomplete'),
    terminal('completed', [{ type: 'function_call', id: 'fc1', call_id: 'call1', name: 'forbidden', arguments: '{}' }]),
    { type: 'response.failed', response: { status: 'failed', error: { code: 'fixture', message: 'not-for-log' } } },
  ])('rejects incomplete/tool/failed terminal', async (event) => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(sse(event));
    await expect(boundedVoiceFastReply(input())).rejects.toThrow();
  });
  it('rejects premature EOF, malformed SSE and normalized output over 64KB', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(sse({ type: 'response.created', response: { id: 'r' } }))
      .mockResolvedValueOnce(new Response('data: not-json\n\n', { headers: { 'content-type': 'text/event-stream' } }))
      .mockResolvedValueOnce(sse(terminal('completed', [message('x'.repeat(64001))])));
    await expect(boundedVoiceFastReply(input())).rejects.toThrow();
    await expect(boundedVoiceFastReply(input())).rejects.toThrow();
    await expect(boundedVoiceFastReply(input())).rejects.toThrow('VOICE_FAST_RESPONSE_LIMIT');
  });
  it('returns no partial result before the terminal event', async () => {
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(new ReadableStream({ start(c) { controller = c; } }), { headers: { 'content-type': 'text/event-stream' } }));
    let finished = false;
    const pending = boundedVoiceFastReply(input()).then((v) => { finished = true; return v; });
    controller.enqueue(new TextEncoder().encode('data: '+JSON.stringify({ type: 'response.created', response: { id: 'r' } })+'\n\n'));
    await new Promise((r) => setTimeout(r, 20)); expect(finished).toBe(false);
    controller.enqueue(new TextEncoder().encode(frames(terminal()).map((e) => 'data: '+JSON.stringify(e)+'\n\n').join(''))); controller.close();
    await expect(pending).resolves.toContain('direct');
  });
  it('passes parent abort to the SDK HTTP request and rejects a late terminal', async () => {
    const abort = new AbortController(); let signal: AbortSignal | undefined;
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      signal = init?.signal as AbortSignal;
      return await new Promise<Response>((resolve, reject) => {
        signal!.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
      });
    });
    const pending = expect(boundedVoiceFastReply({ ...input(), signal: abort.signal })).rejects.toThrow();
    await vi.waitFor(() => expect(fetch).toHaveBeenCalled()); abort.abort(); await pending;
    expect(signal?.aborted).toBe(true); expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('aborts while reading an unfinished SDK response body', async () => {
    const abort = new AbortController(); let transportSignal: AbortSignal | undefined;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      transportSignal = init?.signal as AbortSignal;
      const body = new ReadableStream<Uint8Array>({ start(controller) {
        controller.enqueue(new TextEncoder().encode('data: '+JSON.stringify({ type: 'response.created', response: { id: 'r' } })+'\n\n'));
        transportSignal!.addEventListener('abort', () => controller.error(new DOMException('aborted', 'AbortError')), { once: true });
      } });
      return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
    });
    const pending = expect(boundedVoiceFastReply({ ...input(), signal: abort.signal })).rejects.toThrow();
    await vi.waitFor(() => expect(transportSignal).toBeDefined()); abort.abort(); await pending;
    expect(transportSignal?.aborted).toBe(true);
  });
  it('rejects a pre-cancelled request without any provider call', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch');
    const abort = new AbortController(); abort.abort();
    await expect(boundedVoiceFastReply({ ...input(), signal: abort.signal })).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });
  it('delegates an SDK-normalized refusal without authorizing speech', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(sse(terminal('completed', [{
      type: 'message', id: 'msg-refusal', role: 'assistant', status: 'completed',
      content: [{ type: 'refusal', refusal: 'synthetic refusal' }],
    }])));
    // The SDK normalizes refusal into text; the decision boundary must reject it.
    const result = await routeFastVoice({ identity: { sessionId: 's', voiceSessionId: 'v', userId: 1, turnId: 't', revision: 1 }, transcript: '안녕하세요', signal: new AbortController().signal },
      { config: { enabled: true, model: input().model, timeoutMs: 1500 }, authorize: async () => true,
        provider: { decide: (request) => boundedVoiceFastReply({ ...input(), signal: request.signal }) } });
    expect(result).toEqual({ kind: 'delegate', reason: 'invalid_result' });
  });
  it('delegates malformed decision/refusal text without accepting speech', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(sse(terminal('completed', [message('I cannot comply')])));
    const result = await routeFastVoice({ identity: { sessionId: 's', voiceSessionId: 'v', userId: 1, turnId: 't', revision: 1 }, transcript: '안녕하세요', signal: new AbortController().signal },
      { config: { enabled: true, model: input().model, timeoutMs: 1500 }, authorize: async () => true,
        provider: { decide: (request) => boundedVoiceFastReply({ ...input(), signal: request.signal }) } });
    expect(result).toEqual({ kind: 'delegate', reason: 'invalid_result' });
  });
});

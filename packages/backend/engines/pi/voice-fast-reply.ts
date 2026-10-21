/** Stateless, tool-free fast reply using the same Pi Responses streamer as Session inference.
 * Never creates/mutates a Pi Session. SDK retries are off; remote retry/cancel policy is separate.
 */
import { randomUUID } from 'node:crypto';
import { stream as streamResponses } from '@earendil-works/pi-ai/api/openai-responses';
import { normalizeContext } from '@earendil-works/pi-ai';
import type { Model } from '@earendil-works/pi-ai';
import { loadModelsFile, isPiModelEntryEnabledForThisVm } from '../../config.js';

export async function boundedVoiceFastReply(input: {
  model: string; systemPrompt: string; intent: string; signal: AbortSignal; maxOutputTokens: number;
}): Promise<unknown> {
  if (!input.model.startsWith('litellm-responses/')) throw new Error('VOICE_FAST_MODEL_UNSUPPORTED');
  const modelId = input.model.slice('litellm-responses/'.length);
  const entry = loadModelsFile().pi.find((m) => m.provider === 'litellm-responses'
    && m.modelId === modelId && m.enabled === true && isPiModelEntryEnabledForThisVm(m));
  if (!entry) throw new Error('VOICE_FAST_MODEL_UNREGISTERED');
  if (!Number.isFinite(input.maxOutputTokens) || input.maxOutputTokens < 1) throw new Error('VOICE_FAST_INVALID_LIMIT');
  input.signal.throwIfAborted();
  const baseUrl = (process.env.LITELLM_BASE_URL || '').replace(/\/$/, '');
  const apiKey = process.env.LITELLM_API_KEY;
  if (!baseUrl || !apiKey) throw new Error('VOICE_FAST_CREDENTIAL_MISSING');
  const maxTokens = Math.min(Math.floor(input.maxOutputTokens), 160);
  const model: Model<'openai-responses'> = {
    id: modelId, name: entry.name || modelId, provider: entry.provider, api: 'openai-responses', baseUrl,
    reasoning: entry.reasoning ?? false, input: ['text'],
    cost: entry.cost || { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: entry.contextWindow ?? 400_000, maxTokens: entry.maxTokens ?? 128_000,
  };
  const controller = new AbortController();
  const abort = () => controller.abort();
  input.signal.addEventListener('abort', abort, { once: true });
  if (input.signal.aborted) abort();
  // Safety ceiling for standalone callers; routeFastVoice retains its shorter 1500ms budget.
  const deadline = setTimeout(abort, 3000);
  const requestId = randomUUID();
  try {
    const events = streamResponses(model, normalizeContext({
      messages: [
        { role: 'system', content: input.systemPrompt, timestamp: Date.now() },
        { role: 'user', content: input.intent, timestamp: Date.now() },
      ],
    }), {
      apiKey, signal: controller.signal, timeoutMs: 3000, maxRetries: 0,
      maxTokens, toolChoice: 'none', headers: { 'x-client-request-id': requestId },
      onPayload: (payload) => ({
        ...(payload as Record<string, unknown>), stream: true, store: false,
        tools: [], tool_choice: 'none', max_output_tokens: maxTokens,
        text: { format: { type: 'json_object' } },
        client_metadata: { tower_voice_fast_request_id: requestId, tower_request_kind: 'voice_fast' },
      }),
    });
    for await (const event of events) {
      controller.signal.throwIfAborted();
      if (event.type === 'error') {
        // SDK errorMessage may contain provider bodies. Never propagate it to logs or callers.
        throw new Error('VOICE_FAST_PROVIDER_FAILED');
      }
      const message = event.type === 'done' ? event.message : event.partial;
      if (message.content.some((block) => block.type === 'toolCall')) throw new Error('VOICE_FAST_NON_TEXT_OUTPUT');
      // Bound normalized output (including reasoning); no delta is emitted or stored.
      const bytes = message.content.reduce((sum, block) => sum + Buffer.byteLength(
        block.type === 'text' ? block.text : block.type === 'thinking' ? block.thinking : '', 'utf8'), 0);
      if (bytes > 64_000) throw new Error('VOICE_FAST_RESPONSE_LIMIT');
      if (event.type === 'done') {
        if (event.reason !== 'stop') throw new Error('VOICE_FAST_INCOMPLETE');
        const text = event.message.content.filter((block) => block.type === 'text').map((block) => block.text).join('').trim();
        if (!text) throw new Error('VOICE_FAST_EMPTY_RESPONSE');
        // Final decision schema/auth validation belongs to routeFastVoice, before durable commit.
        return text;
      }
    }
    throw new Error('VOICE_FAST_INCOMPLETE');
  } finally {
    clearTimeout(deadline);
    input.signal.removeEventListener('abort', abort);
    controller.abort();
  }
}

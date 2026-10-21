import { resolveLiteLLMCredentials } from '../../services/ai/litellm-credentials.js';
// Owns stateless quick-reply provider calls for PiEngine.
// Public API: quickReplyWithPiProviders.

import crypto from 'crypto';
import type { QuickReplyOpts } from '../types.js';
import type { PiModelRegistryManager } from './model-registry.js';
import { buildTowerPromptCacheKey } from './provider-safeguards.js';
import { isAllowedTowerPiModel } from './provider-boundary.js';
import { resolveConfiguredInferenceProviderSecret } from '../../services/ai/inference-provider-setup.js';

export async function quickReplyWithPiProviders(
  prompt: string,
  opts: QuickReplyOpts,
  _modelRegistryManager: PiModelRegistryManager,
): Promise<string> {
  opts.signal?.throwIfAborted();
  if (opts.maxOutputTokens !== undefined && (!Number.isInteger(opts.maxOutputTokens) || opts.maxOutputTokens < 1 || opts.maxOutputTokens > 2048)) {
    throw new Error('Invalid utility output token limit');
  }
  const modelStr = opts.model || '';
  if (!isAllowedTowerPiModel(modelStr)) throw new Error(`Direct Pi provider is retired: ${modelStr || '<unset>'}`);
  if (modelStr.startsWith('litellm-responses/')) {
    return quickReplyLiteLLMResponses(prompt, opts, modelStr.slice('litellm-responses/'.length));
  }

  // OpenRouter is the only supported direct Pi quick-reply endpoint.
  const apiKey = process.env.OPENROUTER_API_KEY
    || (await resolveConfiguredInferenceProviderSecret('openrouter', 0))?.apiKey;
  if (!apiKey) throw new Error('OpenRouter credential not configured for Pi quick reply');
  const modelId = modelStr.slice('openrouter/'.length);
  return streamChatCompletion(prompt, opts, 'https://openrouter.ai/api/v1/chat/completions', {
    'Authorization': `Bearer ${apiKey}`,
  }, modelId);
}

function buildUtilityPromptCacheKey(prompt: string, systemPrompt: string): string {
  const digest = crypto
    .createHash('sha256')
    .update(`tower-pi-utility-cache:v1:${systemPrompt}\n---\n${prompt}`)
    .digest('base64url')
    .slice(0, 24);
  return `pcache:v2:litellm-responses:util-${digest}`;
}

async function quickReplyLiteLLMResponses(prompt: string, opts: QuickReplyOpts, modelId: string): Promise<string> {
  const { baseUrl, apiKey } = await resolveLiteLLMCredentials();
  const promptCacheKey = buildTowerPromptCacheKey(opts.logicalSessionId)
    ?? buildUtilityPromptCacheKey(prompt, opts.systemPrompt);
  const controller = new AbortController();
  const signal = opts.signal ? AbortSignal.any([controller.signal, opts.signal]) : controller.signal;
  const timeout = setTimeout(() => controller.abort(), 30_000);
  let response: Response;
  try {
    response = await fetch(`${baseUrl}/responses`, {
      method: 'POST',
      signal,
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: modelId,
        prompt_cache_key: promptCacheKey,
        max_output_tokens: opts.maxOutputTokens ?? 2048,
        input: [
          { role: 'system', content: opts.systemPrompt },
          { role: 'user', content: prompt },
        ],
      }),
    });
  } catch (err: any) {
    if (err?.name === 'AbortError') {
      throw new Error('LiteLLM Responses quickReply timeout after 30s');
    }
    throw err;
  } finally {
    clearTimeout(timeout);
  }

  if (!response.ok) {
    const errBody = await response.text();
    throw new Error(`LiteLLM Responses API error ${response.status}: ${errBody.slice(0, 500)}`);
  }

  const payload = await response.json();
  const text = extractResponsesText(payload);
  if (text) {
    try { opts.onChunk(text, text); } catch (cbErr) {
      console.warn('[Pi] onChunk callback error (responses quickReply continues):', (cbErr as Error).message);
    }
  }
  return text;
}

function extractResponsesText(payload: any): string {
  if (typeof payload?.output_text === 'string' && payload.output_text.trim()) return payload.output_text;
  const parts: string[] = [];
  for (const item of payload?.output || []) {
    for (const content of item?.content || []) {
      if (typeof content?.text === 'string') parts.push(content.text);
    }
  }
  return parts.join('').trim();
}

async function streamChatCompletion(
  prompt: string,
  opts: QuickReplyOpts,
  url: string,
  extraHeaders: Record<string, string>,
  modelId: string,
): Promise<string> {
  const CHUNK_TIMEOUT_MS = 30_000; // 30s — no chunk for this long = dead stream

  const response = await fetch(url, {
    method: 'POST',
    signal: opts.signal,
    headers: { 'Content-Type': 'application/json', ...extraHeaders },
    body: JSON.stringify({
      model: modelId,
      max_completion_tokens: opts.maxOutputTokens ?? 2048,
      stream: true,
      messages: [
        { role: 'system', content: opts.systemPrompt },
        { role: 'user', content: prompt },
      ],
    }),
  });

  if (!response.ok) {
    const errBody = await response.text();
    throw new Error(`API error ${response.status}: ${errBody.slice(0, 500)}`);
  }

  const reader = response.body?.getReader();
  if (!reader) throw new Error('No response body');

  const decoder = new TextDecoder();
  let buffer = '';
  let fullContent = '';

  try {
    while (true) {
      // Race between next chunk and timeout — prevents infinite hang
      const readPromise = reader.read();
      const timeoutPromise = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`Pi stream timeout: no data for ${CHUNK_TIMEOUT_MS / 1000}s`)), CHUNK_TIMEOUT_MS),
      );
      const { done, value } = await Promise.race([readPromise, timeoutPromise]);
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const jsonStr = line.slice(6).trim();
        if (jsonStr === '[DONE]') continue;

        try {
          const event = JSON.parse(jsonStr);
          const delta = event.choices?.[0]?.delta?.content;
          if (delta) {
            fullContent += delta;
            // Protect callback — broadcast failure must not kill the stream
            try {
              opts.onChunk(delta, fullContent);
            } catch (cbErr) {
              console.warn('[Pi] onChunk callback error (stream continues):', (cbErr as Error).message);
            }
          }
        } catch { /* skip malformed SSE line */ }
      }
    }
  } catch (err) {
    // Stream interrupted — log and return whatever we got so far
    const msg = (err as Error).message || 'unknown stream error';
    if (fullContent.length > 0) {
      console.warn(`[Pi] Stream interrupted after ${fullContent.length} chars: ${msg}`);
    } else {
      // No content at all — rethrow so caller can handle (e.g. show error in channel)
      throw new Error(`Pi stream failed: ${msg}`);
    }
  } finally {
    // Always release the reader — prevents resource leaks
    try { reader.cancel(); } catch { /* already closed */ }
  }

  return fullContent;
}

// Compatibility export for existing bounded callers; transport lives with the Pi streamer.
export { boundedVoiceFastReply } from './voice-fast-reply.js';

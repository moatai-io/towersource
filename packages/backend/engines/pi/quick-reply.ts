// Owns stateless quick-reply provider calls for PiEngine.
// Public API: quickReplyWithPiProviders.

import crypto from 'crypto';
import { loadModelsFile, type PiModelEntry } from '../../config.js';
import type { QuickReplyOpts } from '../types.js';
import type { PiModelRegistryManager } from './model-registry.js';
import { buildTowerPromptCacheKey } from './provider-safeguards.js';

export async function quickReplyWithPiProviders(
  prompt: string,
  opts: QuickReplyOpts,
  modelRegistryManager: PiModelRegistryManager,
): Promise<string> {
  // Parse model provider: "litellm-responses/mini" or emergency "azure-openai-responses-eastus2/gpt-5.5".
  const modelStr = opts.model || '';
  const isAzure = modelStr.startsWith('azure-openai-responses/');
  const isLiteLLMChat = modelStr.startsWith('litellm/');
  const isLiteLLMResponses = modelStr.startsWith('litellm-responses/');

  if (isAzure) {
    return quickReplyAzure(prompt, opts, modelStr.slice('azure-openai-responses/'.length), modelRegistryManager);
  }

  if (isLiteLLMChat) {
    const modelId = modelStr.slice('litellm/'.length);
    return quickReplyLiteLLMChat(prompt, opts, modelId);
  }

  if (isLiteLLMResponses) {
    const modelId = modelStr.slice('litellm-responses/'.length);
    return quickReplyLiteLLMResponses(prompt, opts, modelId);
  }

  // Pi quick reply: use OpenRouter API directly (lightweight, no session needed)
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) throw new Error('OPENROUTER_API_KEY not configured for Pi quick reply');

  // Legacy direct OpenRouter support remains for explicit operator debug calls.
  let modelId = modelStr;
  if (modelId.startsWith('openrouter/')) modelId = modelId.slice('openrouter/'.length);
  if (!modelId) {
    // Fallback to first available Pi model
    const registry = modelRegistryManager.getModelRegistry();
    const available = registry.getAvailable();
    if (available.length > 0) modelId = `${available[0].provider === 'openrouter' ? '' : ''}${available[0].id}`;
    else throw new Error('No AI Router models available');
  }

  return streamChatCompletion(prompt, opts, 'https://openrouter.ai/api/v1/chat/completions', {
    'Authorization': `Bearer ${apiKey}`,
  }, modelId);
}

function resolveLiteLLMCredentials(): { baseUrl: string; apiKey: string } {
  const baseUrl = (process.env.LITELLM_BASE_URL || '').replace(/\/$/, '');
  const apiKey = process.env.LITELLM_API_KEY || '';
  if (!baseUrl) throw new Error('LITELLM_BASE_URL not configured for Pi quick reply');
  if (!apiKey) throw new Error('LITELLM_API_KEY not configured for Pi quick reply');
  return { baseUrl, apiKey };
}

async function quickReplyLiteLLMChat(prompt: string, opts: QuickReplyOpts, modelId: string): Promise<string> {
  const { baseUrl, apiKey } = resolveLiteLLMCredentials();
  return streamChatCompletion(prompt, opts, `${baseUrl}/chat/completions`, {
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
  const { baseUrl, apiKey } = resolveLiteLLMCredentials();
  const promptCacheKey = buildTowerPromptCacheKey(opts.logicalSessionId)
    ?? buildUtilityPromptCacheKey(prompt, opts.systemPrompt);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30_000);
  let response: Response;
  try {
    response = await fetch(`${baseUrl}/responses`, {
      method: 'POST',
      signal: controller.signal,
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: modelId,
        prompt_cache_key: promptCacheKey,
        max_output_tokens: 2048,
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

async function quickReplyAzure(
  prompt: string,
  opts: QuickReplyOpts,
  modelId: string,
  modelRegistryManager: PiModelRegistryManager,
): Promise<string> {
  // Look up region from models.json (same source of truth as registerCustomModels).
  // 2026-05-17: provider name suffix (azure-openai-responses-<region>) 우선,
  // 옛 `region` 필드는 backward-compat fallback. gpt-5.5 는 eastus2 / 기본은 koreacentral.
  const piEntries = (loadModelsFile().pi || []) as PiModelEntry[];
  const entry = piEntries.find(e => e.modelId === modelId);
  const regionFromProvider = entry?.provider?.startsWith('azure-openai-responses-')
    ? entry.provider.substring('azure-openai-responses-'.length)
    : undefined;
  const region = regionFromProvider ?? entry?.region;
  const { baseUrl, apiKey, apiVersion } = modelRegistryManager.resolveAzureRegion(region);
  if (!apiKey)  throw new Error(`Azure apiKey missing for region=${region ?? 'default'} (modelId=${modelId})`);
  if (!baseUrl) throw new Error(`Azure baseUrl missing for region=${region ?? 'default'} (modelId=${modelId})`);

  // Resolve deployment name via AZURE_OPENAI_DEPLOYMENT_NAME_MAP (e.g. "gpt-5.4=gpt-54-tower")
  const deploymentName = modelRegistryManager.resolveAzureDeployment(modelId);

  // Strip trailing /openai if present (Pi SDK expects it in AZURE_OPENAI_BASE_URL, but chat completions URL includes /openai/)
  const rawBase = baseUrl.replace(/\/openai$/, '');
  const url = `${rawBase}/openai/deployments/${deploymentName}/chat/completions?api-version=${apiVersion}`;
  return streamChatCompletion(prompt, opts, url, { 'api-key': apiKey }, modelId);
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
    headers: { 'Content-Type': 'application/json', ...extraHeaders },
    body: JSON.stringify({
      model: modelId,
      max_completion_tokens: 2048,
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

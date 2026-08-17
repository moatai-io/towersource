/**
 * Owns Pi provider request/response safeguards.
 * Public API: installPiProviderSafeguards, piFetchCorrelation, context-token hints, allowPiOpenAiDirect.
 *
 * This module contains provider-specific patches and observability that sit
 * around the Pi SDK transport layer. Keep it operational/transport-focused:
 * no product/workflow judgement belongs here.
 */

import { AsyncLocalStorage } from 'async_hooks';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { config } from '../../config.js';
import { recordAgentTurnRouterEvidence, type RouterTerminalType } from '../../services/agent-turn/router-evidence.js';

/**
 * Rough token estimate for OpenAI-compatible request bodies.
 *
 * Purpose: dynamic output-token clamping. OpenRouter validates
 *   prompt tokens + tool schema tokens + requested output tokens <= context window.
 * Pi SDK defaults request max tokens to model.maxTokens, so a model with max output
 * close to its full context (Kimi K2.6: 262k/262k) can overflow after only a few
 * tool iterations unless we reserve room for the already-built prompt.
 *
 * This intentionally overestimates a little: CJK chars are often close to 1 token,
 * ASCII is roughly 4 chars/token, and JSON/tool overhead is real for Chat Completions.
 */
function estimateOpenRouterRequestTokens(messages: any[], tools: any[]): number {
  const text = JSON.stringify({ messages: messages || [], tools: tools || [] });
  let estimated = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0) || 0;
    estimated += code > 0x7f ? 1 : 0.25;
  }
  // Per-message/tool-call overhead + safety margin. This tracks OpenRouter's
  // tokenizer better than chars/4 for Korean-heavy/system-prompt-heavy payloads.
  const structuralOverhead = (messages?.length || 0) * 8 + (tools?.length || 0) * 24 + 2048;
  return Math.ceil((estimated + structuralOverhead) * 1.15);
}

function chatCompletionsContextWindow(modelId: string): number | null {
  const id = String(modelId || '');
  // OpenRouter public pages report Kimi K2.6 total context 262,144 and Kimi K3 1,048,576.
  if (id === 'moonshotai/kimi-k2.6') return 262_144;
  if (id === 'moonshotai/kimi-k3') return 1_048_576;
  // Legacy litellm/smart used Chat Completions and sent the bare model id
  // ('smart') in the request body. Keep this defensive clamp for explicit
  // operator/debug calls even though the default catalog now exposes only
  // litellm-responses/smartest and litellm-responses/mini.
  if (id === 'smart') return 262_142;
  // Keep this map small and explicit; unknown models are observed only, not mutated.
  return null;
}

function clampChatCompletionsOutputTokens(bodyObj: any): { mutated: boolean; reason?: string } {
  const contextWindow = chatCompletionsContextWindow(String(bodyObj?.model || ''));
  if (!contextWindow) return { mutated: false };
  const requested = Number(bodyObj.max_completion_tokens ?? bodyObj.max_tokens ?? 0);
  if (!Number.isFinite(requested) || requested <= 0) return { mutated: false };

  const estimatedPrompt = estimateOpenRouterRequestTokens(bodyObj.messages || [], bodyObj.tools || []);
  // Margin: reserve headroom so prompt + clamped output stays clear of the window
  // even when our chars/token estimate runs a little low. Raised 1024 -> 4096
  // (2026-05-30) when the LiteLLM completions path was wired into this clamp.
  const reserve = 4096;
  const available = Math.max(1024, contextWindow - estimatedPrompt - reserve);
  const capped = Math.min(requested, available);
  if (capped >= requested) return { mutated: false };

  if ('max_completion_tokens' in bodyObj) bodyObj.max_completion_tokens = capped;
  else bodyObj.max_tokens = capped;
  return {
    mutated: true,
    reason: `max_tokens ${requested}->${capped} (estimatedPrompt=${estimatedPrompt}, context=${contextWindow})`,
  };
}

function estimateOpenAIResponsesRequestTokens(bodyObj: any): number {
  const text = JSON.stringify({
    instructions: bodyObj?.instructions,
    input: bodyObj?.input || [],
    tools: bodyObj?.tools || [],
  });
  let estimated = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0) || 0;
    estimated += code > 0x7f ? 1 : 0.25;
  }
  const inputCount = Array.isArray(bodyObj?.input) ? bodyObj.input.length : 0;
  const toolCount = Array.isArray(bodyObj?.tools) ? bodyObj.tools.length : 0;
  const structuralOverhead = inputCount * 10 + toolCount * 32 + 4096;
  return Math.ceil((estimated + structuralOverhead) * 1.2);
}

function openAIResponsesContextWindow(modelId: string, url: string): number | null {
  const model = modelId.toLowerCase();
  // LiteLLM/Codex-LB aliases currently route to Codex-family Responses models.
  // Codex CLI applies a 95% effective-window guard. Use the effective window so
  // output clamping leaves room for SDK compaction before the hard edge.
  // - gpt-5.5 / gpt-5.4-mini catalog: 272000 * 0.95 = 258400
  // - gpt-5.6 Sol/Terra catalog: 372000 * 0.95 = 353400
  // - smartest-long operator override: 800000 * 0.95 = 760000
  if (model === 'smartest-long') return 760_000;
  if (model === 'smartest' || model === 'smart' || model === 'gpt-5.6-sol' || model === 'gpt-5.6-terra') return 353_400;
  if (model === 'gpt55' || model === 'mini' || model === 'gpt-5.5') return 258_400;
  if (/chatgpt\.com\/backend-api\/codex\/responses/i.test(url)) {
    return model === 'gpt-5.6-sol' || model === 'gpt-5.6-terra' ? 353_400 : 258_400;
  }
  if (/openai\.azure\.com|cognitive\.microsoft\.com\/openai/i.test(url)) return 400_000;
  return null;
}

function getPiContextHintMap(): Map<string, number> {
  const g = globalThis as any;
  if (!g.__piContextTokenHints) g.__piContextTokenHints = new Map<string, number>();
  return g.__piContextTokenHints;
}

export function rememberPiContextTokenHint(key: string | undefined | null, tokens: number): void {
  if (!key || !Number.isFinite(tokens) || tokens <= 0) return;
  const hints = getPiContextHintMap();
  // Latest provider usage is the best hint: after a successful compaction the
  // live context can drop sharply, so do not keep a historical max forever.
  hints.set(String(key), Math.ceil(tokens));
  // Avoid unbounded growth on busy multi-session servers.
  if (hints.size > 500) {
    const first = hints.keys().next().value;
    if (first) hints.delete(first);
  }
}

export function getPiContextTokenHint(key: string | undefined | null): number | undefined {
  if (!key) return undefined;
  return getPiContextHintMap().get(String(key));
}

export function forgetPiContextTokenHint(key: string | undefined | null): void {
  if (!key) return;
  getPiContextHintMap().delete(String(key));
}

export function inspectResponsesFileRepresentations(bodyObj: any): {
  imageItems: number;
  imageBytes: number;
  rejected: boolean;
  reason?: string;
} {
  let imageItems = 0;
  let imageBytes = 0;
  const visit = (value: any): void => {
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value)) { value.forEach(visit); return; }
    const imageUrl = typeof value.image_url === 'string'
      ? value.image_url
      : typeof value.url === 'string' && value.type === 'input_image'
        ? value.url
        : undefined;
    if (imageUrl?.startsWith('data:image/') && imageUrl.includes(';base64,')) {
      imageItems += 1;
      const data = imageUrl.slice(imageUrl.indexOf(',') + 1).replace(/\s/g, '');
      const padding = data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0;
      imageBytes += Math.max(0, Math.floor((data.length * 3) / 4) - padding);
    }
    Object.values(value).forEach(visit);
  };
  visit(bodyObj?.input || []);
  const maxItems = Number(process.env.PI_RESPONSES_MAX_INLINE_FILE_IMAGES || 24);
  const maxBytes = Number(process.env.PI_RESPONSES_MAX_INLINE_FILE_IMAGE_BYTES || 48 * 1024 * 1024);
  const rejected = imageItems > maxItems || imageBytes > maxBytes;
  return {
    imageItems,
    imageBytes,
    rejected,
    reason: rejected ? `inline file image budget exceeded (${imageItems}/${maxItems} images, ${imageBytes}/${maxBytes} bytes)` : undefined,
  };
}

function shouldRejectNearContextOpenAIResponsesRequest(bodyObj: any, url: string, bodyEstimatedPromptTokens: number): { reject: boolean; reason?: string } {
  const contextWindow = openAIResponsesContextWindow(String(bodyObj?.model || ''), url);
  if (!contextWindow || !Number.isFinite(bodyEstimatedPromptTokens) || bodyEstimatedPromptTokens <= 0) {
    return { reject: false };
  }

  // Reject near-context requests before the upstream call so Pi's existing
  // context-overflow recovery can compact and retry. This returns a provider-style
  // 400 response (rather than throwing inside fetch), preserving the overflow
  // classification without silently shrinking the user's output budget.
  // Operators may set the ratio to 0 only as an emergency compatibility escape.
  const ratio = Number(process.env.PI_RESPONSES_PREFLIGHT_CONTEXT_RATIO ?? 0.90);
  if (!Number.isFinite(ratio) || ratio <= 0) return { reject: false };

  const floor = Math.max(1024, Math.floor(contextWindow * Math.min(Math.max(ratio, 0.5), 0.99)));
  if (bodyEstimatedPromptTokens < floor) return { reject: false };
  return {
    reject: true,
    reason: `bodyEstimatedPromptTokens=${bodyEstimatedPromptTokens} >= preflightFloor=${floor} (ratio=${ratio}, context=${contextWindow})`,
  };
}

type PiFetchCorrelationContext = {
  sessionId: string;
  runId: string;
  rootTurnId?: string;
  attempt?: number;
  /** Optional stable logical id for provider prompt-cache affinity. */
  promptCacheSessionId?: string;
};

const LITELLM_RESPONSES_PROMPT_CACHE_PREFIX = 'pcache:v2:litellm-responses:';

/**
 * Build Tower's stable OpenAI Responses prompt-cache key for a logical session.
 *
 * The suffix is an HMAC of the Tower session id, not the raw id/name/title/email.
 * This keeps the cache key stable for one logical session while making it opaque
 * in LiteLLM/Codex request logs.
 */
export function buildTowerPromptCacheKey(sessionId: string | undefined | null): string | undefined {
  const normalized = String(sessionId || '').trim();
  if (!normalized) return undefined;
  const secret = config.jwtSecret || 'tower-prompt-cache-key-dev-fallback';
  const digest = crypto
    .createHmac('sha256', secret)
    .update(`tower-pi-prompt-cache:v1:${normalized}`)
    .digest('base64url')
    .slice(0, 24);
  return `${LITELLM_RESPONSES_PROMPT_CACHE_PREFIX}${digest}`;
}

function ensureLiteLLMResponsesPromptCacheKey(bodyObj: any, ctx: PiFetchCorrelationContext | undefined): { mutated: boolean; reason?: string; key?: string } {
  if (!ctx || !bodyObj || typeof bodyObj !== 'object') return { mutated: false };
  const key = buildTowerPromptCacheKey(ctx.promptCacheSessionId || ctx.sessionId);
  if (!key) return { mutated: false };
  if (bodyObj.prompt_cache_key === key) {
    return { mutated: false, key };
  }
  const previous = typeof bodyObj.prompt_cache_key === 'string' && bodyObj.prompt_cache_key
    ? String(bodyObj.prompt_cache_key).slice(0, 16)
    : 'none';
  bodyObj.prompt_cache_key = key;
  return {
    mutated: true,
    key,
    reason: `tower-prompt-cache-key:${key.slice(0, 24)} prev=${previous}`,
  };
}

function stripCodexSessionHeader(headersInput: any): { mutated: boolean; headers?: HeadersInit; reason?: string } {
  if (!headersInput) return { mutated: false };
  try {
    const headers = new Headers(headersInput);
    if (!headers.has('x-codex-session-id')) return { mutated: false };
    headers.delete('x-codex-session-id');
    return {
      mutated: true,
      headers: Object.fromEntries(headers.entries()),
      reason: 'removed x-codex-session-id header',
    };
  } catch {
    return { mutated: false };
  }
}

export const piFetchCorrelation = new AsyncLocalStorage<PiFetchCorrelationContext>();

export interface PiResponsesRequestDebugInfo {
  ts: number;
  sessionId: string;
  runId: string;
  url: string;
  model?: string;
  promptCacheKey?: string;
  previousResponseId?: string;
  inputItems?: number;
  inputTypes?: Record<string, number>;
  toolCount?: number;
  maxOutputTokens?: number;
  bodyEstimatedPromptTokens?: number;
  contextHintTokens?: number;
  requestBodyBytes?: number;
  parallelToolCalls?: unknown;
  fileRepresentationAdmission?: {
    imageItems: number;
    imageBytes: number;
    rejected: boolean;
    reason?: string;
  };
  hasReasoning?: boolean;
  towerCorrelation: string;
}

function getPiResponsesRequestDebugMap(): Map<string, PiResponsesRequestDebugInfo> {
  const g = globalThis as any;
  if (!g.__piResponsesRequestDebug) g.__piResponsesRequestDebug = new Map<string, PiResponsesRequestDebugInfo>();
  return g.__piResponsesRequestDebug;
}

export function getPiResponsesRequestDebugInfo(sessionId: string | undefined | null): PiResponsesRequestDebugInfo | null {
  if (!sessionId) return null;
  return getPiResponsesRequestDebugMap().get(String(sessionId)) ?? null;
}

function recordPiResponsesRequestDebugInfo(info: PiResponsesRequestDebugInfo): void {
  const map = getPiResponsesRequestDebugMap();
  map.set(info.sessionId, info);
  map.set(info.runId, info);
  if (map.size > 1000) {
    const first = map.keys().next().value;
    if (first) map.delete(first);
  }
}

function summarizeResponsesInputTypes(input: unknown): Record<string, number> | undefined {
  if (!Array.isArray(input)) return undefined;
  const types: Record<string, number> = {};
  for (const item of input) {
    const t = (item as any)?.type
      || (typeof item === 'object' && (item as any)?.role ? `message:${(item as any).role}` : 'unknown');
    types[t] = (types[t] || 0) + 1;
  }
  return types;
}

/**
 * OpenAI/Azure/LiteLLM Responses gets Tower/Pi turns as replayed input items.
 * If compaction or rehydration drops a `function_call` item but keeps its
 * matching `function_call_output`, providers reject the entire request with:
 *   "No tool call found for function call output with call_id ..."
 *
 * This is a request-shape repair, not a semantic summary: we prefer losing one
 * stale tool-result item over making the session permanently unretryable. Do not
 * apply this to previous_response_id chains, where tool outputs may legitimately
 * refer to a provider-side prior response rather than an item replayed in input.
 */
export function sanitizeOpenAIResponsesOrphanFunctionOutputs(bodyObj: any): { mutated: boolean; reason?: string; removedCallIds?: string[] } {
  if (!bodyObj || typeof bodyObj !== 'object' || !Array.isArray(bodyObj.input)) {
    return { mutated: false };
  }
  if (typeof bodyObj.previous_response_id === 'string' && bodyObj.previous_response_id.length > 0) {
    return { mutated: false };
  }

  const allFunctionCallIds = new Set<string>();
  for (const item of bodyObj.input) {
    if (item?.type === 'function_call' && typeof item.call_id === 'string' && item.call_id.length > 0) {
      allFunctionCallIds.add(item.call_id);
    }
  }

  let removed = 0;
  const removedCallIds: string[] = [];
  const seenFunctionCallIds = new Set<string>();
  const nextInput = bodyObj.input.filter((item: any) => {
    if (item?.type === 'function_call' && typeof item.call_id === 'string' && item.call_id.length > 0) {
      seenFunctionCallIds.add(item.call_id);
      return true;
    }
    if (item?.type !== 'function_call_output') return true;
    const callId = typeof item.call_id === 'string' ? item.call_id : '';
    // With full replay (no previous_response_id), Responses validates a tool
    // output against a preceding function_call item in the same input array.
    // A matching call later in the replay is still invalid because the output
    // appears before the model call that produced it.
    if (callId && seenFunctionCallIds.has(callId)) return true;
    removed++;
    removedCallIds.push(callId || '(missing-call_id)');
    return false;
  });

  if (removed === 0) return { mutated: false };
  bodyObj.input = nextInput;
  const shown = removedCallIds.slice(0, 5).map((id) => id.slice(0, 24)).join(',');
  return {
    mutated: true,
    removedCallIds,
    reason: `removed ${removed} orphan/out-of-order function_call_output item(s) without preceding function_call (calls=${allFunctionCallIds.size}, ids=${shown}${removedCallIds.length > 5 ? ',…' : ''})`,
  };
}

// Backward-compatible export name used by existing tests/callers.
export const sanitizeLiteLLMResponsesOrphanFunctionOutputs = sanitizeOpenAIResponsesOrphanFunctionOutputs;

function sanitizeLiteLLMResponsesReasoningInput(bodyObj: any): { mutated: boolean; reason?: string } {
  // Codex-LB/LiteLLM Responses currently receives Tower/Pi turns as full
  // replayed input, not as a strict previous_response_id chain. In that mode,
  // provider-private `reasoning` items (even with encrypted_content) are the
  // least portable part of the Responses wire format and correlate with
  // `upstream_rejected_input` before response.created on otherwise modest
  // requests. Keep reasoning generation enabled for the *new* response, but do
  // not replay prior reasoning blobs through the LiteLLM bridge. Azure Responses
  // is intentionally left untouched: its native SDK path relies on encrypted
  // reasoning continuity.
  if (!bodyObj || typeof bodyObj !== 'object' || !Array.isArray(bodyObj.input)) {
    return { mutated: false };
  }

  let removed = 0;
  const nextInput = bodyObj.input.filter((item: any) => {
    if (item?.type !== 'reasoning') return true;
    removed++;
    return false;
  });

  if (removed === 0) return { mutated: false };
  bodyObj.input = nextInput;
  return {
    mutated: true,
    reason: `removed ${removed} replayed reasoning input item(s)`,
  };
}

export function sanitizeLiteLLMResponsesCommentaryMessages(_bodyObj: any): { mutated: boolean; reason?: string } {
  // Commentary is assistant-origin content in the Responses/Codex protocol. Tower
  // may render it as a smaller progress bubble, but for same-protocol replay it
  // should remain in the model input with `phase: "commentary"` preserved. Do
  // not strip it at the LiteLLM transport boundary; hidden/scratchpad commentary
  // is filtered earlier before it becomes a replay item.
  return { mutated: false };
}

function injectTowerCorrelationMetadata(bodyObj: any, ctx: PiFetchCorrelationContext | undefined): { mutated: boolean; reason?: string } {
  if (!ctx || !bodyObj || typeof bodyObj !== 'object') return { mutated: false };
  const current = bodyObj.client_metadata && typeof bodyObj.client_metadata === 'object' && !Array.isArray(bodyObj.client_metadata)
    ? bodyObj.client_metadata
    : {};
  const next = {
    ...current,
    tower_session_id: ctx.sessionId,
    tower_run_id: ctx.runId,
    ...(ctx.rootTurnId ? { tower_root_turn_id: ctx.rootTurnId } : {}),
    tower_attempt: ctx.attempt ?? 0,
    tower_engine: 'pi',
  };
  const mutated = current.tower_session_id !== ctx.sessionId
    || current.tower_run_id !== ctx.runId
    || current.tower_root_turn_id !== ctx.rootTurnId
    || current.tower_attempt !== (ctx.attempt ?? 0)
    || current.tower_engine !== 'pi'
    || bodyObj.client_metadata !== current;
  bodyObj.client_metadata = next;
  return { mutated, reason: `tower-correlation:${ctx.sessionId.slice(0, 8)}/${ctx.runId.slice(0, 8)}` };
}

function routerTerminalFromEventType(value: unknown): RouterTerminalType | undefined {
  if (value === 'response.completed' || value === 'response.failed' || value === 'response.incomplete') return value;
  return undefined;
}

async function captureLiteLLMRouterEvidence(params: {
  response: Response;
  correlation: PiFetchCorrelationContext;
  startedAt: number;
  requestModel?: string;
}): Promise<void> {
  const { response, correlation } = params;
  if (!correlation.rootTurnId) return;
  const requestId = response.headers.get('x-request-id')
    || response.headers.get('x-litellm-request-id')
    || undefined;
  const base = {
    rootTurnId: correlation.rootTurnId,
    sessionId: correlation.sessionId,
    towerRunId: correlation.runId,
    attempt: correlation.attempt ?? 0,
    requestId,
    httpStatus: response.status,
    model: params.requestModel,
  };

  if (!response.body) {
    await recordAgentTurnRouterEvidence({
      ...base,
      terminalType: response.ok ? 'transport_closed_without_terminal' : 'response.failed',
      durationMs: Date.now() - params.startedAt,
      errorCode: response.ok ? 'missing_response_body' : `http_${response.status}`,
    });
    return;
  }

  let terminalType: RouterTerminalType | undefined;
  let responseId: string | undefined;
  let serviceTier: string | undefined;
  let errorCode: string | undefined;
  let eventCount = 0;
  try {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const frames = buffer.split('\n\n');
      buffer = frames.pop() ?? '';
      for (const frame of frames) {
        const dataLine = frame.split('\n').find((line) => line.startsWith('data:'));
        if (!dataLine) continue;
        const raw = dataLine.slice(5).trim();
        if (!raw || raw === '[DONE]') continue;
        try {
          const payload = JSON.parse(raw);
          eventCount += 1;
          const observedTerminal = routerTerminalFromEventType(payload?.type);
          if (observedTerminal) terminalType = observedTerminal;
          const responseObj = payload?.response && typeof payload.response === 'object' ? payload.response : payload;
          if (typeof responseObj?.id === 'string') responseId = responseObj.id;
          if (typeof responseObj?.service_tier === 'string') serviceTier = responseObj.service_tier;
          const candidateError = responseObj?.error?.code || responseObj?.incomplete_details?.reason || payload?.error?.code;
          if (typeof candidateError === 'string') errorCode = candidateError;
        } catch {
          // Ignore malformed observability frames; the SDK owns actual stream parsing.
        }
      }
    }
  } catch (error: any) {
    errorCode = error?.code || error?.name || 'router_evidence_stream_error';
  }

  await recordAgentTurnRouterEvidence({
    ...base,
    responseId,
    terminalType: terminalType ?? (response.ok ? 'transport_closed_without_terminal' : 'response.failed'),
    serviceTier,
    durationMs: Date.now() - params.startedAt,
    errorCode: errorCode ?? (!response.ok ? `http_${response.status}` : undefined),
    evidence: { event_count: eventCount },
  });
}

function codexRateLimitsFromHeaders(headers: Record<string, string>): any | null {
  const get = (name: string) => headers[name.toLowerCase()] ?? headers[name] ?? null;
  const num = (value: string | null): number | null => {
    if (value === null || value === '') return null;
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  };
  const primaryUsed = num(get('x-codex-primary-used-percent'));
  const secondaryUsed = num(get('x-codex-secondary-used-percent'));
  const primaryWindow = num(get('x-codex-primary-window-minutes'));
  const secondaryWindow = num(get('x-codex-secondary-window-minutes'));
  const primaryReset = num(get('x-codex-primary-reset-at'));
  const secondaryReset = num(get('x-codex-secondary-reset-at'));
  const planType = get('x-codex-plan-type');
  if (primaryUsed === null && secondaryUsed === null && !planType) return null;
  return {
    limit_id: get('x-codex-active-limit') || 'codex',
    primary: {
      used_percent: primaryUsed,
      window_minutes: primaryWindow,
      resets_at: primaryReset,
    },
    secondary: {
      used_percent: secondaryUsed,
      window_minutes: secondaryWindow,
      resets_at: secondaryReset,
    },
    credits: {
      has_credits: get('x-codex-credits-has-credits'),
      unlimited: get('x-codex-credits-unlimited'),
      balance: get('x-codex-credits-balance'),
    },
    plan_type: planType,
    rate_limit_reached_type: null,
  };
}

function appendCodexUsageSnapshot(snapshot: any): void {
  try {
    const auditDir = path.join(config.workspaceRoot, '.audit');
    fs.mkdirSync(auditDir, { recursive: true });
    fs.appendFileSync(
      path.join(auditDir, 'codex-usage.jsonl'),
      JSON.stringify({ ts: new Date().toISOString(), ...snapshot }) + '\n',
      'utf8',
    );
  } catch (err: any) {
    console.warn(`[Pi] codex usage snapshot write failed: ${err?.message || err}`);
  }
}

/**
 * Whether Tower may hand OPENAI_API_KEY to Pi's generic `openai/*` provider.
 *
 * Default is OFF: OPENAI_API_KEY is also used by non-agent features such as
 * image generation, and blindly registering it with Pi can make an apparent
 * OpenRouter/Azure turn fall through to expensive OpenAI direct models. Use
 * `openai-codex/*` OAuth or Azure/OpenRouter for Pi by default. If an operator
 * intentionally wants OpenAI direct inside Pi, they must opt in explicitly.
 */
export function allowPiOpenAiDirect(): boolean {
  return /^(1|true|yes)$/i.test(process.env.PI_ALLOW_OPENAI_DIRECT || '');
}

async function captureCodexSseUsage(res: Response, sessionId?: string): Promise<void> {
  const headers: Record<string, string> = {};
  try {
    res.headers.forEach((value, key) => {
      if (/^x-codex-/i.test(key) || key.toLowerCase() === 'content-type') headers[key] = value;
    });
  } catch {}
  const headerRateLimits = codexRateLimitsFromHeaders(headers);
  appendCodexUsageSnapshot({
    source: 'pi-openai-codex-response-start',
    sessionId: sessionId || null,
    status: res.status,
    headers,
    rateLimits: headerRateLimits,
    usage: null,
  });

  if (!res.body) return;
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const seenTypes = new Set<string>();
  let eventCount = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let idx = buffer.indexOf('\n\n');
      while (idx !== -1) {
        const chunk = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        const data = chunk
          .split('\n')
          .filter((line) => line.startsWith('data:'))
          .map((line) => line.slice(5).trim())
          .join('\n')
          .trim();
        if (data && data !== '[DONE]') {
          try {
            const event = JSON.parse(data);
            eventCount++;
            if (typeof event?.type === 'string' && !seenTypes.has(event.type)) {
              seenTypes.add(event.type);
              appendCodexUsageSnapshot({
                source: 'pi-openai-codex-sse-event-type',
                sessionId: sessionId || null,
                eventType: event.type,
                eventCount,
              });
            }
            if (event?.type === 'token_count' && event.rate_limits) {
              appendCodexUsageSnapshot({
                source: 'pi-openai-codex-sse',
                sessionId: sessionId || null,
                rateLimits: event.rate_limits,
                usage: event.info || null,
              });
            }
          } catch { /* ignore non-JSON chunks */ }
        }
        idx = buffer.indexOf('\n\n');
      }
    }
  } catch (err: any) {
    console.warn(`[Pi] codex SSE usage capture failed: ${err?.message || err}`);
  }
}

function ensureOpenRouterContextCompressionPlugin(bodyObj: any): { mutated: boolean; reason?: string } {
  // OpenRouter's own overflow error recommends this plugin. Pi's structured
  // auto-compaction remains the primary path, but it only runs at turn
  // boundaries; a single very large next prompt/tool schema can still push the
  // *request* over the endpoint cap before Pi gets a chance to summarize. This
  // is a provider-side last-resort guard for OpenRouter Chat Completions.
  if (!bodyObj || typeof bodyObj !== 'object') return { mutated: false };
  if (process.env.PI_OPENROUTER_CONTEXT_COMPRESSION === '0') return { mutated: false };

  const plugins = Array.isArray(bodyObj.plugins) ? bodyObj.plugins : [];
  const existing = plugins.find((plugin: any) => plugin?.id === 'context-compression');
  if (existing && existing.enabled !== false) return { mutated: false };

  if (existing && existing.enabled === false) {
    existing.enabled = true;
    return { mutated: true, reason: 'enabled existing context-compression plugin' };
  }

  bodyObj.plugins = [...plugins, { id: 'context-compression' }];
  return { mutated: true, reason: 'added context-compression plugin' };
}

// ── Phase 0-b: Dump raw Azure `response.failed` SSE payload ──
// Pi SDK collapses `response.failed` events to a single "Unknown error (no error details in response)"
// string when both `error` and `incomplete_details` are null. We lose fields like
// `response.status`, `response.id`, `response.model`, `service_tier`, and any partial error hints.
// This wraps `globalThis.fetch` to tee (clone) Azure OpenAI Responses SSE streams and log the full
// JSON of any `response.failed` event we see. No Pi SDK source modification.
// Per decision: workspace/projects/tower-ops/.project/decisions/2026-04-17-pi-auto-compaction-strategy.md
export function installPiProviderSafeguards(): void {
  if ((globalThis as any).__piPhase0bInstalled) return;
  (globalThis as any).__piPhase0bInstalled = true;
  const _origFetch = globalThis.fetch;
  // Experiment B toggle: strip `prompt_cache_key` from outgoing Azure Responses requests.
  // Pi SDK (azure-openai-responses.js:151) unconditionally sets it to the Pi sessionId.
  // Hypothesis: with long/flaky sessions, cross-request cache state gets out of sync and
  // Azure internally 500s with error=null, incomplete_details=null. Removing the key
  // opts us out of prompt caching (minor cost impact) but should kill the failure mode.
  // Toggle with env: PI_STRIP_PROMPT_CACHE_KEY=1 (requires process restart).
  //
  // 2026-05-15 — `true ||` 하드코딩 해제 (Default OFF). Experiment B 의 잔재.
  // SDK Credit Economy 검토 중 발견: 우리가 Pi 의 Azure caching 을
  // *영구 비활성화*한 상태였음. Azure cached_input $0.13/MTok (5.2% of base)
  // 효과를 완전 잃음. response.failed 가 정말 cache_key 때문이었다면
  // PI_STRIP_PROMPT_CACHE_KEY=1 박아서 즉시 롤백 가능.
  // Pi turn 자체 비용 95% 절감 가능 (실측 후 확정).
  // 근거: workspace/decisions/2026-05-14-sdk-credit-economy.md
  const STRIP_CACHE_KEY = process.env.PI_STRIP_PROMPT_CACHE_KEY === '1';
  // Experiment C: force `parallel_tool_calls=false` on outgoing Azure Responses requests.
  // Hypothesis (4/24 debug session 8a1a595b → issue 3b289fea): reasoning model + parallel
  // tool calls produces intermittent `response.failed` w/ error=null + output=[] because
  // the input re-assembly between turns races on call_id ordering / reasoning-item linkage.
  // Forcing serial tool calls makes input shape strictly serial → no race possible.
  // Tradeoff: 2-3x slower for naturally-parallelizable reads; eliminates response truncation.
  // Default ON (active mitigation). Set PI_FORCE_SERIAL_TOOL_CALLS=0 to disable for A/B.
  const FORCE_SERIAL_TOOLS = process.env.PI_FORCE_SERIAL_TOOL_CALLS !== '0';
  // Experiment C-observability: dump a one-line summary of the request input array
  // so we can confirm whether call_ids pair up with their function_call_outputs and
  // whether reasoning items are preserved across turns. Cheap (O(n) over input array).
  const LOG_REQUEST_SHAPE = process.env.PI_LOG_REQUEST_SHAPE !== '0';
  // Self-hosted LiteLLM router host (e.g. 100.108.147.25:4000). Used below to
  // route litellm/* Chat Completions requests through the output clamp — they
  // do NOT hit openrouter.ai, so the openrouter-only URL test missed them and
  // the legacy litellm/smart path took zero output clamp. Computed once at
  // install time; LITELLM_BASE_URL is fixed for the process lifetime.
  const LITELLM_HOST = (() => {
    try { return new URL(process.env.LITELLM_BASE_URL || '').host; } catch { return ''; }
  })();
  globalThis.fetch = async (input: any, init?: any) => {
    let url = '';
    try {
      url = typeof input === 'string' ? input : (input?.url || String(input));
    } catch { url = ''; }
    // Azure OpenAI can appear under two hosts:
    //   - *.openai.azure.com/...            (classic)
    //   - *.cognitive.microsoft.com/openai  (our koreacentral deployment)
    // The Responses API path always contains "/responses".
    const isAzureHost = /openai\.azure\.com|cognitive\.microsoft\.com\/openai/i.test(url);
    const isAzureResponses = isAzureHost && /\/responses/i.test(url);
    // ── Phase 0a (2026-05-15): observe OpenRouter too (no body mutation) ──
    // Per decision rollback in 2026-05-15-pi-mitigation-rollback.md (TBD):
    // we never had Kimi/OpenRouter wire-shape data. Capture it WITHOUT applying
    // any Azure-derived mitigations (parallel_tool_calls, cache-key strip) —
    // those are explicitly Azure-only until measurement justifies otherwise.
    const isOpenRouter = /openrouter\.ai\/api/i.test(url);
    const isOpenRouterChat = isOpenRouter && /\/chat\/completions/i.test(url);
    // Legacy self-hosted LiteLLM Chat Completions. Same OpenAI Chat Completions
    // wire shape as OpenRouter but a different host, so it shares the clamp
    // logic (minus the OpenRouter-only compression plugin).
    const isLiteLLMChat = !!LITELLM_HOST && url.includes(LITELLM_HOST) && /\/chat\/completions/i.test(url);
    const isLiteLLMResponses = !!LITELLM_HOST && url.includes(LITELLM_HOST) && /\/responses(?:\?|$)/i.test(url);
    const isCodexResponses = /chatgpt\.com\/backend-api\/codex\/responses/i.test(url);
    const isGenericOpenAIResponses = /\/responses(?:\?|$)/i.test(url) && !isAzureResponses;

    // ── Request-side patches (Experiments B + C) ──
    // Rewrite the request body to (a) drop `prompt_cache_key`, (b) force
    // `parallel_tool_calls=false`, and (c) emit a one-line input-shape summary.
    // Only touches Azure Responses POSTs whose body is a JSON string (what the
    // openai npm client produces). Silent no-op for any other shape.
    let effectiveInput: any = input;
    let effectiveInit: any = init;
    if (isAzureResponses) {
      try {
        const method = (init?.method || (input instanceof Request ? input.method : 'GET')).toUpperCase();
        if (method === 'POST') {
          const rawBody = init?.body ?? (input instanceof Request ? await input.clone().text() : undefined);
          if (typeof rawBody === 'string' && rawBody.length > 0 && rawBody[0] === '{') {
            try {
              const bodyObj = JSON.parse(rawBody);
              let mutated = false;
              const mutations: string[] = [];

              // (a) Strip prompt_cache_key (Experiment B)
              if (STRIP_CACHE_KEY && 'prompt_cache_key' in bodyObj) {
                const prev = bodyObj.prompt_cache_key;
                delete bodyObj.prompt_cache_key;
                mutated = true;
                mutations.push(`cachekey-strip(prev=${String(prev).slice(0, 16)})`);
              }

              // (b) Force parallel_tool_calls=false (Experiment C)
              // Pi SDK sets this to true by default for tool-capable providers. Only flip
              // when the field is present AND currently true — never inject it where the
              // SDK explicitly omitted it (some providers reject unknown fields).
              if (FORCE_SERIAL_TOOLS && bodyObj.parallel_tool_calls === true) {
                bodyObj.parallel_tool_calls = false;
                mutated = true;
                mutations.push('parallel-tools=false');
              }

              // (c) Drop replayed orphan/out-of-order tool outputs for Azure too.
              // LiteLLM had the same guard below; Azure native Responses validates the
              // exact same invariant and otherwise makes a poisoned long session
              // unretryable after a model switch or compaction boundary.
              const orphanOutputSanitizer = sanitizeOpenAIResponsesOrphanFunctionOutputs(bodyObj);
              if (orphanOutputSanitizer.mutated) {
                mutated = true;
                mutations.push(`orphan-tool-output:${orphanOutputSanitizer.reason}`);
              }

              // (d) Emit one-line summary of the input array shape (Experiment C-observability).
              // Helps confirm whether call_ids in `function_call` items pair up with their
              // matching `function_call_output` items, and whether reasoning items are present.
              if (LOG_REQUEST_SHAPE && Array.isArray(bodyObj.input)) {
                try {
                  const types: Record<string, number> = {};
                  const fnCallIds: string[] = [];
                  const fnOutIds: string[] = [];
                  for (const item of bodyObj.input) {
                    const t = item?.type
                      || (typeof item === 'object' && item?.role ? `message:${item.role}` : 'unknown');
                    types[t] = (types[t] || 0) + 1;
                    if (t === 'function_call' && item?.call_id) fnCallIds.push(String(item.call_id));
                    if (t === 'function_call_output' && item?.call_id) fnOutIds.push(String(item.call_id));
                  }
                  const callSet = new Set(fnCallIds);
                  const outSet = new Set(fnOutIds);
                  const unpairedCalls = fnCallIds.filter((id) => !outSet.has(id));
                  const orphanOutputs = fnOutIds.filter((id) => !callSet.has(id));
                  const orderMatch = fnCallIds.length === fnOutIds.length
                    && fnCallIds.every((id, i) => id === fnOutIds[i]);
                  const shape = {
                    items: bodyObj.input.length,
                    types,
                    fn_calls: fnCallIds.map((id) => id.slice(0, 12)),
                    fn_outs: fnOutIds.map((id) => id.slice(0, 12)),
                    unpaired_calls: unpairedCalls.map((id) => id.slice(0, 12)),
                    orphan_outputs: orphanOutputs.map((id) => id.slice(0, 12)),
                    order_match: orderMatch,
                    has_reasoning: !!bodyObj.reasoning,
                    parallel_tool_calls: bodyObj.parallel_tool_calls,
                  };
                  console.warn(`[Pi] phase0c request shape: ${JSON.stringify(shape)}`);
                } catch (shapeErr: any) {
                  console.warn(`[Pi] phase0c shape-log failed: ${shapeErr?.message || shapeErr}`);
                }
              }

              if (mutated) {
                const newBody = JSON.stringify(bodyObj);
                // When input is a Request, we must rebuild the init from it since
                // we're bypassing its body.
                if (input instanceof Request) {
                  effectiveInit = {
                    method: 'POST',
                    headers: init?.headers ?? Object.fromEntries((input as any).headers ?? []),
                    body: newBody,
                    signal: init?.signal ?? (input as any).signal,
                  };
                  effectiveInput = url; // use URL string, drop Request object
                } else {
                  effectiveInit = { ...(init || {}), body: newBody };
                }
                console.warn(`[Pi] body-patch applied: ${mutations.join(', ')} url=${url.slice(0, 120)}`);
              }
            } catch (parseErr: any) {
              // Body isn't parseable JSON — not a responses create call, skip silently.
            }
          }
        }
      } catch (patchErr: any) {
        console.warn(`[Pi] body-patch failed (passing through): ${patchErr?.message || patchErr}`);
      }
    }

    // ── Chat Completions request safeguards (OpenRouter + self-hosted LiteLLM) ──
    // Two complementary guards mutate the outgoing request body before send:
    //   (1) clampChatCompletionsOutputTokens — Kimi K2.6 advertises max output ≈
    //       full context. The endpoint validates prompt + tool schemas + requested
    //       output together, so Pi SDK passing model.maxTokens as
    //       max_completion_tokens can make an otherwise-normal turn fail with
    //       "requested X (prompt + tools + output)". Applies to BOTH OpenRouter
    //       (openrouter.ai) and legacy self-hosted LiteLLM Chat Completions,
    //       which share the OpenAI Chat Completions wire shape.
    //   (2) ensureOpenRouterContextCompressionPlugin — OpenRouter's own
    //       overflow error recommends a server-side context-compression
    //       plugin. OpenRouter-ONLY (LiteLLM does not support this plugin). Pi's
    //       structured auto-compaction is the primary path but only runs at turn
    //       boundaries; a single very large next prompt/tool schema can still
    //       push the *request* over the endpoint cap before Pi gets a chance to
    //       summarize. Opt out with PI_OPENROUTER_CONTEXT_COMPRESSION=0.
    if (isOpenRouterChat || isLiteLLMChat) {
      try {
        const method = (effectiveInit?.method || (effectiveInput instanceof Request ? effectiveInput.method : 'GET')).toUpperCase();
        if (method === 'POST') {
          const rawBody = effectiveInit?.body ?? (effectiveInput instanceof Request ? await effectiveInput.clone().text() : undefined);
          if (typeof rawBody === 'string' && rawBody.length > 0 && rawBody[0] === '{') {
            const bodyObj = JSON.parse(rawBody);
            const clamp = clampChatCompletionsOutputTokens(bodyObj);
            // Compression plugin is an OpenRouter-only feature; never inject it
            // into LiteLLM router requests.
            const compression = isOpenRouterChat
              ? ensureOpenRouterContextCompressionPlugin(bodyObj)
              : { mutated: false as boolean, reason: undefined as string | undefined };
            if (clamp.mutated || compression.mutated) {
              const newBody = JSON.stringify(bodyObj);
              if (effectiveInput instanceof Request) {
                effectiveInit = {
                  method: 'POST',
                  headers: effectiveInit?.headers ?? Object.fromEntries((effectiveInput as any).headers ?? []),
                  body: newBody,
                  signal: effectiveInit?.signal ?? (effectiveInput as any).signal,
                };
                effectiveInput = url;
              } else {
                effectiveInit = { ...(effectiveInit || {}), body: newBody };
              }
              const tag = isLiteLLMChat ? 'litellm' : 'openrouter';
              if (clamp.mutated) console.warn(`[Pi] ${tag} output clamp: ${clamp.reason}`);
              if (compression.mutated) console.warn(`[Pi] openrouter context-compression: ${compression.reason}`);
            }
          }
        }
      } catch (safeguardErr: any) {
        const tag = isLiteLLMChat ? 'litellm' : 'openrouter';
        console.warn(`[Pi] ${tag} safeguards failed (passing through): ${safeguardErr?.message || safeguardErr}`);
      }
    }

    // ── OpenAI Responses request safeguard ───────────────────────────────
    // Responses providers validate input + requested max_output_tokens against
    // the model context window. Pi SDK passes model.maxTokens (Smartest: 128k)
    // verbatim, so a session with ~200k input can fail even though the input
    // itself fits a 272k model. Clamp output per request; SDK compaction still
    // owns reducing old transcript when the input alone gets too large.
    if (isGenericOpenAIResponses) {
      try {
        const method = (effectiveInit?.method || (effectiveInput instanceof Request ? effectiveInput.method : 'GET')).toUpperCase();
        if (method === 'POST') {
          const rawBody = effectiveInit?.body ?? (effectiveInput instanceof Request ? await effectiveInput.clone().text() : undefined);
          if (typeof rawBody === 'string' && rawBody.length > 0 && rawBody[0] === '{') {
            const bodyObj = JSON.parse(rawBody);
            const correlationCtx = piFetchCorrelation.getStore();
            const towerPromptCacheKey = isLiteLLMResponses
              ? ensureLiteLLMResponsesPromptCacheKey(bodyObj, correlationCtx)
              : { mutated: false as boolean, reason: undefined as string | undefined, key: undefined as string | undefined };
            let promptCacheKey = bodyObj?.prompt_cache_key ? String(bodyObj.prompt_cache_key) : undefined;
            let contextHint = promptCacheKey ? getPiContextHintMap().get(promptCacheKey) : undefined;
            const reasoningSanitizer = isLiteLLMResponses
              ? sanitizeLiteLLMResponsesReasoningInput(bodyObj)
              : { mutated: false as boolean, reason: undefined as string | undefined };
            const commentarySanitizer = isLiteLLMResponses
              ? sanitizeLiteLLMResponsesCommentaryMessages(bodyObj)
              : { mutated: false as boolean, reason: undefined as string | undefined };
            const orphanOutputSanitizer = isLiteLLMResponses
              ? sanitizeLiteLLMResponsesOrphanFunctionOutputs(bodyObj)
              : { mutated: false as boolean, reason: undefined as string | undefined, removedCallIds: undefined as string[] | undefined };
            const fileRepresentationAdmission = inspectResponsesFileRepresentations(bodyObj);
            if (fileRepresentationAdmission.rejected) {
              const detail = `request_too_large: Pi Responses rejected accumulated file representations before upstream send (${fileRepresentationAdmission.reason})`;
              console.warn(`[Pi] responses file representation admission rejected request: ${detail}`);
              return new Response(JSON.stringify({
                error: {
                  message: detail,
                  type: 'invalid_request_error',
                  code: 'request_too_large',
                },
              }), {
                status: 400,
                headers: { 'content-type': 'application/json' },
              });
            }
            const bodyEstimatedPromptTokens = estimateOpenAIResponsesRequestTokens(bodyObj);
            // The actual Responses body is the most faithful signal for what the
            // provider is about to validate. Estimate AFTER request sanitizers (notably
            // reasoning/commentary replay removal), otherwise CTX risk/preflight can be
            // inflated by input items that would never be sent upstream.
            if (correlationCtx && isLiteLLMResponses) {
              rememberPiContextTokenHint(correlationCtx.sessionId, bodyEstimatedPromptTokens);
              rememberPiContextTokenHint(correlationCtx.promptCacheSessionId, bodyEstimatedPromptTokens);
            }
            if (promptCacheKey) {
              rememberPiContextTokenHint(promptCacheKey, bodyEstimatedPromptTokens);
              contextHint = getPiContextHintMap().get(promptCacheKey);
            }
            const nearContextPreflight = shouldRejectNearContextOpenAIResponsesRequest(bodyObj, url, bodyEstimatedPromptTokens);
            if (nearContextPreflight.reject) {
              const detail = `context_length_exceeded: Pi Responses preflight rejected near-context request before upstream send (${nearContextPreflight.reason})`;
              console.warn(`[Pi] responses preflight rejected request: ${detail}`);
              // Return a synthetic non-retryable provider-style 400 instead of throwing
              // inside fetch(). Throwing is collapsed by the OpenAI client/Pi SDK into a
              // generic Connection error and can be retried repeatedly, which defeats the
              // purpose of protecting upstream account stream slots. A 400 preserves the
              // context_overflow classification while guaranteeing no upstream request is made.
              return new Response(JSON.stringify({
                error: {
                  message: detail,
                  type: 'invalid_request_error',
                  code: 'context_length_exceeded',
                },
              }), {
                status: 400,
                headers: { 'content-type': 'application/json' },
              });
            }
            // Preserve the model/output budget requested by Pi. Near-context
            // requests are compacted through the explicit preflight path above;
            // they must never be made to look successful by silently clamping
            // max_output_tokens to a tiny value.
            // Correlate Tower Pi turns with codex-lb request_logs. Custom headers may
            // be stripped by LiteLLM, but codex-lb explicitly preserves client_metadata
            // in its Responses bridge path. Limit this to our LiteLLM Responses router.
            const correlation = isLiteLLMResponses
              ? injectTowerCorrelationMetadata(bodyObj, correlationCtx)
              : { mutated: false as boolean, reason: undefined as string | undefined };
            if (correlationCtx && isLiteLLMResponses) {
              const debugInfo: PiResponsesRequestDebugInfo = {
                ts: Date.now(),
                sessionId: correlationCtx.sessionId,
                runId: correlationCtx.runId,
                url,
                model: typeof bodyObj?.model === 'string' ? bodyObj.model : undefined,
                promptCacheKey,
                previousResponseId: typeof bodyObj?.previous_response_id === 'string' ? bodyObj.previous_response_id : undefined,
                inputItems: Array.isArray(bodyObj?.input) ? bodyObj.input.length : undefined,
                inputTypes: summarizeResponsesInputTypes(bodyObj?.input),
                toolCount: Array.isArray(bodyObj?.tools) ? bodyObj.tools.length : undefined,
                maxOutputTokens: Number.isFinite(Number(bodyObj?.max_output_tokens)) ? Number(bodyObj.max_output_tokens) : undefined,
                bodyEstimatedPromptTokens,
                contextHintTokens: typeof contextHint === 'number' ? contextHint : undefined,
                requestBodyBytes: Buffer.byteLength(JSON.stringify(bodyObj), 'utf8'),
                parallelToolCalls: bodyObj?.parallel_tool_calls,
                fileRepresentationAdmission,
                hasReasoning: !!bodyObj?.reasoning,
                towerCorrelation: correlation.reason ?? `tower-correlation:${correlationCtx.sessionId.slice(0, 8)}/${correlationCtx.runId.slice(0, 8)}`,
              };
              recordPiResponsesRequestDebugInfo(debugInfo);
              if (process.env.PI_RESPONSES_REQUEST_DEBUG === '1') {
                console.warn(`[Pi] responses request debug ${JSON.stringify({ ...debugInfo, promptCacheKey: promptCacheKey ? promptCacheKey.slice(0, 16) : undefined, previousResponseId: debugInfo.previousResponseId ? debugInfo.previousResponseId.slice(0, 16) : undefined })}`);
              }
            }
            const baseHeaders = effectiveInit?.headers ?? (effectiveInput instanceof Request ? Object.fromEntries((effectiveInput as any).headers ?? []) : undefined);
            const strippedCodexHeader = isLiteLLMResponses
              ? stripCodexSessionHeader(baseHeaders)
              : { mutated: false as boolean, headers: undefined as HeadersInit | undefined, reason: undefined as string | undefined };
            if (reasoningSanitizer.mutated || commentarySanitizer.mutated || orphanOutputSanitizer.mutated || correlation.mutated || towerPromptCacheKey.mutated || strippedCodexHeader.mutated) {
              const newBody = JSON.stringify(bodyObj);
              if (effectiveInput instanceof Request) {
                effectiveInit = {
                  method: 'POST',
                  headers: strippedCodexHeader.headers ?? baseHeaders,
                  body: newBody,
                  signal: effectiveInit?.signal ?? (effectiveInput as any).signal,
                };
                effectiveInput = url;
              } else {
                effectiveInit = {
                  ...(effectiveInit || {}),
                  ...(strippedCodexHeader.headers ? { headers: strippedCodexHeader.headers } : {}),
                  body: newBody,
                };
              }
              if (reasoningSanitizer.mutated) console.warn(`[Pi] responses reasoning sanitizer: ${reasoningSanitizer.reason} url=${url.slice(0, 120)}`);
              if (commentarySanitizer.mutated) console.warn(`[Pi] responses commentary sanitizer: ${commentarySanitizer.reason} url=${url.slice(0, 120)}`);
              if (orphanOutputSanitizer.mutated) console.warn(`[Pi] responses orphan tool-output sanitizer: ${orphanOutputSanitizer.reason} url=${url.slice(0, 120)}`);
              if (correlation.mutated) console.warn(`[Pi] responses correlation metadata: ${correlation.reason} url=${url.slice(0, 120)}`);
              if (towerPromptCacheKey.mutated) console.warn(`[Pi] responses prompt cache key: ${towerPromptCacheKey.reason} url=${url.slice(0, 120)}`);
              if (strippedCodexHeader.mutated) console.warn(`[Pi] responses header patch: ${strippedCodexHeader.reason} url=${url.slice(0, 120)}`);
            }
          }
        }
      } catch (safeguardErr: any) {
        const message = String(safeguardErr?.message || safeguardErr || '');
        if (/context_length_exceeded: Pi Responses preflight rejected near-context request/i.test(message)) {
          console.warn(`[Pi] responses preflight rejected request: ${message}`);
          throw safeguardErr;
        }
        console.warn(`[Pi] responses safeguards failed (passing through): ${message}`);
      }
    }

    // ── Phase 0a (2026-05-15): OpenRouter request body shape — observe only ──
    // Chat Completions shape differs from Azure Responses:
    //   { model, messages[], tools[], parallel_tool_calls, reasoning?, reasoning_effort?, stream }
    // Emit ONE line summarizing the shape so we can see how Pi SDK sends
    // reasoning/tool params to OpenRouter.
    if (LOG_REQUEST_SHAPE && isOpenRouterChat) {
      try {
        const method = (effectiveInit?.method || (effectiveInput instanceof Request ? effectiveInput.method : 'GET')).toUpperCase();
        if (method === 'POST') {
          const rawBody = effectiveInit?.body ?? (effectiveInput instanceof Request ? await effectiveInput.clone().text() : undefined);
          if (typeof rawBody === 'string' && rawBody.length > 0 && rawBody[0] === '{') {
            try {
              const bodyObj = JSON.parse(rawBody);
              const roleCounts: Record<string, number> = {};
              let lastAssistantToolCalls = 0;
              for (const m of (bodyObj.messages || [])) {
                roleCounts[m.role] = (roleCounts[m.role] || 0) + 1;
                if (m.role === 'assistant' && Array.isArray(m.tool_calls)) {
                  lastAssistantToolCalls = m.tool_calls.length;
                }
              }
              const shape = {
                model: bodyObj.model,
                msgs: (bodyObj.messages || []).length,
                roles: roleCounts,
                tool_role_msgs: roleCounts.tool || 0,
                last_assistant_tool_calls: lastAssistantToolCalls,
                tools_offered: (bodyObj.tools || []).length,
                parallel_tool_calls: bodyObj.parallel_tool_calls,
                reasoning_field: bodyObj.reasoning ? Object.keys(bodyObj.reasoning) : null,
                reasoning_effort: bodyObj.reasoning_effort,
                stream: bodyObj.stream,
              };
              console.warn(`[Pi] phase0a openrouter request shape: ${JSON.stringify(shape)}`);
            } catch (parseErr: any) {
              // not JSON — silent skip
            }
          }
        }
      } catch (shapeErr: any) {
        console.warn(`[Pi] phase0a openrouter shape-log failed: ${shapeErr?.message || shapeErr}`);
      }
    }

    const routerEvidenceStartedAt = Date.now();
    const routerCorrelation = isLiteLLMResponses ? piFetchCorrelation.getStore() : undefined;
    let routerRequestModel: string | undefined;
    if (routerCorrelation) {
      try {
        const rawBody = effectiveInit?.body;
        if (typeof rawBody === 'string') {
          const parsed = JSON.parse(rawBody);
          routerRequestModel = typeof parsed?.model === 'string' ? parsed.model : undefined;
        }
      } catch {
        // Request correlation remains useful even when the body cannot be inspected.
      }
    }
    const res = await _origFetch(effectiveInput as any, effectiveInit);

    if (isLiteLLMResponses && routerCorrelation?.rootTurnId) {
      try {
        const clone = res.clone();
        void captureLiteLLMRouterEvidence({
          response: clone,
          correlation: routerCorrelation,
          startedAt: routerEvidenceStartedAt,
          requestModel: routerRequestModel,
        }).catch((error) => {
          console.warn(`[Pi] router evidence capture failed: ${(error as Error)?.message || error}`);
        });
      } catch (error: any) {
        console.warn(`[Pi] router evidence clone failed: ${error?.message || error}`);
      }
    }

    // ── Codex rate-limit observability ───────────────────────────────
    // Codex CLI's status line is backed by `token_count.rate_limits` events.
    // Pi SDK's openai-codex provider currently lets those raw SSE events pass
    // through to processResponsesStream, where unknown event types are ignored.
    // Tee the SSE response here and persist the same snapshots to workspace
    // audit so Tower can show five-hour / weekly remaining later.
    if (isCodexResponses && res.body) {
      try {
        const clone = res.clone();
        const sessionId = (() => {
          try {
            const body = effectiveInit?.body;
            if (typeof body === 'string') return JSON.parse(body)?.prompt_cache_key;
          } catch {}
          return undefined;
        })();
        void captureCodexSseUsage(clone, sessionId);
      } catch (codexErr: any) {
        console.warn(`[Pi] codex usage capture setup failed: ${codexErr?.message || codexErr}`);
      }
    }

    // ── Phase 0a (OpenRouter response observability — observe only) ──
    // Capture any non-2xx OR any SSE chunk containing "error"/"finish_reason"
    // so we see the real failure mode when Kimi/OpenRouter stops mid-stream.
    if (isOpenRouterChat && res.body) {
      try {
        if (res.status >= 400) {
          // Non-streaming error response — read clone fully, log payload
          const clone = res.clone();
          clone.text().then((txt) => {
            console.warn(`[Pi] phase0a openrouter HTTP ${res.status}: ${txt.slice(0, 2000)}`);
          }).catch(() => {});
        } else {
          // 2xx streaming — tee SSE looking for error/finish_reason
          const clone = res.clone();
          (async () => {
            try {
              const reader = clone.body!.getReader();
              const decoder = new TextDecoder();
              let buffer = '';
              const finishReasons: string[] = [];
              while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                buffer += decoder.decode(value, { stream: true });
                const parts = buffer.split('\n\n');
                buffer = parts.pop() ?? '';
                for (const evt of parts) {
                  if (evt.includes('"error"') || evt.includes('"finish_reason"')) {
                    const dataLine = evt.split('\n').find((l) => l.startsWith('data:'));
                    if (!dataLine) continue;
                    const raw = dataLine.slice(5).trim();
                    if (raw === '[DONE]') continue;
                    try {
                      const payload = JSON.parse(raw);
                      if (payload.error) {
                        console.warn(`[Pi] phase0a openrouter SSE error: ${JSON.stringify(payload).slice(0, 2000)}`);
                      }
                      const fr = payload.choices?.[0]?.finish_reason;
                      if (fr && !finishReasons.includes(fr)) {
                        finishReasons.push(fr);
                        console.warn(`[Pi] phase0a openrouter finish_reason=${fr} (model=${payload.model || '?'}, id=${(payload.id || '').slice(0, 24)})`);
                      }
                    } catch {}
                  }
                }
              }
            } catch (teeErr: any) {
              console.warn(`[Pi] phase0a openrouter tee failed: ${teeErr?.message || teeErr}`);
            }
          })();
        }
      } catch (orErr: any) {
        console.warn(`[Pi] phase0a openrouter capture failed: ${orErr?.message || orErr}`);
      }
    }

    if (!isAzureResponses || !res.body) return res;
    try {
      const clone = res.clone();
      (async () => {
        try {
          const reader = clone.body!.getReader();
          const decoder = new TextDecoder();
          let buffer = '';
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            // SSE events are separated by blank lines
            const parts = buffer.split('\n\n');
            buffer = parts.pop() ?? '';
            for (const evt of parts) {
              if (!evt.includes('response.failed')) continue;
              const dataLine = evt.split('\n').find((l) => l.startsWith('data:'));
              if (!dataLine) continue;
              try {
                const raw = dataLine.slice(5).trim();
                const payload = JSON.parse(raw);
                const snippet = JSON.stringify(payload).slice(0, 4000);
                console.warn(`[Pi] phase0b azure raw response.failed: ${snippet}`);
              } catch (parseErr: any) {
                console.warn(`[Pi] phase0b payload parse failed: ${parseErr?.message || parseErr}`);
              }
            }
          }
        } catch (teeErr: any) {
          console.warn(`[Pi] phase0b tee stream failed: ${teeErr?.message || teeErr}`);
        }
      })();
    } catch (cloneErr: any) {
      console.warn(`[Pi] phase0b clone failed: ${cloneErr?.message || cloneErr}`);
    }
    return res;
  };
  const flags = [
    'response.failed capture (Phase 0-b)',
    STRIP_CACHE_KEY ? 'prompt_cache_key strip (Exp B)' : null,
    FORCE_SERIAL_TOOLS ? 'parallel_tool_calls=false (Exp C)' : null,
    LOG_REQUEST_SHAPE ? 'request-shape log (phase0c)' : null,
  ].filter(Boolean).join(' + ');
  console.log(`[Pi] fetch tee installed: ${flags}`);
}


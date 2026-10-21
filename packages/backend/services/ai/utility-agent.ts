import { getEngine } from '../../engines/index.js';
import { config } from '../../config.js';
import { isAllowedTowerPiModel } from '../../engines/pi/provider-boundary.js';

export function engineFromModel(modelId: string): 'claude' | 'pi' {
  return modelId.includes('/') ? 'pi' : 'claude';
}

/**
 * Pi quickReply has lightweight adapters for utility jobs (auto-name/summary).
 * Keep utility requests on the supported Router/OpenRouter boundary. A legacy
 * direct provider selection resolves to Router mini, not another direct engine.
 */
export function resolveUtilityModel(modelId: string): string {
  if (!modelId.includes('/')) return modelId;
  return isAllowedTowerPiModel(modelId) ? modelId : 'litellm-responses/mini';
}

export async function runUtilityTextTask(opts: {
  prompt: string;
  systemPrompt: string;
  model: string;
  fallbackText: string;
  /** Best-effort timeout for utility callers; returns fallbackText on expiry. */
  timeoutMs?: number;
  /** Diagnostics contain no prompts, responses, or raw errors. */
  onResult?: (result: { status: 'generated' | 'fallback'; reason?: string; model: string; httpStatus?: number }) => void;
}): Promise<string> {
  let model = opts.model;
  const report = (status: 'generated' | 'fallback', reason?: string, httpStatus?: number) => {
    try { opts.onResult?.({ status, reason, model, httpStatus }); } catch { /* isolated diagnostics */ }
  };
  try {
    model = resolveUtilityModel(opts.model);
    const engineName = engineFromModel(model);

    // Guard against disabled engines
    if (engineName === 'claude' && !config.claudeEnabled) {
      console.log('[utility-agent] skip: Claude disabled');
      report('fallback', 'engine_disabled');
      return opts.fallbackText;
    }
    if (engineName === 'pi' && !config.piEnabled) {
      console.log('[utility-agent] skip: Pi disabled');
      report('fallback', 'engine_disabled');
      return opts.fallbackText;
    }

    const engine = await getEngine(engineName);
    const work = engine.quickReply(opts.prompt, {
      model,
      systemPrompt: opts.systemPrompt,
      onChunk: () => {},
    });
    const result = opts.timeoutMs && opts.timeoutMs > 0
      ? await withTimeout(work, opts.timeoutMs, null)
      : await work;
    if (result === null) { report('fallback', 'timeout'); return opts.fallbackText; }
    if (typeof result !== 'string' || !result.trim()) { report('fallback', 'empty_response'); return opts.fallbackText; }
    report('generated');
    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : '';
    const status = message.match(/API error (\d{3})/);
    report('fallback', /timeout/i.test(message) ? 'timeout' : status ? 'provider_http' : 'runtime_error', status ? Number(status[1]) : undefined);
    return opts.fallbackText;
  }
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, fallback: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((resolve) => {
        timer = setTimeout(() => resolve(fallback), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

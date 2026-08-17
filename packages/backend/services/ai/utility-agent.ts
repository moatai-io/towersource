import { getEngine } from '../../engines/index.js';
import { config, loadModelsFile } from '../../config.js';

export function engineFromModel(modelId: string): 'claude' | 'pi' {
  return modelId.includes('/') ? 'pi' : 'claude';
}

/**
 * Pi quickReply has lightweight adapters for utility jobs (auto-name/summary).
 * Keep supported router/provider models on Pi so cheap aliases such as
 * `litellm-responses/mini` do not silently fall back to Claude. Built-in Pi providers
 * such as direct GPT/Codex aliases are great for full sessions, but utility
 * calls may not have a stateless adapter; for those, prefer a small Claude
 * model when Claude is enabled.
 */
export function resolveUtilityModel(modelId: string): string {
  if (!modelId.includes('/')) return modelId;
  if (
    modelId.startsWith('openrouter/') ||
    modelId.startsWith('azure-openai-responses/') ||
    modelId.startsWith('litellm/') ||
    modelId.startsWith('litellm-responses/')
  ) return modelId;
  if (!config.claudeEnabled) return modelId;

  const claudeModels = loadModelsFile().claude.filter(m => m.enabled);
  return claudeModels.find(m => /haiku/i.test(m.id) || /haiku/i.test(m.name))?.id
    ?? claudeModels[0]?.id
    ?? modelId;
}

export async function runUtilityTextTask(opts: {
  prompt: string;
  systemPrompt: string;
  model: string;
  fallbackText: string;
  /** Best-effort timeout for utility callers; returns fallbackText on expiry. */
  timeoutMs?: number;
}): Promise<string> {
  try {
    const model = resolveUtilityModel(opts.model);
    const engineName = engineFromModel(model);

    // Guard against disabled engines
    if (engineName === 'claude' && !config.claudeEnabled) {
      console.log('[utility-agent] skip: Claude disabled');
      return opts.fallbackText;
    }
    if (engineName === 'pi' && !config.piEnabled) {
      console.log('[utility-agent] skip: Pi disabled');
      return opts.fallbackText;
    }

    const engine = await getEngine(engineName);
    const work = engine.quickReply(opts.prompt, {
      model,
      systemPrompt: opts.systemPrompt,
      onChunk: () => {},
    });
    const result = opts.timeoutMs && opts.timeoutMs > 0
      ? await withTimeout(work, opts.timeoutMs, opts.fallbackText)
      : await work;
    return typeof result === 'string' && result.trim() ? result : opts.fallbackText;
  } catch {
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

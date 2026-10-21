import type { ModelOption } from '../../stores/model-store';

function backendModelId(model: ModelOption): string {
  const normalized = model.id.replace(/^pi:/, '').replace(/^local:/, '');
  const slash = normalized.indexOf('/');
  return slash >= 0 ? normalized.slice(slash + 1) : normalized;
}

/**
 * User-facing model maker. LiteLLM's OpenAI-compatible `/models` response can
 * report `owned_by: openai` for routed GLM/DeepSeek models, so transport owner
 * metadata must not be presented as the actual model company.
 */
export function getModelCompany(model: ModelOption): string | undefined {
  const id = backendModelId(model).toLowerCase().replace(/^~/, '');
  if (/^(gpt-|o[1-9](?:-|$)|chatgpt)/.test(id)) return 'OpenAI';
  if (/^(z-ai\/|glm-)/.test(id)) return 'Z.ai';
  if (/^(deepseek\/|deepseek-)/.test(id)) return 'DeepSeek';
  if (/^(moonshotai\/|kimi-)/.test(id)) return 'Moonshot AI';
  if (/^(anthropic\/|claude-)/.test(id)) return 'Anthropic';
  if (/^(google\/|gemini-)/.test(id)) return 'Google';
  if (/^(mistralai\/|mistral-)/.test(id)) return 'Mistral AI';
  if (/^(x-ai\/|grok-)/.test(id)) return 'xAI';
  if (/^(qwen\/|qwen-)/.test(id)) return 'Alibaba';
  if (/^(meta-llama\/|llama-)/.test(id)) return 'Meta';
  if (/^(cohere\/|command-)/.test(id)) return 'Cohere';
  return undefined;
}

export function getDefaultModelRank(model: ModelOption): number | null {
  if (model.policyAlias === 'core') return 0;
  if (model.policyAlias === 'lite') return 1;
  return null;
}

export function getModelDisplayName(model: ModelOption, t: (key: string) => string): string {
  if (model.policyAlias === 'core' || model.policyAlias === 'lite') {
    const label = t(model.policyAlias === 'core' ? 'coreRoute' : 'liteRoute');
    const runtime = model.runtimeModelId?.trim().replace(/^pi:/, '');
    if (!runtime || /^(preset|policy)\//.test(runtime)) return label;
    // Strip only the transport provider, preserving nested vendor/model IDs.
    const slash = runtime.indexOf('/');
    const target = slash >= 0 ? runtime.slice(slash + 1) : runtime;
    return target ? `${label} - ${target}` : label;
  }
  return model.name;
}

export function getModelPriceLabel(model: ModelOption): { input: string; output: string } | null {
  const input = model.inputPricePerMillion;
  const output = model.outputPricePerMillion;
  if (input === undefined || output === undefined || !Number.isFinite(input) || !Number.isFinite(output) || input < 0 || output < 0) return null;
  const format = (price: number) => price.toLocaleString('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  return { input: format(input), output: format(output) };
}

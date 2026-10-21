import { loadModelsFile, saveModelsFile, type PiModelEntry } from '../../config.js';
import { PRODUCT_REASONING_EFFORTS } from '../model-policy/reasoning-efforts.js';
import { resolveLiteLLMCredentials } from './litellm-credentials.js';

const POLICY_MODEL_IDS = new Set(['smartest', 'smart', 'mini']);
const RETIRED_ROUTER_MODEL_IDS = new Set(['smart', 'astra-canary', 'smartest-long', 'sol-fast', 'gpt55']);

export interface LiteLLMCatalogModel {
  modelId: string;
  name: string;
  ownedBy?: string;
  inputCostPerToken?: number;
  outputCostPerToken?: number;
  contextWindow?: number;
  maxTokens?: number;
  kind: 'policy' | 'direct';
  enabled: boolean;
  selectable: boolean;
  discoveredAt?: string;
  lastSeenAt?: string;
}

function safeModelId(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const id = value.trim();
  if (!id || id.length > 240 || /[\s\u0000-\u001f]/.test(id)) return null;
  return id;
}

type DiscoveredModel = Pick<LiteLLMCatalogModel, 'modelId' | 'ownedBy' | 'inputCostPerToken' | 'outputCostPerToken' | 'contextWindow' | 'maxTokens'>;

function validCost(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function validLimit(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

function smallerLimit(a?: number, b?: number): number | undefined {
  return a === undefined ? b : b === undefined ? a : Math.min(a, b);
}

export function normalizeLiteLLMModels(payload: unknown): DiscoveredModel[] {
  const rows = Array.isArray((payload as any)?.data) ? (payload as any).data : [];
  const seen = new Set<string>();
  const result: DiscoveredModel[] = [];
  for (const row of rows) {
    const modelId = safeModelId(row?.id ?? row?.model_name);
    if (!modelId) continue;
    const info = row?.model_info ?? {};
    const contextWindow = smallerLimit(validLimit(row?.max_input_tokens), validLimit(info.max_input_tokens));
    const maxTokens = smallerLimit(validLimit(row?.max_output_tokens), validLimit(info.max_output_tokens));
    if (seen.has(modelId)) {
      const existing = result.find(model => model.modelId === modelId)!;
      const input = smallerLimit(existing.contextWindow, contextWindow);
      const output = smallerLimit(existing.maxTokens, maxTokens);
      if (input !== undefined) existing.contextWindow = input;
      if (output !== undefined) existing.maxTokens = output;
      continue;
    }
    seen.add(modelId);
    // LiteLLM may place rate metadata under model_info; never infer it from Tower's static cost table.
    const inputCostPerToken = validCost(row?.model_info?.input_cost_per_token ?? row?.input_cost_per_token);
    const outputCostPerToken = validCost(row?.model_info?.output_cost_per_token ?? row?.output_cost_per_token);
    result.push({
      modelId,
      ...(typeof row?.owned_by === 'string' && row.owned_by.trim() ? { ownedBy: row.owned_by.trim().slice(0, 120) } : {}),
      ...(inputCostPerToken !== undefined ? { inputCostPerToken } : {}),
      ...(outputCostPerToken !== undefined ? { outputCostPerToken } : {}),
      ...(contextWindow !== undefined ? { contextWindow } : {}),
      ...(maxTokens !== undefined ? { maxTokens } : {}),
    });
  }
  return result.sort((a, b) => a.modelId.localeCompare(b.modelId));
}

function isLiteLLM(entry: PiModelEntry): boolean {
  return entry.provider === 'litellm-responses';
}

function toCatalog(entry: PiModelEntry): LiteLLMCatalogModel {
  return {
    modelId: entry.modelId,
    name: entry.name,
    ownedBy: entry.catalogOwnedBy,
    inputCostPerToken: entry.catalogInputCostPerToken,
    outputCostPerToken: entry.catalogOutputCostPerToken,
    kind: entry.modelKind ?? (POLICY_MODEL_IDS.has(entry.modelId) ? 'policy' : 'direct'),
    enabled: entry.enabled !== false,
    selectable: !POLICY_MODEL_IDS.has(entry.modelId)
      && !RETIRED_ROUTER_MODEL_IDS.has(entry.modelId)
      && !!entry.lastSeenAt
      && entry.lastSeenAt === loadModelsFile().litellmCatalog?.syncedAt,
    discoveredAt: entry.discoveredAt,
    lastSeenAt: entry.lastSeenAt,
  };
}

export function getLiteLLMModelCatalog(): { models: LiteLLMCatalogModel[]; syncedAt?: string; syncError?: string } {
  const file = loadModelsFile();
  return {
    models: file.pi.filter(entry => isLiteLLM(entry) && !POLICY_MODEL_IDS.has(entry.modelId) && !RETIRED_ROUTER_MODEL_IDS.has(entry.modelId)).map(toCatalog),
    syncedAt: file.litellmCatalog?.syncedAt,
    syncError: file.litellmCatalog?.syncError,
  };
}

export async function refreshLiteLLMModelCatalog(): Promise<ReturnType<typeof getLiteLLMModelCatalog>> {
  const connection = await resolveLiteLLMCredentials();
  let response: Response;
  try {
    response = await fetch(`${connection.baseUrl}/models`, {
      headers: { Authorization: `Bearer ${connection.apiKey}` },
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    throw new Error('LiteLLM model catalog request failed');
  }
  if (!response.ok) throw new Error(`LiteLLM model catalog rejected (HTTP ${response.status})`);
  let discovered: DiscoveredModel[];
  try {
    discovered = normalizeLiteLLMModels(await response.json());
  } catch {
    throw new Error('LiteLLM model catalog returned invalid JSON');
  }
  if (discovered.length === 0) throw new Error('LiteLLM model catalog returned no models');

  // /models is the Team visibility authority; /model/info only supplies rates
  // for those already-visible IDs. Price lookup failure must not widen access.
  try {
    const infoResponse = await fetch(`${connection.baseUrl}/model/info`, {
      headers: { Authorization: `Bearer ${connection.apiKey}` },
      signal: AbortSignal.timeout(15_000),
    });
    if (infoResponse.ok) {
      const info = await infoResponse.json();
      const rates = new Map(normalizeLiteLLMModels(info).map(row => [row.modelId, row]));
      discovered = discovered.map(row => {
        const rate = rates.get(row.modelId);
        return {
          ...row,
          contextWindow: smallerLimit(row.contextWindow, rate?.contextWindow),
          maxTokens: smallerLimit(row.maxTokens, rate?.maxTokens),
          inputCostPerToken: rate?.inputCostPerToken ?? row.inputCostPerToken,
          outputCostPerToken: rate?.outputCostPerToken ?? row.outputCostPerToken,
        };
      });
    }
  } catch {
    // Missing rate metadata is shown as unavailable, never fabricated.
  }

  const now = new Date().toISOString();
  const file = loadModelsFile();
  const byId = new Map(file.pi.filter(isLiteLLM).map(entry => [entry.modelId, entry]));
  for (const model of discovered) {
    if (model.modelId === 'mini' || RETIRED_ROUTER_MODEL_IDS.has(model.modelId)) continue;
    const existing = byId.get(model.modelId);
    if (existing) {
      // Preserve explicit operator limits; only populate previously unknown values.
      existing.contextWindow ??= model.contextWindow;
      existing.maxTokens ??= model.maxTokens;
      existing.discoveredAt ??= now;
      existing.lastSeenAt = now;
      existing.catalogOwnedBy = model.ownedBy;
      existing.catalogInputCostPerToken = model.inputCostPerToken;
      existing.catalogOutputCostPerToken = model.outputCostPerToken;
      existing.modelKind ??= POLICY_MODEL_IDS.has(model.modelId) ? 'policy' : 'direct';
      existing.enabled = true;
      existing.hidden = false;
      existing.selectable = !POLICY_MODEL_IDS.has(model.modelId);
      existing.reasoningEfforts = [...PRODUCT_REASONING_EFFORTS];
      continue;
    }
    file.pi.push({
      provider: 'litellm-responses',
      modelId: model.modelId,
      name: model.modelId,
      badge: model.ownedBy?.slice(0, 12).toUpperCase() || 'MODEL',
      enabled: true,
      selectable: true,
      hidden: false,
      modelKind: POLICY_MODEL_IDS.has(model.modelId) ? 'policy' : 'direct',
      api: 'openai-responses',
      reasoning: true,
      defaultReasoning: model.modelId === 'gpt-6-sol' ? 'high' : 'low',
      reasoningEfforts: [...PRODUCT_REASONING_EFFORTS],
      roles: ['full', 'managed', 'standalone'],
      discoveredAt: now,
      lastSeenAt: now,
      catalogOwnedBy: model.ownedBy,
      catalogInputCostPerToken: model.inputCostPerToken,
      catalogOutputCostPerToken: model.outputCostPerToken,
      ...(model.contextWindow !== undefined ? { contextWindow: model.contextWindow } : {}),
      ...(model.maxTokens !== undefined ? { maxTokens: model.maxTokens } : {}),
    });
  }
  file.litellmCatalog = { syncedAt: now };
  saveModelsFile(file);
  return getLiteLLMModelCatalog();
}

export function setLiteLLMModelSelectable(_modelId: string, _selectable: boolean): never {
  throw new Error('LiteLLM Team /models controls model visibility');
}

export function isModelPolicyId(modelId: string | undefined): boolean {
  if (!modelId?.startsWith('litellm-responses/')) return false;
  return POLICY_MODEL_IDS.has(modelId.slice('litellm-responses/'.length));
}

/**
 * Owns: resolving logical Tower workload policies into model + reasoning settings.
 * Public API: resolveModelPolicy, resolveAgentExecutionPolicy, MODEL_POLICY_IDS.
 * See README.md.
 */

import { getModelDefaults, isPiModelEntryEnabledForThisVm, loadModelsFile, resolveLegacyPiModelId } from '../../config.js';
import type { EffortLevel } from '../../engines/types.js';

export const MODEL_POLICY_IDS = [
  'low',
  'medium',
  'high',
  'extra-high',
  'max',
  'ultra',
  'title',
  'summary',
  'background',
] as const;

export type ModelPolicyId = typeof MODEL_POLICY_IDS[number];
export type PiThinkingLevel = 'low' | 'medium' | 'high' | 'xhigh';

export interface ModelPolicyDefinition {
  model: string;
  effort: EffortLevel;
  enabled?: boolean;
  description?: string;
}

export interface ResolvedModelPolicy {
  id: ModelPolicyId;
  revision: number;
  requestedModel: string;
  effectiveModel: string;
  requestedEffort: EffortLevel;
  effectiveEffort: PiThinkingLevel;
  effortDowngraded: boolean;
  enabled: boolean;
}

export interface AgentExecutionPolicyInput {
  model?: string;
  effort?: EffortLevel;
  modelPolicy?: ModelPolicyId;
}

const PI_SUPPORTED_EFFORTS = new Set<PiThinkingLevel>(['low', 'medium', 'high', 'xhigh']);

function builtInPolicies(): Record<ModelPolicyId, ModelPolicyDefinition> {
  const defaults = getModelDefaults();
  return {
    low: { model: defaults.ai_task, effort: 'low' },
    medium: { model: defaults.session, effort: 'medium' },
    high: { model: defaults.session, effort: 'high' },
    'extra-high': { model: defaults.session, effort: 'xhigh' },
    max: { model: defaults.session, effort: 'max', description: 'Highest available single-agent reasoning policy.' },
    ultra: { model: defaults.session, effort: 'max', enabled: false, description: 'Reserved for future multi-agent orchestration.' },
    title: { model: defaults.ai_reply, effort: 'low' },
    summary: { model: defaults.ai_reply, effort: 'low' },
    background: { model: defaults.session, effort: 'medium' },
  };
}

function configuredPolicies(): { revision: number; policies: Partial<Record<ModelPolicyId, ModelPolicyDefinition>> } {
  const file = loadModelsFile();
  const configured = file.modelPolicies;
  if (!configured || typeof configured !== 'object') return { revision: 1, policies: {} };
  const revision = Number.isInteger(configured.revision) && configured.revision > 0 ? configured.revision : 1;
  const enabledPiModels = new Set(file.pi.filter(isPiModelEntryEnabledForThisVm).map((model) => `${model.provider}/${model.modelId}`));
  const policies: Partial<Record<ModelPolicyId, ModelPolicyDefinition>> = {};
  for (const id of MODEL_POLICY_IDS) {
    const value = configured.policies?.[id];
    if (!value || typeof value !== 'object') continue;
    // Background work follows the current Core slot, including legacy configs
    // that still stored the Lite model here. Keep effort/enabled overrides.
    const rawModel = id === 'background' ? getModelDefaults().session
      : typeof value.model === 'string' ? value.model.trim() : '';
    // Preserve the VM's router-facing model ID. A provider ID can be unavailable
    // to this Team even when the underlying provider serves that model.
    const model = resolveLegacyPiModelId(rawModel);
    if (!model) continue;
    if (model.includes('/') && !enabledPiModels.has(model)) {
      throw new Error(`MODEL_POLICY_MODEL_UNAVAILABLE: ${id} -> ${model}`);
    }
    const effort = value.effort;
    if (!['low', 'medium', 'high', 'xhigh', 'max'].includes(effort)) continue;
    policies[id] = {
      model,
      effort,
      enabled: value.enabled !== false,
      description: typeof value.description === 'string' ? value.description : undefined,
    };
  }
  return { revision, policies };
}

function effectivePiEffort(requested: EffortLevel): { effort: PiThinkingLevel; downgraded: boolean } {
  if (PI_SUPPORTED_EFFORTS.has(requested as PiThinkingLevel)) {
    return { effort: requested as PiThinkingLevel, downgraded: false };
  }
  // Pi SDK currently supports up to xhigh. Keep `max` as a product policy while
  // making the compatibility downgrade explicit in runtime provenance.
  return { effort: 'xhigh', downgraded: true };
}

/** Resolve one enabled logical model policy into its current immutable execution values. */
export function resolveModelPolicy(id: ModelPolicyId): ResolvedModelPolicy {
  const builtIn = builtInPolicies();
  const configured = configuredPolicies();
  const definition = configured.policies[id] ?? builtIn[id];
  const enabled = definition.enabled !== false;
  if (!enabled) throw new Error(`MODEL_POLICY_DISABLED: ${id}`);
  const normalized = effectivePiEffort(definition.effort);
  return {
    id,
    revision: configured.revision,
    requestedModel: definition.model,
    effectiveModel: definition.model,
    requestedEffort: definition.effort,
    effectiveEffort: normalized.effort,
    effortDowngraded: normalized.downgraded,
    enabled,
  };
}

/** Merge explicit Agent settings over a logical policy without silently enabling Ultra. */
export function resolveAgentExecutionPolicy(input: AgentExecutionPolicyInput): ResolvedModelPolicy {
  const base = resolveModelPolicy(input.modelPolicy ?? 'medium');
  const requestedEffort = input.effort ?? base.requestedEffort;
  const normalized = effectivePiEffort(requestedEffort);
  return {
    ...base,
    requestedModel: input.model ?? base.requestedModel,
    effectiveModel: input.model ?? base.effectiveModel,
    requestedEffort,
    effectiveEffort: normalized.effort,
    effortDowngraded: normalized.downgraded,
  };
}

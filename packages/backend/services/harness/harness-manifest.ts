/**
 * Owns: validating and compiling server-owned Harness manifests into immutable runtime contracts.
 * Public API: compileHarnessManifest, validateEffectiveHarnessManifest, stableManifestHash.
 */
import { createHash } from 'node:crypto';
import type { HarnessPromptPlan, ResolvedHarness } from './harness-types.js';
import { requireRegisteredHarnessCapabilities } from './capability-provider-registry.js';
import { legacyFragmentsToPromptComponents, promptBundleHash, promptComponentIds, requirePromptComponentReferences } from './prompt-component-registry.js';

export const HARNESS_COMPILER_VERSION = 'tower-harness-compiler-v2';

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value as Record<string, unknown>).filter(([,item]) => item !== undefined).sort(([a],[b]) => a.localeCompare(b)).map(([k,v]) => `${JSON.stringify(k)}:${stable(v)}`).join(',')}}`;
  return JSON.stringify(value);
}

/** Deterministic content hash for draft and effective manifests. */
export function stableManifestHash(value: unknown): string {
  return createHash('sha256').update(stable(value)).digest('hex');
}

function requiredString(row: Record<string, unknown>, key: string): string {
  const value = typeof row[key] === 'string' ? row[key].trim() : '';
  if (!value) throw new Error(`${key} required`);
  return value;
}

function promptPlan(prompt: Record<string, unknown>, persisted: boolean): HarnessPromptPlan {
  const prefix = persisted ? 'Persisted Harness ' : '';
  const bool = (key: string) => {
    if (typeof prompt[key] !== 'boolean') throw new Error(`${prefix}prompt.${key} must be boolean`);
    return prompt[key] as boolean;
  };
  if (persisted && prompt.includePlatformKernel !== true) throw new Error('Persisted Harness cannot disable the Platform Kernel');
  if (prompt.fragments !== undefined && (!Array.isArray(prompt.fragments) || !prompt.fragments.every((item) => typeof item === 'string'))) throw new Error(`${prefix}prompt.fragments must contain registered fragment ids`);
  if (prompt.components !== undefined && !Array.isArray(prompt.components)) throw new Error(`${prefix}prompt.components must contain {id,version} references`);
  const components = Array.isArray(prompt.components)
    ? requirePromptComponentReferences(prompt.components)
    : legacyFragmentsToPromptComponents((prompt.fragments ?? []) as string[]);
  const plan: HarnessPromptPlan = {
    includePlatformKernel: true,
    includeAgentIdentity: bool('includeAgentIdentity'),
    includeProjectInstructions: bool('includeProjectInstructions'),
    includeMemory: bool('includeMemory'),
    includeSkills: bool('includeSkills'),
    fragments: promptComponentIds(components),
    components,
  };
  plan.bundleHash = promptBundleHash(plan);
  if (persisted && prompt.bundleHash !== undefined && prompt.bundleHash !== plan.bundleHash) throw new Error('Persisted Harness prompt bundle hash mismatch');
  return plan;
}

function models(row: Record<string, unknown>, persisted: boolean) {
  const prefix = persisted ? 'Persisted Harness ' : '';
  const raw = row.allowedModels === null ? null : Array.isArray(row.allowedModels) ? row.allowedModels : persisted ? undefined : [];
  if (raw === undefined || (raw !== null && !raw.every((item) => typeof item === 'string' && item.trim()))) throw new Error(`${prefix}allowedModels must contain model ids`);
  const allowedModels = raw === null ? null : [...new Set(raw as string[])].sort();
  const defaultModel = row.defaultModel === null || row.defaultModel === undefined ? null : requiredString(row, 'defaultModel');
  if (defaultModel && allowedModels && !allowedModels.includes(defaultModel)) throw new Error(`${prefix}defaultModel must be included in allowedModels`);
  return { allowedModels, defaultModel };
}

/** Compile a draft manifest into the exact runtime contract the publisher will freeze. */
export function compileHarnessManifest(manifest: unknown, identity: { harnessId: string; harnessVersion: number }): Omit<ResolvedHarness, 'source'> {
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) throw new Error('Harness manifest must be an object');
  const row = manifest as Record<string, unknown>;
  if (row.schemaVersion !== 1 && row.schemaVersion !== 2) throw new Error('Unsupported Harness manifest schemaVersion');
  if (requiredString(row, 'engine') !== 'pi') throw new Error(`Unsupported Harness engine ${String(row.engine)}`);
  if (!row.runtimeProfile || typeof row.runtimeProfile !== 'object' || Array.isArray(row.runtimeProfile)) throw new Error('runtimeProfile required');
  const profile = row.runtimeProfile as Record<string, unknown>;
  const runtimeProfileId = requiredString(profile, 'id');
  const runtimeProfileVersion = Number(profile.version);
  if (!Number.isInteger(runtimeProfileVersion) || runtimeProfileVersion <= 0) throw new Error('runtimeProfile.version must be a positive integer');
  const rawCapabilities = Array.isArray(row.capabilityIds) ? row.capabilityIds : [];
  if (!rawCapabilities.every((item) => typeof item === 'string')) throw new Error('Harness capabilityIds must contain strings');
  const capabilityIds = requireRegisteredHarnessCapabilities(rawCapabilities as string[]);
  if (capabilityIds.length === 0) throw new Error('Published custom Harness requires at least one capability');
  const promptValue = row.prompt;
  if (!promptValue || typeof promptValue !== 'object' || Array.isArray(promptValue)) throw new Error('prompt required');
  const modelPolicy = models(row, false);
  return {
    id: identity.harnessId, version: identity.harnessVersion, runtimeProfileId, runtimeProfileVersion,
    engine: 'pi', ...modelPolicy, prompt: promptPlan(promptValue as Record<string, unknown>, false), capabilityIds,
  };
}

/** Validate one persisted effective manifest before runtime trusts it. */
export function validateEffectiveHarnessManifest(value: unknown): Omit<ResolvedHarness, 'source'> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid persisted Harness effective manifest');
  const row = value as Record<string, unknown>;
  const id = requiredString(row, 'id');
  const version = Number(row.version);
  const runtimeProfileId = requiredString(row, 'runtimeProfileId');
  const runtimeProfileVersion = Number(row.runtimeProfileVersion);
  if (!Number.isInteger(version) || version <= 0 || !Number.isInteger(runtimeProfileVersion) || runtimeProfileVersion <= 0) throw new Error('Invalid persisted Harness version tuple');
  if (row.engine !== 'pi') throw new Error(`Unsupported persisted Harness engine ${String(row.engine)}`);
  const promptValue = row.prompt;
  if (!promptValue || typeof promptValue !== 'object' || Array.isArray(promptValue)) throw new Error('Invalid persisted Harness prompt');
  const rawCapabilities = Array.isArray(row.capabilityIds) ? row.capabilityIds : [];
  if (!rawCapabilities.every((item) => typeof item === 'string')) throw new Error('Persisted Harness capabilityIds must contain strings');
  const capabilityIds = requireRegisteredHarnessCapabilities(rawCapabilities as string[]);
  if (capabilityIds.length === 0) throw new Error('Persisted custom Harness requires at least one capability');
  return {
    id, version, runtimeProfileId, runtimeProfileVersion, engine: 'pi', ...models(row, true),
    prompt: promptPlan(promptValue as Record<string, unknown>, true), capabilityIds,
  };
}

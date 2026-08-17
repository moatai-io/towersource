/**
 * Owns: immutable, versioned Prompt Component references allowed in Harness manifests.
 * Public API: requirePromptComponentReferences, legacyFragmentsToPromptComponents, promptBundleHash.
 */
import { createHash } from 'node:crypto';
import { requireSystemPromptFragmentKeys, type SystemPromptFragmentKey } from '../system-prompt-fragments.js';
import type { HarnessPromptPlan, PromptComponentReference } from './harness-types.js';

export interface PromptComponentDefinition {
  id: SystemPromptFragmentKey;
  version: 1;
  owner: 'tower-platform';
  riskClass: 'operational';
}

export const PLATFORM_KERNEL_VERSION = 1;

const DEFINITIONS: readonly PromptComponentDefinition[] = Object.freeze([
  'agent-orchestration','durable-artifact','external-skill-install','git','pdf-export',
  'portable-html','publishing','task-schedule','tower-internal-links','visualization',
].map((id) => Object.freeze({ id: id as SystemPromptFragmentKey, version: 1 as const, owner: 'tower-platform' as const, riskClass: 'operational' as const })));

const BY_ID_VERSION = new Map(DEFINITIONS.map((definition) => [`${definition.id}@${definition.version}`, definition]));

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value as Record<string, unknown>).filter(([,item]) => item !== undefined).sort(([a],[b]) => a.localeCompare(b)).map(([key,item]) => `${JSON.stringify(key)}:${stable(item)}`).join(',')}}`;
  return JSON.stringify(value);
}

/** Validate and canonicalize immutable Prompt Component references. */
export function requirePromptComponentReferences(value: readonly unknown[]): PromptComponentReference[] {
  const refs = value.map((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error('prompt.components must contain {id,version} references');
    const row = item as Record<string, unknown>;
    const id = typeof row.id === 'string' ? row.id.trim() : '';
    const version = Number(row.version);
    if (!id || !Number.isInteger(version) || version <= 0) throw new Error('prompt.components must contain valid {id,version} references');
    if (!BY_ID_VERSION.has(`${id}@${version}`)) throw new Error(`Unsupported Prompt Component ${id}@${version}`);
    return { id: id as SystemPromptFragmentKey, version };
  });
  const unique = new Map(refs.map((ref) => [`${ref.id}@${ref.version}`, ref]));
  return [...unique.values()].sort((a,b) => a.id.localeCompare(b.id) || a.version-b.version);
}

/** Convert schema-v1 fragment ids to their immutable v1 component references. */
export function legacyFragmentsToPromptComponents(fragments: readonly string[]): PromptComponentReference[] {
  return requireSystemPromptFragmentKeys(fragments).map((id) => ({ id, version: 1 }));
}

/** Resolve component refs to the existing System Prompt Fragment selector ids. */
export function promptComponentIds(components: readonly PromptComponentReference[]): SystemPromptFragmentKey[] {
  return requireSystemPromptFragmentKeys(components.map(({ id }) => id));
}

/** Secret-free identity of the immutable prompt plan assembled for a Harness. */
export function promptBundleHash(prompt: HarnessPromptPlan): string {
  const components = prompt.components?.length
    ? requirePromptComponentReferences(prompt.components)
    : legacyFragmentsToPromptComponents(prompt.fragments);
  const bundle = {
    platformKernelVersion: PLATFORM_KERNEL_VERSION,
    contextSlots: {
      agentIdentity: prompt.includeAgentIdentity,
      projectInstructions: prompt.includeProjectInstructions,
      memory: prompt.includeMemory,
      skills: prompt.includeSkills,
    },
    components,
  };
  return createHash('sha256').update(stable(bundle)).digest('hex');
}

export const PROMPT_COMPONENT_DEFINITIONS = DEFINITIONS;

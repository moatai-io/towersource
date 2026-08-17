/**
 * Owns: the server-side registry of Harness capability ids that can be compiled
 * into concrete Pi tool providers.
 *
 * The registry intentionally starts small. A capability is publishable only
 * after its runtime provider and expected tool surface are both registered.
 */
export type HarnessCapabilityId = 'web.fetch' | 'web.search';

export interface HarnessCapabilityProviderDescriptor {
  id: HarnessCapabilityId;
  toolNames: readonly string[];
  description: string;
  networkRequired: boolean;
}

const PROVIDERS: Readonly<Record<HarnessCapabilityId, HarnessCapabilityProviderDescriptor>> = Object.freeze({
  'web.fetch': Object.freeze({
    id: 'web.fetch',
    toolNames: Object.freeze(['WebFetch']),
    description: 'Read one public web page or JSON endpoint.',
    networkRequired: true,
  }),
  'web.search': Object.freeze({
    id: 'web.search',
    toolNames: Object.freeze(['WebSearch']),
    description: 'Search public web and news sources.',
    networkRequired: true,
  }),
});

export function listHarnessCapabilityProviders(): HarnessCapabilityProviderDescriptor[] {
  return Object.values(PROVIDERS);
}

export function isRegisteredHarnessCapability(id: string): id is HarnessCapabilityId {
  return Object.prototype.hasOwnProperty.call(PROVIDERS, id);
}

export function requireRegisteredHarnessCapabilities(ids: readonly string[]): HarnessCapabilityId[] {
  const unique = [...new Set(ids)].sort();
  const unknown = unique.filter((id) => !isRegisteredHarnessCapability(id));
  if (unknown.length > 0) throw new Error(`Harness manifest contains unsupported runtime capabilities: ${unknown.join(', ')}`);
  return unique as HarnessCapabilityId[];
}

export function expectedToolNamesForCapabilities(ids: readonly string[]): string[] {
  return requireRegisteredHarnessCapabilities(ids)
    .flatMap((id) => PROVIDERS[id].toolNames)
    .filter((name, index, all) => all.indexOf(name) === index)
    .sort();
}

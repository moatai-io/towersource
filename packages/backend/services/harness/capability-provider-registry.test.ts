import { describe, expect, it } from 'vitest';
import {
  expectedToolNamesForCapabilities,
  listHarnessCapabilityProviders,
  requireRegisteredHarnessCapabilities,
} from './capability-provider-registry.js';

describe('Harness capability provider registry', () => {
  it('returns deterministic registered capability and tool surfaces', () => {
    expect(requireRegisteredHarnessCapabilities(['web.search', 'web.fetch', 'web.search']))
      .toEqual(['web.fetch', 'web.search']);
    expect(expectedToolNamesForCapabilities(['web.search', 'web.fetch']))
      .toEqual(['WebFetch', 'WebSearch']);
    expect(listHarnessCapabilityProviders().map((provider) => provider.id).sort())
      .toEqual(['web.fetch', 'web.search']);
  });

  it('fails closed for unimplemented runtime capabilities', () => {
    expect(() => requireRegisteredHarnessCapabilities(['project.files.write']))
      .toThrow('unsupported runtime capabilities: project.files.write');
  });
});

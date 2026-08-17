import { describe, expect, it } from 'vitest';
import type { ResolvedHarness } from '../services/harness/harness-types.js';
import { createPiHarnessCapabilityTools } from './pi-harness-capability-tools.js';

function harness(capabilityIds: string[]): ResolvedHarness {
  return {
    id: 'test-harness', version: 1, runtimeProfileId: 'test', runtimeProfileVersion: 1,
    engine: 'pi', defaultModel: null, allowedModels: null,
    prompt: { includePlatformKernel: true, includeAgentIdentity: true, includeProjectInstructions: false, includeMemory: false, includeSkills: false, fragments: [] },
    capabilityIds, sandboxMode: 'none', networkMode: 'platform-default', source: 'database',
  };
}

describe('Pi Harness capability tool compiler', () => {
  it('assembles the exact registered tool surface independent of capability order', () => {
    const compiled = createPiHarnessCapabilityTools(harness(['web.search', 'web.fetch']), { userId: 1, projectId: 'p1' });
    expect(compiled.expectedToolNames).toEqual(['WebFetch', 'WebSearch']);
    expect(compiled.tools.map((tool) => tool.name).sort()).toEqual(['WebFetch', 'WebSearch']);
  });

  it('fails closed instead of falling back to the full Pi surface', () => {
    expect(() => createPiHarnessCapabilityTools(harness(['project.files.write']), { userId: 1, projectId: 'p1' }))
      .toThrow('unsupported runtime capabilities');
  });
});

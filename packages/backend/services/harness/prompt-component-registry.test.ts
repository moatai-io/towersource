import { describe, expect, it } from 'vitest';
import { legacyFragmentsToPromptComponents, promptBundleHash, promptComponentIds, requirePromptComponentReferences } from './prompt-component-registry.js';

describe('Prompt Component Registry', () => {
  it('canonicalizes immutable component references', () => {
    expect(requirePromptComponentReferences([{ id: 'visualization', version: 1 }, { id: 'git', version: 1 }, { id: 'git', version: 1 }])).toEqual([
      { id: 'git', version: 1 },
      { id: 'visualization', version: 1 },
    ]);
    expect(() => requirePromptComponentReferences([{ id: 'git', version: 2 }])).toThrow('Unsupported Prompt Component git@2');
  });

  it('projects schema-v1 fragments into component v1 references', () => {
    const refs = legacyFragmentsToPromptComponents(['visualization', 'git']);
    expect(refs).toEqual([{ id: 'git', version: 1 }, { id: 'visualization', version: 1 }]);
    expect(promptComponentIds(refs)).toEqual(['git', 'visualization']);
  });

  it('changes bundle identity when context slots or component versions change', () => {
    const base = { includePlatformKernel: true as const, includeAgentIdentity: true, includeProjectInstructions: false, includeMemory: false, includeSkills: false, fragments: ['git'], components: [{ id: 'git', version: 1 }] };
    expect(promptBundleHash(base)).toMatch(/^[a-f0-9]{64}$/);
    expect(promptBundleHash(base)).not.toBe(promptBundleHash({ ...base, includeMemory: true }));
  });
});

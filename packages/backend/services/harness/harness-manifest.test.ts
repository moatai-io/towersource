import { describe, expect, it } from 'vitest';
import { compileHarnessManifest, stableManifestHash, validateEffectiveHarnessManifest } from './harness-manifest.js';

const manifest = {
  schemaVersion: 1,
  engine: 'pi',
  runtimeProfile: { id: 'research-web', version: 1 },
  defaultModel: 'litellm-responses/smart',
  allowedModels: ['litellm-responses/smart'],
  prompt: {
    includeAgentIdentity: true,
    includeProjectInstructions: false,
    includeMemory: false,
    includeSkills: false,
    fragments: [],
  },
  capabilityIds: ['web.fetch', 'web.search'],
};

describe('Harness manifest compiler', () => {
  it('compiles a deterministic effective runtime contract', () => {
    const result = compileHarnessManifest(manifest, { harnessId: 'research-web', harnessVersion: 2 });
    expect(result).toMatchObject({
      id: 'research-web',
      version: 2,
      runtimeProfileId: 'research-web',
      runtimeProfileVersion: 1,
      engine: 'pi',
      capabilityIds: ['web.fetch', 'web.search'],
    });
    expect(result).not.toHaveProperty('sandboxMode');
    expect(result).not.toHaveProperty('networkMode');
    expect(stableManifestHash({ b: 2, a: 1 })).toBe(stableManifestHash({ a: 1, b: 2 }));
  });

  it('compiles schema-v2 immutable Prompt Component references and bundle hash', () => {
    const result = compileHarnessManifest({ ...manifest, schemaVersion: 2, prompt: { ...manifest.prompt, fragments: undefined, components: [{ id: 'git', version: 1 }] } }, { harnessId: 'component-v2', harnessVersion: 1 });
    expect(result.prompt.components).toEqual([{ id: 'git', version: 1 }]);
    expect(result.prompt.fragments).toEqual(['git']);
    expect(result.prompt.bundleHash).toMatch(/^[a-f0-9]{64}$/);
    expect(() => compileHarnessManifest({ ...manifest, schemaVersion: 2, prompt: { ...manifest.prompt, components: [{ id: 'git', version: 2 }] } }, { harnessId: 'bad-component', harnessVersion: 1 })).toThrow('Unsupported Prompt Component git@2');
  });

  it('accepts legacy isolation fields as ignored schema-v1 input', () => {
    const result = compileHarnessManifest({ ...manifest, sandboxMode: 'host', networkMode: 'allowlist' }, { harnessId: 'legacy-input', harnessVersion: 1 });
    expect(result).not.toHaveProperty('sandboxMode');
    expect(result).not.toHaveProperty('networkMode');
  });

  it('rejects unregistered prompt fragments', () => {
    expect(() => compileHarnessManifest({ ...manifest, prompt: { ...manifest.prompt, fragments: ['not-registered'] } }, { harnessId: 'bad', harnessVersion: 1 })).toThrow('Unsupported system prompt fragments');
  });

  it('validates persisted effective manifests before runtime use', () => {
    const effective = compileHarnessManifest(manifest, { harnessId: 'research-web', harnessVersion: 2 });
    expect(validateEffectiveHarnessManifest(effective)).toEqual(effective);
    expect(() => validateEffectiveHarnessManifest({ ...effective, prompt: { ...effective.prompt, includeAgentIdentity: undefined } })).toThrow('prompt.includeAgentIdentity');
    expect(() => validateEffectiveHarnessManifest({ ...effective, capabilityIds: ['shell.exec'] })).toThrow('unsupported runtime capabilities');
  });

  it('rejects unknown capabilities and inconsistent model policies', () => {
    expect(() => compileHarnessManifest({ ...manifest, capabilityIds: ['shell.exec'] }, { harnessId: 'bad', harnessVersion: 1 })).toThrow('unsupported runtime capabilities');
    expect(() => compileHarnessManifest({ ...manifest, defaultModel: 'other' }, { harnessId: 'bad', harnessVersion: 1 })).toThrow('included in allowedModels');
  });
});

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
const service = readFileSync(new URL('./inference-provider-setup.ts', import.meta.url), 'utf8');
const route = readFileSync(new URL('../../routes/api.ts', import.meta.url), 'utf8');
const registry = readFileSync(new URL('../../engines/pi/model-registry.ts', import.meta.url), 'utf8');
describe('inference provider setup security contract', () => {
  it('stores only a secret reference in models config', () => {
    expect(service).toContain("scope: 'global'");
    expect(service).toContain('secretName: config.secretName');
    expect(service).not.toContain('apiKey: input.apiKey');
  });
  it('requires admin and probes before persisting', () => {
    expect(route).toContain("router.post('/admin/inference-setup/apply', adminMiddleware");
    const configure = service.slice(service.indexOf('export async function configureInferenceProvider'), service.indexOf('export async function resolveConfiguredInferenceProviderSecret'));
    expect(configure.indexOf('await probeInferenceProvider')).toBeLessThan(configure.indexOf('await setSecret'));
  });
  it('injects the VM credential into Pi runtime without logging its value', () => {
    expect(registry).toContain('resolveConfiguredInferenceProviderSecret');
    expect(registry).toContain("credentialId: 'vm-inference-provider'");
    expect(registry).not.toContain('console.log(vmCredential');
  });
});

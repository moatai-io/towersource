import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const engine = readFileSync(new URL('./pi-engine.ts', import.meta.url), 'utf8');
const registry = readFileSync(new URL('./pi/model-registry.ts', import.meta.url), 'utf8');

describe('Pi OpenRouter emergency Vault override contract', () => {
  it('resolves project-granted OPENROUTER_API_KEY for explicit OpenRouter sessions', () => {
    expect(registry).toContain('resolveProjectApiKeySecretValue');
    expect(registry).toContain("envName: 'OPENROUTER_API_KEY'");
    expect(registry).toContain("targetType: 'pi-model-runtime:openrouter'");
    expect(registry).toContain("runtime.setRuntimeApiKey('openrouter', resolved.value");
    expect(registry).toContain("opts.model?.startsWith('openrouter/')");
  });

  it('applies the Vault override before create-session model resolution and model switching', () => {
    const createSessionApply = engine.indexOf('await this.modelRegistryManager.applyProjectVaultApiKeyOverrides({');
    const resolveSessionModel = engine.indexOf('const model = this.modelRegistryManager.resolveSessionModel(effectiveModelId);');
    expect(createSessionApply).toBeGreaterThanOrEqual(0);
    expect(resolveSessionModel).toBeGreaterThan(createSessionApply);

    const switchComment = engine.indexOf('Direct emergency providers');
    const switchApply = engine.indexOf('await this.modelRegistryManager.applyProjectVaultApiKeyOverrides({', switchComment);
    const switchCall = engine.indexOf('await this.switchModelIfNeeded(entry, opts.model);', switchComment);
    expect(switchApply).toBeGreaterThan(switchComment);
    expect(switchCall).toBeGreaterThan(switchApply);
  });
});

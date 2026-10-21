import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const engine = readFileSync(new URL('./pi-engine.ts', import.meta.url), 'utf8');
describe('Pi OpenRouter emergency Vault override contract', () => {
  // Secret selection/authorization context is executed in pi/model-registry-vault.test.ts.
  it('applies the Vault override before create-session model resolution and model switching', () => {
    const createSessionApply = engine.indexOf('await this.modelRegistryManager.applyProjectVaultApiKeyOverrides({');
    const resolveSessionModel = engine.indexOf('this.modelRegistryManager.resolveSessionModel(runtimeModelId);');
    expect(createSessionApply).toBeGreaterThanOrEqual(0);
    expect(resolveSessionModel).toBeGreaterThan(createSessionApply);

    const switchComment = engine.indexOf('Direct emergency providers');
    const switchApply = engine.indexOf('await this.modelRegistryManager.applyProjectVaultApiKeyOverrides({', switchComment);
    const switchCall = engine.indexOf('await this.switchModelIfNeeded(entry, opts.model);', switchComment);
    expect(switchApply).toBeGreaterThan(switchComment);
    expect(switchCall).toBeGreaterThan(switchApply);
  });
});

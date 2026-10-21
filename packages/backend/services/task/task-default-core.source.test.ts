import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const source = (name: string) => readFileSync(fileURLToPath(new URL(name, import.meta.url)), 'utf8');

describe('background work defaults to the admin Core mapping', () => {
  for (const file of ['task-manager.ts', 'task-runner.ts']) {
    it(`${file} does not fall back to Lite`, () => {
      expect(source(file)).toContain('getModelDefaults().session');
    });
  }
  it('uses Core for proactive work while preserving explicit template models', () => {
    expect(source('../ai/proactive-agent.ts')).toContain('model = template.model || getModelDefaults().session');
    expect(source('../ai/proactive-agent.ts')).not.toContain('model: template.model || getModelDefaults().ai_reply');
  });
  it('updates the background policy with Core rather than the Lite slot', () => {
    expect(source('../../routes/api.ts')).toContain("const policyIds = key === 'session' ? ['medium', 'high', 'extra-high', 'max', 'ultra', 'background'] : ['low', 'title', 'summary'];");
  });
  it('preserves explicit task and automation models', () => {
    expect(source('task-manager.ts')).toContain('model || getModelDefaults().session');
    expect(source('automation-manager.ts')).toContain("data.model || 'preset/core'");
    expect(source('automation-runners.ts')).toContain('resolveAutomationModel(configuredModel)');
  });
});

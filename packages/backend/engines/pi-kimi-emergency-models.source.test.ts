import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const models = JSON.parse(readFileSync(new URL('../models.json', import.meta.url), 'utf8'));
const config = readFileSync(new URL('../config.ts', import.meta.url), 'utf8');
const safeguards = readFileSync(new URL('./pi/provider-safeguards.ts', import.meta.url), 'utf8');

describe('OpenRouter Kimi emergency model catalog', () => {
  it('keeps Kimi K2.6 and Kimi K3 as manual full-VM OpenRouter emergency models', () => {
    const kimiModels = models.pi.filter((m: any) => m.provider === 'openrouter' && String(m.modelId).startsWith('moonshotai/kimi-'));
    expect(kimiModels.map((m: any) => m.modelId).sort()).toEqual(['moonshotai/kimi-k2.6', 'moonshotai/kimi-k3']);
    for (const model of kimiModels) {
      expect(model.enabled).toBe(true);
      expect(model.api).toBe('openai-completions');
      expect(model.badge).toBe('EMERG');
      expect(model.roles).toEqual(['full']);
      expect(model._note).toContain('not');
      expect(model._note).toContain('fallback');
    }
  });

  it('allows only the approved OpenRouter emergency IDs to stay sticky', () => {
    expect(config).toContain("'openrouter/moonshotai/kimi-k2.6'");
    expect(config).toContain("'openrouter/moonshotai/kimi-k3'");
    expect(config).toContain('ALLOWED_OPENROUTER_EMERGENCY_PI_SESSION_MODELS');
  });

  it('pins Kimi K3 context for OpenRouter Chat Completions token clamp', () => {
    expect(safeguards).toContain("id === 'moonshotai/kimi-k3'");
    expect(safeguards).toContain('1_048_576');
  });
});

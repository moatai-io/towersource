import { describe, expect, it } from 'vitest';
import { classifyAutomationPatch } from './automation-patch-policy.js';

describe('automation PATCH policy', () => {
  it('allows only a boolean enabled control update', () => {
    expect(classifyAutomationPatch({ enabled: false })).toEqual({
      allowed: true, controlUpdates: { enabled: false }, configFields: [], unknownFields: [],
    });
    expect(classifyAutomationPatch({ enabled: 'false' }).allowed).toBe(false);
  });

  it('classifies prompt, schedule, routing, and identity fields as config mutation', () => {
    const result = classifyAutomationPatch({ name: 'new', prompt: 'p', cronConfig: { type: 'daily' }, roomId: 'r1' });
    expect(result.allowed).toBe(false);
    expect(result.configFields).toEqual(['name', 'prompt', 'cronConfig', 'roomId']);
  });

  it('rejects mixed control and config updates', () => {
    const result = classifyAutomationPatch({ enabled: true, prompt: 'changed' });
    expect(result.allowed).toBe(false);
    expect(result.controlUpdates).toEqual({ enabled: true });
    expect(result.configFields).toEqual(['prompt']);
  });

  it('rejects client policy override fields and empty payloads', () => {
    expect(classifyAutomationPatch({ riskLevel: 'low', confirmedHighRisk: true }).unknownFields).toEqual(['riskLevel', 'confirmedHighRisk']);
    expect(classifyAutomationPatch({}).allowed).toBe(false);
  });
});

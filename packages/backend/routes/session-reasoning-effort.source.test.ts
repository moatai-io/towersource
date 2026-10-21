import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const api = readFileSync(new URL('./api.ts', import.meta.url), 'utf8');
const ws = readFileSync(new URL('./ws-handler.ts', import.meta.url), 'utf8');
const sessionManager = readFileSync(new URL('../services/session/session-manager.ts', import.meta.url), 'utf8');

describe('session reasoning effort contract', () => {
  it('validates and persists a session preference with participant metadata authority', () => {
    expect(api).toContain("const sessionPreferenceOnly = changedKeys.every(key => key === 'reasoningEffort')");
    expect(api).toContain('metadataOnly || sessionPreferenceOnly');
    expect(api).toContain('reasoningEffortsForChoice(modelChoice).includes(reasoningEffort)');
    expect(api).toContain('updates.reasoningEffort = reasoningEffort');
    expect(api).toContain("router.patch('/admin/models/reasoning', operatorOrAboveMiddleware");
    expect(sessionManager).toContain('reasoning_effort = $');
    expect(sessionManager).toContain('reasoningEffort: row.reasoning_effort || null');
  });

  it('uses the persisted override only when the current turn did not send one explicitly', () => {
    expect(ws).toContain("typeof data.effort === 'string' ? data.effort : (dbSession as any)?.reasoningEffort");
    expect(ws).toContain('effort: requestedEffort');
  });
});

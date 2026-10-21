import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
const source = fs.readFileSync(new URL('./ws-handler.ts', import.meta.url), 'utf8');
describe('retired persisted model admission wiring', () => {
  it('recovers before selectable validation and validates the Core target', () => {
    const recovery = source.indexOf('const recoveredChoice = recoverLegacySessionChoice(requestedModel, storedModel)');
    const validation = source.indexOf('if (!recoveredChoice && requestedMatches');
    const readiness = source.indexOf('if (!isPiPresetMappingReady(sourceModel))');
    expect(recovery).toBeGreaterThan(0);
    expect(validation).toBeGreaterThan(recovery);
    expect(readiness).toBeGreaterThan(validation);
    expect(source).toContain('const sourceModel = recoveredChoice ?? (requestedMatches ? requestedModel : storedModel)');
    expect(source).toContain('requestedMatchesEngineModel = recoveredChoice ??');
  });
  it('releases admission lock on both model rejections so retry can proceed', () => {
    for (const code of ['MODEL_NOT_SELECTABLE', 'MODEL_PRESET_UNAVAILABLE']) {
      expect(source.slice(source.indexOf(`errorCode: '${code}'`), source.indexOf(`errorCode: '${code}'`) + 110)).toMatch(/releaseLock\(\);\s+return;/);
    }
  });
  it('persists and broadcasts recovery before the final synchronous race guard', () => {
    const recovery = source.indexOf('if (recoveredLegacyModel)');
    const race = source.indexOf('// Race guard: the `engine.isRunning` gate');
    expect(recovery).toBeLessThan(race);
    expect(source.slice(recovery, race)).toContain("await updateSession(sessionId, { modelUsed: 'preset/core' })");
    expect(source.slice(recovery, race)).toContain('modelRecovery: { from: recoveredLegacyModel, to: \'preset/core\' }');
    expect(source.slice(recovery, race)).toContain("type: 'session_meta_update'");
    expect(source.slice(recovery, race)).toContain("broadcastTowerMessage(sessionId, { type: 'assistant'");
    expect(source.slice(recovery, race)).not.toContain("data.model = 'preset/core'");
  });
});

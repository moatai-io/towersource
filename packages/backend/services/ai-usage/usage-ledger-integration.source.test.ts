import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const read = (relative: string) => fs.readFileSync(path.resolve(import.meta.dirname, relative), 'utf8');

describe('AI usage ledger integration', () => {
  it('records interactive and background Pi turn completions', () => {
    expect(read('../../routes/ws-handler.ts')).toContain('recordPiUsageEvent({');
    expect(read('../agent-communication/session-turn-runner.ts')).toContain('recordPiUsageEvent({');
    expect(read('../task/task-runner.ts')).toContain('recordPiUsageEvent({');
    expect(read('../ai/proactive-agent.ts')).toContain('recordPiUsageEvent({');
  });

  it('keeps preset selection separate from runtime model and workload policy', () => {
    const ws = read('../../routes/ws-handler.ts');
    const ledger = read('./usage-ledger.ts');
    expect(ws).toContain('isPiPresetMappingReady(sourceModel)');
    expect(ws).toContain("errorCode: 'MODEL_PRESET_UNAVAILABLE'");
    expect(ws).toContain('presetForPiTurn(requestedMatchesEngineModel, storedSessionModel)');
    expect(ws).toContain('choiceAfterPiTurn(requestedMatchesEngineModel, storedSessionModel, candidateModel)');
    expect(ledger).toContain('selected_preset, preset_mapping_revision');
  });

  it('reconciles late LiteLLM evidence into an existing usage event', () => {
    const src = read('../agent-turn/router-evidence.ts');
    expect(src).toContain('UPDATE ai_usage_events');
    expect(src).toContain('provider_model = COALESCE');
    expect(src).toContain('router_request_id = COALESCE');
    expect(src).toContain("error?.code !== '42P01'");
  });
});

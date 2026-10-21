import { describe, expect, it, vi } from 'vitest';
import { estimatePiCompactionPressure } from '../pi/proactive-compaction.js';
import { computeContextUsageStat } from '../../../frontend/src/utils/context-usage.js';
import { buildPiContextSnapshot } from '../pi/run-context.js';

vi.mock('../pi/provider-safeguards.js', () => ({
  getPiContextTokenHint: () => 0, getPiResponsesRequestDebugInfo: () => undefined,
}));

describe('pressure decision to serialized/restored display', () => {
  it('preserves the decision pair without replacing measured input or model remaining', () => {
    const decision = estimatePiCompactionPressure({ towerSessionId: 'synthetic', session: {
      model: { contextWindow: 200_000 },
      settingsManager: { getCompactionSettings: () => ({ enabled: true, reserveTokens: 48_000 }) },
      getContextUsage: () => ({ tokens: 150_000 }),
      sessionManager: { getEntries: () => [{ type: 'message', message: { role: 'assistant', stopReason: 'stop', usage: { input: 100_000, output: 20_000, cacheRead: 30_000, cacheWrite: 0, totalTokens: 150_000 } } }] }, agent: { state: { messages: [] } },
    } });
    const snapshot = { ...buildPiContextSnapshot({ actualTokens: 100_000, estimatedTokens: 150_000,
      windowTokens: 200_000 }), pressure: decision.displayPressure };
    const serialized = JSON.parse(JSON.stringify(snapshot));
    const usage = { context_input_tokens: 100_000, context_window_size: 200_000, context_snapshot: serialized };
    const stat = computeContextUsageStat({ cost: {} as any, messages: [{ id: 'stored', role: 'assistant', timestamp: 1,
      content: [], metadata: { usage } } as any] });
    expect(stat.pressure?.tokens).toBe(decision.probeTokens);
    expect(stat.pressurePct).toBe(100);
    expect(decision.towerWouldCompact).toBe(true);
    expect(stat.contextInput).toBe(100_000);
    expect(stat.maxTokens).toBe(200_000);
    expect(stat.contextRemaining).toBe(100_000);
  });
});

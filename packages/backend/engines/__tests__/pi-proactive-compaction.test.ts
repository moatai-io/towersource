import { afterEach, describe, expect, it, vi } from 'vitest';
import { estimatePiCompactionPressure, shouldProactivelyCompactPiSession } from '../pi/proactive-compaction.js';

vi.mock('../pi/provider-safeguards.js', () => {
  const contextHints = new Map<string, number>();
  const requestDebug = new Map<string, any>();
  return {
    getPiContextTokenHint: (key: string | undefined | null) => key ? contextHints.get(String(key)) : undefined,
    getPiResponsesRequestDebugInfo: (key: string | undefined | null) => key ? (requestDebug.get(String(key)) ?? null) : null,
    __setPiContextHintForTest: (key: string, value: number | undefined) => {
      if (typeof value === 'number') contextHints.set(key, value);
      else contextHints.delete(key);
    },
    __setPiRequestDebugForTest: (key: string, value: any | undefined) => {
      if (value) requestDebug.set(key, value);
      else requestDebug.delete(key);
    },
    __clearPiSafeguardMocksForTest: () => {
      contextHints.clear();
      requestDebug.clear();
    },
  };
});

const safeguardMocks = await import('../pi/provider-safeguards.js') as any;

function makeSession(messageText: string, contextWindow = 10_000, branch: any[] = [], sdkSessionId = 'sdk-session') {
  return {
    model: { contextWindow },
    agent: { state: { messages: [{ role: 'user', content: [{ type: 'text', text: messageText }] }] } },
    sessionManager: { getEntries: () => branch, getBranch: () => branch, getSessionId: () => sdkSessionId },
    settingsManager: { getCompactionSettings: () => ({ enabled: true, reserveTokens: 1_000, keepRecentTokens: 500 }) },
  };
}

function fakeAssistantUsage(contextTokens: number) {
  return [{
    type: 'message',
    message: {
      role: 'assistant',
      usage: { input: contextTokens, output: 0, cacheRead: 0, cacheWrite: 0 },
    },
  }];
}

describe('Pi proactive compaction pressure', () => {
  afterEach(() => {
    safeguardMocks.__clearPiSafeguardMocksForTest();
    delete process.env.PI_PROACTIVE_COMPACTION_PRESSURE;
    delete process.env.PI_PROACTIVE_COMPACTION_MIN_RESERVE_TOKENS;
    delete process.env.PI_PROACTIVE_COMPACTION_RISK_MIN_PRESSURE;
    delete process.env.PI_PROACTIVE_COMPACTION_RISK_INFLATION_MULTIPLIER;
    delete process.env.PI_PROACTIVE_COMPACTION_RISK_INFLATION_ABSOLUTE_TOKENS;
    delete process.env.PI_TOWER_PROACTIVE_COMPACTION_EXECUTION;
  });

  it('compacts before the hard limit when authoritative pressure crosses the proactive threshold', () => {
    const text = 'x'.repeat(36_000); // estimateTokens ~= chars/4 => 9k
    const decision = shouldProactivelyCompactPiSession({
      session: makeSession(text),
      towerSessionId: 'tower-session',
      promptStaticTokenEstimate: 0,
    });

    expect(decision.pressure).toBeGreaterThanOrEqual(0.90);
    expect(decision.triggerSource).toBe('authoritative');
    expect(decision.towerWouldCompact).toBe(true);
    expect(decision.shouldAdvise).toBe(true);
    expect(decision.shouldCompact).toBe(true);
  });

  it('can temporarily disable Tower proactive execution by operator env flag', () => {
    process.env.PI_TOWER_PROACTIVE_COMPACTION_EXECUTION = '0';
    const text = 'x'.repeat(36_000); // estimateTokens ~= chars/4 => 9k
    const decision = shouldProactivelyCompactPiSession({
      session: makeSession(text),
      towerSessionId: 'tower-session',
      promptStaticTokenEstimate: 0,
    });

    expect(decision.shouldAdvise).toBe(true);
    expect(decision.shouldCompact).toBe(false);
  });

  it('does not advise when this turn already compacted', () => {
    const text = 'x'.repeat(36_000);
    const decision = shouldProactivelyCompactPiSession({
      session: makeSession(text),
      towerSessionId: 'tower-session',
      compactionSucceededThisTurn: true,
    });

    expect(decision.towerWouldCompact).toBe(true);
    expect(decision.shouldAdvise).toBe(false);
    expect(decision.shouldCompact).toBe(false);
  });

  it('does not advise again when the latest Pi branch entry is already compaction', () => {
    const text = 'x'.repeat(36_000);
    const decision = shouldProactivelyCompactPiSession({
      session: makeSession(text, 10_000, [{ type: 'message' }, { type: 'compaction' }]),
      towerSessionId: 'tower-session',
    });

    expect(decision.latestEntryType).toBe('compaction');
    expect(decision.towerWouldCompact).toBe(true);
    expect(decision.shouldAdvise).toBe(false);
    expect(decision.shouldCompact).toBe(false);
  });

  it('does not let an inflated request-body hint advise compaction for a low-actual session', () => {
    safeguardMocks.__setPiRequestDebugForTest('tower-session', { bodyEstimatedPromptTokens: 387_208 });
    const decision = shouldProactivelyCompactPiSession({
      session: makeSession('', 258_400, fakeAssistantUsage(79_209)),
      towerSessionId: 'tower-session',
      promptStaticTokenEstimate: 0,
    });

    expect(decision.authoritativeTokens).toBe(79_209);
    expect(decision.riskProbeTokens).toBe(387_208);
    expect(decision.riskProbeSource).toBe('requestBody');
    expect(decision.riskProbeInflated).toBe(true);
    expect(decision.riskProbeAccepted).toBe(false);
    expect(decision.probeTokens).toBe(79_209);
    expect(decision.towerWouldCompact).toBe(false);
    expect(decision.shouldAdvise).toBe(false);
    expect(decision.shouldCompact).toBe(false);
  });

  it('accepts a request-body risk hint once authoritative context is in the upper-70% band', () => {
    safeguardMocks.__setPiRequestDebugForTest('tower-session', { bodyEstimatedPromptTokens: 236_000 });
    const decision = shouldProactivelyCompactPiSession({
      session: makeSession('', 258_400, fakeAssistantUsage(202_000)),
      towerSessionId: 'tower-session',
      promptStaticTokenEstimate: 0,
    });

    expect(decision.authoritativeTokens).toBe(202_000);
    expect(decision.riskProbeTokens).toBe(236_000);
    expect(decision.riskProbeInflated).toBe(false);
    expect(decision.riskProbeAccepted).toBe(true);
    expect(decision.triggerSource).toBe('corroborated-risk');
    expect(decision.probeTokens).toBe(236_000);
    expect(decision.towerWouldCompact).toBe(true);
    expect(decision.shouldAdvise).toBe(true);
    expect(decision.shouldCompact).toBe(true);
  });

  it('accepts a near-limit request-body signal before the authoritative transcript reaches the old upper-70% band', () => {
    safeguardMocks.__setPiRequestDebugForTest('tower-session', { bodyEstimatedPromptTokens: 236_000 });
    const decision = shouldProactivelyCompactPiSession({
      session: makeSession('', 258_400, fakeAssistantUsage(190_000)),
      towerSessionId: 'tower-session',
      promptStaticTokenEstimate: 0,
    });

    expect(decision.authoritativeTokens).toBe(190_000);
    expect(decision.riskProbeTokens).toBe(236_000);
    expect(decision.riskProbeInflated).toBe(false);
    expect(decision.riskProbeAccepted).toBe(true);
    expect(decision.triggerSource).toBe('corroborated-risk');
    expect(decision.probeTokens).toBe(236_000);
    expect(decision.towerWouldCompact).toBe(true);
    expect(decision.shouldAdvise).toBe(true);
    expect(decision.shouldCompact).toBe(true);
  });

  it('keeps request and hint signals visible in the pressure breakdown even when not used as trigger', () => {
    safeguardMocks.__setPiRequestDebugForTest('tower-session', { bodyEstimatedPromptTokens: 210_000 });
    safeguardMocks.__setPiContextHintForTest('tower-session', 220_000);
    safeguardMocks.__setPiContextHintForTest('sdk-session', 230_000);

    const pressure = estimatePiCompactionPressure({
      session: makeSession('short', 258_400, fakeAssistantUsage(100_000)),
      towerSessionId: 'tower-session',
      promptStaticTokenEstimate: 0,
    });

    expect(pressure.lastUsageTokens).toBe(100_000);
    expect(pressure.requestBodyTokens).toBe(210_000);
    expect(pressure.hintedTokens).toBe(220_000);
    expect(pressure.sdkSessionHint).toBe(230_000);
    expect(pressure.riskProbeSource).toBe('sdkHint');
    expect(pressure.probeTokens).toBe(100_000);
  });
});

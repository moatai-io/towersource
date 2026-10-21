import { afterEach, describe, expect, it, vi } from 'vitest';
import { shouldCompact } from '@earendil-works/pi-coding-agent';
import { createPiSettingsManager } from '../pi/session-settings.js';
import { estimatePiCompactionPressure, estimatePiProjectedPressure, shouldProactivelyCompactPiSession } from '../pi/proactive-compaction.js';

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
    delete process.env.PI_PROACTIVE_COMPACTION_RISK_INFLATION_MULTIPLIER;
    delete process.env.PI_PROACTIVE_COMPACTION_RISK_INFLATION_ABSOLUTE_TOKENS;
    delete process.env.PI_TOWER_PROACTIVE_COMPACTION_EXECUTION;
  });

  it('keeps the last provider measurement when a context edit touches only later history', () => {
    const measured = { id: 'a', type: 'message' };
    const later = { id: 't', type: 'message' };
    const edit = { id: 'e', type: 'context_edit', targetId: 't' };
    const assistant = { role: 'assistant', usage: { input: 160_000, output: 0, cacheRead: 0, cacheWrite: 0 }, content: [] };
    const tool = { role: 'toolResult', content: [{ type: 'text', text: 'short result' }] };
    const projection = { entries: [
      { sourceEntry: measured, messages: [assistant] },
      { sourceEntry: later, messages: [tool] },
      { sourceEntry: edit, messages: [] },
    ], messages: [assistant, tool] };
    expect(estimatePiProjectedPressure(projection, [measured, later, edit])).toBeGreaterThanOrEqual(160_000);
    const editedMeasured = { ...edit, targetId: 'a' };
    expect(estimatePiProjectedPressure(projection, [measured, later, editedMeasured])).toBeLessThan(160_000);
  });

  it('delegates the normal threshold to configured SDK settings rather than the old 96k reserve', () => {
    const previousReserve = process.env.PI_COMPACTION_RESERVE_TOKENS;
    const previousKeep = process.env.PI_COMPACTION_KEEP_RECENT_TOKENS;
    try {
      delete process.env.PI_COMPACTION_RESERVE_TOKENS;
      delete process.env.PI_COMPACTION_KEEP_RECENT_TOKENS;
      const settings = createPiSettingsManager().getCompactionSettings();
      expect(settings).toMatchObject({ enabled: true, reserveTokens: 48_000, keepRecentTokens: 20_000 });
      const window = 353_400;
      expect(shouldCompact(window - 48_000, window, settings)).toBe(false);
      expect(shouldCompact(window - 48_000 + 1, window, settings)).toBe(true);
      expect(shouldCompact(window - 96_000 + 1, window, settings)).toBe(false);
    } finally {
      if (previousReserve === undefined) delete process.env.PI_COMPACTION_RESERVE_TOKENS;
      else process.env.PI_COMPACTION_RESERVE_TOKENS = previousReserve;
      if (previousKeep === undefined) delete process.env.PI_COMPACTION_KEEP_RECENT_TOKENS;
      else process.env.PI_COMPACTION_KEEP_RECENT_TOKENS = previousKeep;
    }
  });

  it('uses 72% by default without the old 96k floor on a 200k model', () => {
    const below = shouldProactivelyCompactPiSession({
      session: makeSession('', 200_000, fakeAssistantUsage(143_999)),
      towerSessionId: 'tower-session',
    });
    const atThreshold = shouldProactivelyCompactPiSession({
      session: makeSession('', 200_000, fakeAssistantUsage(144_000)),
      towerSessionId: 'tower-session',
    });
    expect(below.towerWouldCompact).toBe(false);
    expect(below.shouldCompact).toBe(false);
    expect(atThreshold.triggerSource).toBe('authoritative');
    expect(atThreshold.shouldCompact).toBe(true);
    expect(atThreshold.sdkWouldCompact).toBe(false);
  });

  it('leaves 112k of headroom at the 72% boundary of a 400k model', () => {
    const decision = shouldProactivelyCompactPiSession({
      session: makeSession('', 400_000, fakeAssistantUsage(288_000)),
      towerSessionId: 'tower-session',
    });
    expect(decision.pressure).toBe(0.72);
    expect(decision.contextWindow - decision.probeTokens).toBe(112_000);
    expect(decision.shouldCompact).toBe(true);
    expect(decision.sdkWouldCompact).toBe(false);
  });

  it('preserves an explicit operator pressure override', () => {
    vi.stubEnv('PI_PROACTIVE_COMPACTION_PRESSURE', '0.80');
    try {
      const below = shouldProactivelyCompactPiSession({
        session: makeSession('', 400_000, fakeAssistantUsage(288_000)),
        towerSessionId: 'tower-session',
      });
      const atThreshold = shouldProactivelyCompactPiSession({
        session: makeSession('', 400_000, fakeAssistantUsage(320_000)),
        towerSessionId: 'tower-session',
      });
      expect(below.shouldCompact).toBe(false);
      expect(atThreshold.shouldCompact).toBe(true);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('does not compact twice after success or when the last branch entry is compaction', () => {
    const params = { session: makeSession('', 200_000, fakeAssistantUsage(160_000)), towerSessionId: 'tower-session' };
    expect(shouldProactivelyCompactPiSession({ ...params, compactionSucceededThisTurn: true }).shouldCompact).toBe(false);
    expect(shouldProactivelyCompactPiSession({ ...params, overflowCompactionInProgress: true }).shouldCompact).toBe(false);
    const recentCompaction = makeSession('', 200_000, [...fakeAssistantUsage(160_000), { type: 'compaction' }]);
    expect(shouldProactivelyCompactPiSession({ session: recentCompaction, towerSessionId: 'tower-session' }).shouldCompact).toBe(false);
  });

  it('allows temporarily disabling Tower execution while retaining the pressure signal', () => {
    process.env.PI_TOWER_PROACTIVE_COMPACTION_EXECUTION = '0';
    const result = shouldProactivelyCompactPiSession({
      session: makeSession('', 200_000, fakeAssistantUsage(160_000)),
      towerSessionId: 'tower-session',
    });
    expect(result.shouldAdvise).toBe(true);
    expect(result.shouldCompact).toBe(false);
  });

  it('does not let an inflated request-body hint advise compaction for a low-actual session', () => {
    safeguardMocks.__setPiRequestDebugForTest('tower-session', { bodyEstimatedPromptTokens: 387_208 });
    const decision = estimatePiCompactionPressure({
      session: makeSession('', 258_400, fakeAssistantUsage(79_209)),
      towerSessionId: 'tower-session',
      promptStaticTokenEstimate: 0,
    });

    expect(decision.authoritativeTokens).toBe(79_209);
    expect(decision.riskProbeTokens).toBe(387_208);
    expect(decision.riskProbeSource).toBe('requestBody');
    expect(decision.riskProbeInflated).toBe(true);
    expect(decision.probeTokens).toBe(79_209);
    expect(decision.towerWouldCompact).toBe(false);
    expect(shouldProactivelyCompactPiSession({
      session: makeSession('', 258_400, fakeAssistantUsage(79_209)),
      towerSessionId: 'tower-session',
    }).shouldCompact).toBe(false);
  });

  it('does not compact at the reported 64% because a previous request estimated 85.7%', () => {
    safeguardMocks.__setPiRequestDebugForTest('tower-session', { bodyEstimatedPromptTokens: 302_890 });
    safeguardMocks.__setPiContextHintForTest('tower-session', 226_047);
    const params = {
      session: makeSession('', 353_400, fakeAssistantUsage(226_047)),
      towerSessionId: 'tower-session',
    };
    const decision = shouldProactivelyCompactPiSession(params);

    expect(decision.authoritativeTokens).toBe(226_047);
    expect(decision.riskProbeTokens).toBe(302_890);
    expect(decision.riskProbeSource).toBe('requestBody');
    expect(decision.probeTokens).toBe(226_047);
    expect(decision.towerWouldCompact).toBe(false);
    expect(decision.shouldCompact).toBe(false);
    // Once current-session usage crosses 72%, the same stale hint cannot
    // prevent normal compaction either.
    expect(shouldProactivelyCompactPiSession({
      ...params,
      session: makeSession('', 353_400, fakeAssistantUsage(254_448)),
    }).shouldCompact).toBe(true);
  });

  it('keeps a near-limit previous request in diagnostics rather than triggering below 72%', () => {
    safeguardMocks.__setPiRequestDebugForTest('tower-session', { bodyEstimatedPromptTokens: 300_000 });
    const decision = shouldProactivelyCompactPiSession({
      session: makeSession('', 258_400, fakeAssistantUsage(180_000)),
      towerSessionId: 'tower-session',
    });
    expect(decision.riskProbeTokens).toBe(300_000);
    expect(decision.probeTokens).toBe(180_000);
    expect(decision.shouldCompact).toBe(false);
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

it('publishes the identical Tower decision token pair, including output and cache', () => {
  const session = makeSession('hello', 200_000);
  session.sessionManager.getEntries = () => [{ type: 'message', message: { role: 'assistant', stopReason: 'stop',
    usage: { input: 100_000, output: 20_000, cacheRead: 30_000, cacheWrite: 10_000, totalTokens: 160_000 } } }];
  const result = estimatePiCompactionPressure({ session, towerSessionId: 'pair' });
  expect(result.probeTokens).toBe(160_000);
  expect(result.displayPressure?.tokens).toBe(result.probeTokens);
  expect(result.displayPressure?.thresholdTokens).toBe(144_000);
  expect(result.towerWouldCompact).toBe(true);
});

it('does not serialize a pressure limit when Tower is disabled', () => {
  vi.stubEnv('PI_TOWER_PROACTIVE_COMPACTION_EXECUTION', '0');
  try {
    const result = estimatePiCompactionPressure({ session: makeSession(), towerSessionId: 'disabled' });
    expect(result.displayPressure).toBeUndefined();
  } finally { vi.unstubAllEnvs(); }
});

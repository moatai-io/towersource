// Owns Tower-side compaction advisory signals for Pi sessions.
// Public API: estimatePiCompactionPressure, shouldProactivelyCompactPiSession.

import { calculateContextTokens, estimateTokens, getLastAssistantUsage, shouldCompact } from '@earendil-works/pi-coding-agent';
import { getPiContextTokenHint, getPiResponsesRequestDebugInfo } from './provider-safeguards.js';

export interface PiProactiveCompactionPressure {
  contextWindow: number;
  compactionReason: 'proactive-authoritative' | 'proactive-corroborated-risk' | 'none';
  /** Effective token signal used to decide whether compaction is advisable now. */
  probeTokens: number;
  /** Effective pressure = probeTokens / contextWindow. */
  pressure: number;
  /** Most faithful signal: latest provider usage and current live transcript estimate. */
  authoritativeTokens: number;
  /** Diagnostic/risk signal: outgoing request estimate and provider hint cache. */
  riskProbeTokens: number;
  lastUsageTokens: number;
  messageEstimate: number;
  requestBodyTokens: number;
  hintedTokens: number;
  sdkSessionHint: number;
  riskProbeSource: 'requestBody' | 'towerHint' | 'sdkHint' | 'none';
  riskProbeInflated: boolean;
  riskProbeAccepted: boolean;
  triggerSource: 'authoritative' | 'corroborated-risk' | 'none';
  settings: any;
  sdkWouldCompact: boolean | null;
  towerWouldCompact: boolean;
  latestEntryType: string | null;
}

function latestPiBranchEntryType(session: any): string | null {
  try {
    const branch = session?.sessionManager?.getBranch?.() || session?.sessionManager?.getEntries?.() || [];
    const latest = Array.isArray(branch) ? branch[branch.length - 1] : null;
    return typeof latest?.type === 'string' ? latest.type : null;
  } catch {
    return null;
  }
}

function safeLastAssistantContextTokens(entries: any[] | undefined): number {
  if (!Array.isArray(entries)) return 0;
  try {
    const lastUsage = getLastAssistantUsage(entries);
    return lastUsage ? calculateContextTokens(lastUsage as any) : 0;
  } catch {
    // Pi SDK's helper expects fully-shaped message entries. Proactive compaction
    // should be best-effort and must not fail the user turn because an older or
    // locally synthesized entry has a thinner shape.
    return 0;
  }
}

function chooseRiskProbeSource(signals: {
  requestBodyTokens: number;
  hintedTokens: number;
  sdkSessionHint: number;
}): PiProactiveCompactionPressure['riskProbeSource'] {
  const max = Math.max(signals.requestBodyTokens, signals.hintedTokens, signals.sdkSessionHint);
  if (max <= 0) return 'none';
  if (signals.requestBodyTokens === max) return 'requestBody';
  if (signals.hintedTokens === max) return 'towerHint';
  return 'sdkHint';
}

function wouldCompactByTowerPolicy(tokens: number, contextWindow: number, threshold: number, minReserveTokens: number): boolean {
  if (!Number.isFinite(tokens) || tokens <= 0 || !Number.isFinite(contextWindow) || contextWindow <= 0) return false;
  return (tokens / contextWindow) >= threshold || (contextWindow - tokens) <= minReserveTokens;
}

export function estimatePiCompactionPressure(params: {
  session: any;
  towerSessionId: string;
  promptStaticTokenEstimate?: number;
}): PiProactiveCompactionPressure {
  const session = params.session;
  const contextWindow = Number(session?.model?.contextWindow || 0) || 200_000;
  const settings = session?.settingsManager?.getCompactionSettings?.();
  const entries = session?.sessionManager?.getEntries?.();
  const lastUsageTokens = safeLastAssistantContextTokens(entries);

  const agentMessages = session?.agent?.state?.messages;
  const messageEstimate = Array.isArray(agentMessages)
    ? agentMessages.reduce((sum: number, message: unknown) => sum + estimateTokens(message as any), 0) + (params.promptStaticTokenEstimate || 0)
    : 0;

  const requestDebug = getPiResponsesRequestDebugInfo(params.towerSessionId);
  const requestBodyTokens = typeof requestDebug?.bodyEstimatedPromptTokens === 'number'
    ? requestDebug.bodyEstimatedPromptTokens
    : 0;
  const hintedTokens = getPiContextTokenHint(params.towerSessionId) || 0;
  let sdkSessionHint = 0;
  try {
    const sdkSessionId = session?.sessionManager?.getSessionId?.();
    sdkSessionHint = sdkSessionId ? (getPiContextTokenHint(sdkSessionId) || 0) : 0;
  } catch {
    sdkSessionHint = 0;
  }

  // Provider usage from the last completed assistant response is the most
  // faithful signal. The live transcript estimate is next best because it tracks
  // messages already present in the Pi agent state before the next provider call.
  // Request-body/hint signals are useful diagnostics and output-clamp inputs, but
  // they can be stale after compaction or tool-heavy turns. Do not let an
  // uncorroborated risk hint compact a session that is only ~30-60% full.
  const authoritativeTokens = Math.max(lastUsageTokens, messageEstimate);
  const riskProbeTokens = Math.max(requestBodyTokens, hintedTokens, sdkSessionHint);
  const riskProbeSource = chooseRiskProbeSource({ requestBodyTokens, hintedTokens, sdkSessionHint });
  // Keep Tower ahead of provider/SDK auto-compaction. The SDK compactor can
  // itself fail when started too close to the Responses context edge, especially
  // after long multi-turn tool runs. Default to a modestly earlier Tower-side
  // trigger and accept request-body risk hints once live usage is already in the
  // upper-70% band, not only at the old 90% edge.
  const proactiveThreshold = Number(process.env.PI_PROACTIVE_COMPACTION_PRESSURE || 0.72);
  const minReserveTokens = Number(process.env.PI_PROACTIVE_COMPACTION_MIN_RESERVE_TOKENS || 96_000);
  const riskCorroborationMinPressure = Number(process.env.PI_PROACTIVE_COMPACTION_RISK_MIN_PRESSURE || 0.55);
  const riskInflationMultiplier = Number(process.env.PI_PROACTIVE_COMPACTION_RISK_INFLATION_MULTIPLIER || 4.0);
  const riskInflationAbsoluteTokens = Number(process.env.PI_PROACTIVE_COMPACTION_RISK_INFLATION_ABSOLUTE_TOKENS || 256_000);

  const authoritativePressure = contextWindow > 0 ? authoritativeTokens / contextWindow : 0;
  const riskProbeInflated = authoritativeTokens > 0
    && riskProbeTokens > authoritativeTokens * riskInflationMultiplier
    && (riskProbeTokens - authoritativeTokens) > riskInflationAbsoluteTokens;
  const riskWouldCompact = wouldCompactByTowerPolicy(riskProbeTokens, contextWindow, proactiveThreshold, minReserveTokens);
  const riskProbeAccepted = Boolean(
    riskWouldCompact
    && riskProbeTokens > authoritativeTokens
    && (
      authoritativePressure >= riskCorroborationMinPressure
      // A full outgoing Responses request is more actionable than a stale hint.
      // Accept it directly once it crosses the preflight floor unless it is an
      // obvious multi-x estimator explosion.
      || (riskProbeSource === 'requestBody' && riskProbeTokens / contextWindow >= 0.90)
    )
    && !riskProbeInflated
  );

  const probeTokens = riskProbeAccepted ? riskProbeTokens : authoritativeTokens;
  const sdkWouldCompact = settings && contextWindow
    ? shouldCompact(probeTokens, contextWindow, settings)
    : null;
  const pressure = contextWindow > 0 ? probeTokens / contextWindow : 0;
  const towerWouldCompact = wouldCompactByTowerPolicy(probeTokens, contextWindow, proactiveThreshold, minReserveTokens);
  const latestEntryType = latestPiBranchEntryType(session);
  const triggerSource: PiProactiveCompactionPressure['triggerSource'] = towerWouldCompact
    ? (riskProbeAccepted ? 'corroborated-risk' : 'authoritative')
    : 'none';

  return {
    contextWindow,
    compactionReason: triggerSource === 'authoritative'
      ? 'proactive-authoritative'
      : triggerSource === 'corroborated-risk'
        ? 'proactive-corroborated-risk'
        : 'none',
    probeTokens,
    pressure,
    authoritativeTokens,
    riskProbeTokens,
    lastUsageTokens,
    messageEstimate,
    requestBodyTokens,
    hintedTokens,
    sdkSessionHint,
    riskProbeSource,
    riskProbeInflated,
    riskProbeAccepted,
    triggerSource,
    settings,
    sdkWouldCompact,
    towerWouldCompact,
    latestEntryType,
  };
}

export function shouldProactivelyCompactPiSession(params: {
  session: any;
  towerSessionId: string;
  promptStaticTokenEstimate?: number;
  compactionSucceededThisTurn?: boolean;
  overflowCompactionInProgress?: boolean;
}): PiProactiveCompactionPressure & { shouldAdvise: boolean; shouldCompact: boolean } {
  const pressure = estimatePiCompactionPressure(params);
  const shouldAdvise = Boolean(
    !params.compactionSucceededThisTurn &&
    !params.overflowCompactionInProgress &&
    pressure.latestEntryType !== 'compaction' &&
    pressure.towerWouldCompact
  );

  // 2026-06-24: Tower executes pre-prompt compaction when the reliable pressure
  // signal crosses the proactive threshold. 2026-07-03 lowers the default runway
  // from the old 90% edge to a slightly earlier trigger because Responses
  // summarization can stream-truncate if compaction starts too late. Request-body
  // / hint-only spikes remain advisory unless corroborated by high live usage,
  // preserving the guard against confusing low-actual “왜 compact?” cases.
  // Operators can temporarily disable this if SDK behavior changes unexpectedly.
  const executionDisabled = process.env.PI_TOWER_PROACTIVE_COMPACTION_EXECUTION === '0';
  return { ...pressure, shouldAdvise, shouldCompact: !executionDisabled && shouldAdvise };
}

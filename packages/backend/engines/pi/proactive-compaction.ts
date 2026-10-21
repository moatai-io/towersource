import type { MessageMetrics } from '../types.js';
import { resolvePiCompactionBudget } from './compaction-budget.js';
// Tower pre-prompt compaction policy. The SDK remains an overflow safety net.
// Public API: estimatePiCompactionPressure, shouldProactivelyCompactPiSession.

import { calculateContextTokens, estimateTokens, getLastAssistantUsage, shouldCompact } from '@earendil-works/pi-coding-agent';
import { getPiContextTokenHint, getPiResponsesRequestDebugInfo } from './provider-safeguards.js';

export interface PiProactiveCompactionPressure {
  contextWindow: number;
  displayPressure?: NonNullable<MessageMetrics['contextSnapshot']>['pressure'];
  compactionReason: 'proactive-authoritative' | 'none';
  /** Current-session usage signal used for normal pre-prompt compaction. */
  probeTokens: number;
  /** Effective pressure = probeTokens / contextWindow. */
  pressure: number;
  /** Latest provider usage or live transcript estimate; the latter is not a provider measurement. */
  authoritativeTokens: number;
  /** Diagnostic only: last outgoing request estimate and provider hint cache. */
  riskProbeTokens: number;
  lastUsageTokens: number;
  messageEstimate: number;
  requestBodyTokens: number;
  hintedTokens: number;
  sdkSessionHint: number;
  riskProbeSource: 'requestBody' | 'towerHint' | 'sdkHint' | 'none';
  riskProbeInflated: boolean;
  /** Compatibility diagnostic; previous-request risk never triggers normal compaction. */
  riskProbeAccepted: boolean;
  triggerSource: 'authoritative' | 'none';
  settings: any;
  /** SDK threshold applied to Tower's probe; NOT an SDK execution decision. */
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

/** Use only active projected messages and usage newer than the last context rewrite. */
export function estimatePiProjectedPressure(projection: any, branch: any[]): number {
  const messages = projection.messages || [];
  const entries = projection.entries || [];
  const branchIndex = new Map(branch.map((entry: any, index: number) => [entry.id, index]));
  // A context edit invalidates provider usage only if it changes an entry the
  // provider had already measured. Edits to messages after that usage are
  // accounted for by estimating the trailing projection instead.
  let latestUsageIndex = -1;
  let latestUsageSourceIndex = -1;
  let usageTokens = 0;
  let index = 0;
  for (const entry of entries) {
    const sourceIndex = branchIndex.get(entry.sourceEntry?.id) ?? -1;
    for (const message of entry.messages || []) {
      if (message.role === 'assistant' && message.stopReason !== 'error'
        && message.stopReason !== 'aborted' && message.usage) {
        const tokens = calculateContextTokens(message.usage);
        if (Number.isFinite(tokens) && tokens > 0) {
          latestUsageIndex = index;
          latestUsageSourceIndex = sourceIndex;
          usageTokens = tokens;
        }
      }
      index++;
    }
  }
  // A compaction checkpoint supersedes earlier usage, even if the kept range
  // contains old assistant messages. Edits to measured entries do the same.
  const invalidatesUsage = branch.some((entry: any, index: number) =>
    index > latestUsageSourceIndex && (
      entry.type === 'compaction'
      || (entry.type === 'context_edit' && (branchIndex.get(entry.targetId) ?? Infinity) <= latestUsageSourceIndex)
    ));
  if (invalidatesUsage) {
    return messages.reduce((sum: number, message: any) => sum + estimateTokens(message), 0);
  }
  return usageTokens + messages.slice(latestUsageIndex + 1)
    .reduce((sum: number, message: any) => sum + estimateTokens(message), 0);
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

  // The request-body estimate is captured during the previous provider call.
  // At this pre-prompt boundary it is not a measurement of the next request.
  // Use current session usage/transcript for normal compaction; Pi's actual
  // provider-overflow handling and Tower's bounded 413 recovery remain separate.
  // Canonical SDK projection invalidates usage from before context edits or
  // compaction and includes trailing tool results. Never resurrect raw history.
  const projection = session?.sessionManager?.buildSessionProjection?.();
  const authoritativeTokens = projection
    ? estimatePiProjectedPressure(projection, session.sessionManager.getBranch())
    : Math.max(lastUsageTokens, messageEstimate);
  const riskProbeTokens = Math.max(requestBodyTokens, hintedTokens, sdkSessionHint);
  const riskProbeSource = chooseRiskProbeSource({ requestBodyTokens, hintedTokens, sdkSessionHint });
  // Start before the SDK's near-window threshold, leaving room for long
  // tool loops and a summarization request. This is a token-pressure trigger,
  // not a byte-limit guarantee; the router must independently accept the body.
  // Do not restore the old 96k absolute floor (which compacted 200k sessions
  // near 52%) or trigger on stale outgoing-request token estimates.
  const budget = resolvePiCompactionBudget(contextWindow, settings);
  const riskInflationMultiplier = Number(process.env.PI_PROACTIVE_COMPACTION_RISK_INFLATION_MULTIPLIER || 4.0);
  const riskInflationAbsoluteTokens = Number(process.env.PI_PROACTIVE_COMPACTION_RISK_INFLATION_ABSOLUTE_TOKENS || 256_000);
  const riskProbeInflated = authoritativeTokens > 0
    && riskProbeTokens > authoritativeTokens * riskInflationMultiplier
    && (riskProbeTokens - authoritativeTokens) > riskInflationAbsoluteTokens;
  const probeTokens = authoritativeTokens;
  // The SDK may also compact independently at its configured reserve.
  const sdkWouldCompact = settings && contextWindow
    ? shouldCompact(probeTokens, contextWindow, settings)
    : null;
  const pressure = contextWindow > 0 ? probeTokens / contextWindow : 0;
  const towerWouldCompact = probeTokens > 0 && probeTokens >= budget.towerThresholdTokens;
  const latestEntryType = latestPiBranchEntryType(session);
  const triggerSource: PiProactiveCompactionPressure['triggerSource'] = towerWouldCompact
    ? 'authoritative'
    : 'none';

  return {
    contextWindow,
    displayPressure: process.env.PI_TOWER_PROACTIVE_COMPACTION_EXECUTION !== '0'
      && Number.isFinite(probeTokens) && probeTokens > 0
      && Number.isFinite(budget.towerThresholdTokens) && budget.towerThresholdTokens > 0
      && budget.towerThresholdTokens <= contextWindow
      ? { tokens: probeTokens, thresholdTokens: budget.towerThresholdTokens,
          policy: 'tower-pre-prompt', source: projection ? 'projection' : 'usage-or-transcript', observedAt: Date.now() }
      : undefined,
    compactionReason: triggerSource === 'authoritative' ? 'proactive-authoritative' : 'none',
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
    riskProbeAccepted: false,
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

  // Tower executes pre-prompt compaction at the configured current-session
  // pressure. Previous request-body estimates never authorize normal compaction.
  // Operators can temporarily disable this if SDK behavior changes unexpectedly.
  const executionDisabled = process.env.PI_TOWER_PROACTIVE_COMPACTION_EXECUTION === '0';
  return { ...pressure, shouldAdvise, shouldCompact: !executionDisabled && shouldAdvise };
}

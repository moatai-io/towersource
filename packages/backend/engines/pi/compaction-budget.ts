// Configuration is read at the engine boundary; policy arithmetic is pure.
export interface PiCompactionPolicy {
  ratio: number;
  minReserveTokens: number;
  enabled: boolean;
}
export function readPiCompactionPolicy(): PiCompactionPolicy {
  return {
    ratio: Number(process.env.PI_PROACTIVE_COMPACTION_PRESSURE ?? 0.72),
    minReserveTokens: Number(process.env.PI_PROACTIVE_COMPACTION_MIN_RESERVE_TOKENS ?? 0),
    enabled: process.env.PI_TOWER_PROACTIVE_COMPACTION_EXECUTION !== '0',
  };
}
export function resolvePiCompactionBudget(contextWindow: number, settings?: { enabled?: boolean; reserveTokens?: number }, policy = readPiCompactionPolicy()) {
  const reserveTokens = settings?.reserveTokens ?? Number(process.env.PI_COMPACTION_RESERVE_TOKENS || 48_000);
  const towerThresholdTokens = Math.max(0, Math.min(contextWindow * policy.ratio, contextWindow - policy.minReserveTokens));
  const sdkThresholdTokens = contextWindow - reserveTokens;
  // Compatibility diagnostic only. Never use this combined budget as a UI prediction.
  const thresholdTokens = Math.max(0, Math.min(policy.enabled ? towerThresholdTokens : Infinity,
    settings?.enabled === false ? Infinity : sdkThresholdTokens));
  return { towerThresholdTokens, sdkThresholdTokens, thresholdTokens, reserveTokens };
}

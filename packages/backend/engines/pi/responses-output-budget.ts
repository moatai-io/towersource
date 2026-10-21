/** Transport-only output reservation. Never rejects input or triggers compaction. */
export function clampResponsesOutputBudget(body: Record<string, any>, contextWindow: number | undefined, estimatedInputTokens: number): boolean {
  const requested = Number(body.max_output_tokens);
  if (!Number.isFinite(contextWindow) || !contextWindow || contextWindow <= 0 ||
      !Number.isFinite(estimatedInputTokens) || estimatedInputTokens < 0 ||
      !Number.isFinite(requested) || requested <= 0) return false;
  // Leave bounded headroom for estimator drift; do not invent a context-overflow
  // error when input alone is oversized. The provider/SDK owns that recovery.
  const reserve = Math.min(16384, Math.ceil(contextWindow * 0.03));
  const available = Math.max(1024, Math.floor(contextWindow - estimatedInputTokens - reserve));
  const capped = Math.min(Math.floor(requested), available);
  if (capped >= requested) return false;
  body.max_output_tokens = capped;
  return true;
}

/** Display-only context contract; never controls compaction or request admission. */
export function resolveContextMetric(input: { actual?: number; estimated?: number; compacted?: boolean }) {
  const positive = (n?: number) => Number.isFinite(n) && Number(n) > 0 ? Number(n) : 0;
  const actual = positive(input.actual);
  const estimated = positive(input.estimated);
  const isEstimated = estimated > 0 && (input.compacted === true || actual === 0);
  return { tokens: isEstimated ? estimated : actual, isEstimated };
}

/** Incomplete live updates must not erase the last measurement. Session resets bypass this. */
export function preserveMeasuredContext<T extends { contextInputTokens?: number; contextEstimatedTokens?: number; contextWindowSize?: number; contextCompacted?: boolean }>(previous: Partial<T>, next: T): T {
  if ((next.contextInputTokens || 0) > 0 || next.contextCompacted === true) return next;
  if ((previous.contextInputTokens || 0) <= 0) return next;
  return { ...next, contextInputTokens: previous.contextInputTokens, contextWindowSize: next.contextWindowSize || previous.contextWindowSize, contextEstimatedTokens: previous.contextEstimatedTokens, contextCompacted: previous.contextCompacted };
}

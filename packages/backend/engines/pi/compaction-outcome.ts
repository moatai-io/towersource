// Owns classification of Pi compaction outcomes that are safe to skip.
// Public API: isPiCompactionNoOpMessage.

/**
 * Returns true only when Pi explicitly says there was no useful history to
 * compact. This is a successful no-op, not a summarizer/provider failure.
 */
export function isPiCompactionNoOpMessage(message: unknown): boolean {
  return /(?:^|\b)nothing to compact(?:\b|$)|session too small|no useful prefix to compact|no compactable (?:history|messages?)/i.test(String(message || ''));
}

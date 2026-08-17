/**
 * Owns: Spoken Korean response shaping and safe acknowledgement text.
 * Public API: buildSafeAcknowledgement, normalizeSpokenAnswer. See README.md.
 */

const DEFAULT_ACKS = [
  '네, 무슨 뜻인지 알겠어요. 잠깐 확인해볼게요.',
  '좋아요. 핵심을 확인해서 바로 말씀드릴게요.',
  '네, 그 부분을 먼저 살펴볼게요.',
] as const;

/** Return a non-factual bridge sentence while the durable Tower Agent works. */
export function buildSafeAcknowledgement(seed = 0): string {
  const index = Math.abs(seed) % DEFAULT_ACKS.length;
  return DEFAULT_ACKS[index];
}

/** Remove screen-only Markdown markers without shortening or summarizing the spoken answer. */
export function normalizeSpokenAnswer(text: string): string {
  return text
    .replace(/```(?:[\w+-]+)?\s*([\s\S]*?)```/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^\s*[-*+]\s+/gm, '')
    .replace(/^\s*\d+[.)]\s+/gm, '')
    .replace(/\*\*|__/g, '')
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

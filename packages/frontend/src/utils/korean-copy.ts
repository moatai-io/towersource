// Owns: particle-free Korean rendering for user-controlled names in UI copy. Public API: formatNamedItem.

/**
 * Wrap a user-controlled name with a fixed Korean noun so callers never have to guess its pronunciation.
 * This is intentionally particle-free at the value boundary because English, numbers, symbols, and emoji are ambiguous.
 */
export function formatNamedItem(value: string): string {
  return `"${value}" 항목`;
}

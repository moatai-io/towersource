import { isSelectablePiModelId } from '../../config.js';

/** Recover only a persisted, retired direct Pi choice, not a new explicit choice. */
export function recoverLegacySessionChoice(requested: string | undefined, stored: string | null | undefined): string | undefined {
  const normalize = (value: string | null | undefined) => value?.replace(/^pi:/, '');
  const previous = normalize(stored);
  if (!previous || !previous.includes('/') || previous.startsWith('preset/') || previous.startsWith('policy/')) return undefined;
  if (requested !== undefined && normalize(requested) !== previous) return undefined;
  if (isSelectablePiModelId(previous)) return undefined;
  // Core readiness is checked by the admission path before execution or persistence.
  return 'preset/core';
}

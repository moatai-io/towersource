/**
 * pi-steer-tracker — pure helper for detecting consumed mid-turn steers.
 *
 * Owns: the multiset diff that turns Pi SDK `queue_update` snapshots into
 * "this steer was just consumed" signals. Public API: diffConsumedSteers.
 *
 * Kept standalone (not inside pi-engine.ts) so it's unit-testable without
 * loading the Pi SDK. See pi-engine.ts `case 'queue_update'` for the caller,
 * and GitHub issue #15 for why steer delivery needs surfacing to the UI.
 */

/**
 * Multiset difference: which steer texts were present before but are gone now.
 *
 * The Pi SDK reports the *current* pending steering texts on every
 * `queue_update`. A text dropping out of that array means the agent consumed
 * (recognized) it. Counting by occurrence handles the edge case of the same
 * text being steered twice in one turn.
 *
 * @param prev    steering texts from the previous snapshot
 * @param current steering texts from the current snapshot
 * @returns texts present in `prev` that no longer have a slot in `current`
 */
export function diffConsumedSteers(prev: readonly string[], current: readonly string[]): string[] {
  const curCount = new Map<string, number>();
  for (const t of current) curCount.set(t, (curCount.get(t) ?? 0) + 1);
  const consumed: string[] = [];
  for (const t of prev) {
    const remaining = curCount.get(t) ?? 0;
    if (remaining > 0) {
      curCount.set(t, remaining - 1); // still pending — accounts for this slot
    } else {
      consumed.push(t); // present before, no slot now → delivered
    }
  }
  return consumed;
}

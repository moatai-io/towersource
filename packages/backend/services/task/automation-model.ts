import { isPiPresetMappingReady, resolvePiSessionChoice, sessionAlias } from '../model-policy/session-alias.js';

/** Keep the stored selection separate from the VM-local Router ID used for this run. */
export function resolveAutomationModel(choice: string | null | undefined): string {
  const selected = choice || 'preset/core';
  if (sessionAlias(selected)) {
    if (!isPiPresetMappingReady(selected)) throw new Error('MODEL_PRESET_UNAVAILABLE');
    return resolvePiSessionChoice(selected);
  }
  return selected;
}

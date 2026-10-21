import { getModelDefaults, isPiModelEntrySelectableForThisVm, loadModelsFile, normalizePiSessionModelId } from '../../config.js';
import { isAllowedTowerPiModel } from '../../engines/pi/provider-boundary.js';

export type SessionAlias = 'core' | 'lite';

/** Only an explicit Tower selection carries preset attribution. Router IDs are direct. */
export function sessionAlias(model: string | null | undefined): SessionAlias | undefined {
  const normalized = model?.replace(/^pi:/, '');
  return normalized === 'preset/core' || normalized === 'policy/core' ? 'core'
    : normalized === 'preset/lite' || normalized === 'policy/lite' ? 'lite' : undefined;
}

export function persistPiSessionChoice(model: string): string {
  const alias = sessionAlias(model);
  return alias ? `preset/${alias}` : normalizePiSessionModelId(model);
}

export function resolvePiSessionChoice(model: string | null | undefined): string {
  const alias = sessionAlias(model);
  if (alias) {
    const defaults = getModelDefaults();
    return (alias === 'core' ? defaults.session : defaults.ai_task).replace(/^pi:/, '');
  }
  const choice = normalizePiSessionModelId(model);
  // Missing/retired choices use Core. Readiness checks the resolved physical
  // mapping before a turn starts; never recurse through a preset-valued mapping.
  return sessionAlias(choice) ? getModelDefaults().session.replace(/^pi:/, '') : choice;
}

/** An invalid VM mapping must not silently fall through to another model. */
export function isPiPresetMappingReady(model: string | null | undefined): boolean {
  const choice = normalizePiSessionModelId(model);
  if (!sessionAlias(choice)) return true;
  const rawMapping = sessionAlias(choice) === 'core' ? getModelDefaults().session : getModelDefaults().ai_task;
  if (sessionAlias(rawMapping)) return false;
  const target = resolvePiSessionChoice(choice);
  if (!isAllowedTowerPiModel(target)) return false;
  const file = loadModelsFile();
  const entry = file.pi.find(item => `${item.provider}/${item.modelId}` === target);
  return !!entry && isPiModelEntrySelectableForThisVm(entry, file.litellmCatalog?.syncedAt);
}

export function presetForPiTurn(requested: string | undefined, stored: string | null | undefined): SessionAlias | undefined {
  return sessionAlias(normalizePiSessionModelId(requested ?? stored));
}

export function choiceAfterPiTurn(requested: string | undefined, stored: string | null | undefined, executed: string): string {
  const alias = presetForPiTurn(requested, stored);
  return alias ? `preset/${alias}` : executed;
}

/** Snapshot the VM mapping revision when the turn starts, not when it finishes. */
export function presetMappingRevision(): number {
  const revision = loadModelsFile().modelPolicies?.revision;
  return Number.isInteger(revision) && revision! > 0 ? revision! : 1;
}

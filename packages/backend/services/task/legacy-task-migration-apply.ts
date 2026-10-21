/**
 * Owns: recoverable cutover from one active legacy scheduled task to Automation.
 * Public API: applyLegacyTaskScheduleMigrationItem().
 *
 * Cutover order is deliberately fail-closed:
 * 1. create/reuse a disabled Automation,
 * 2. disable the legacy task with an active-state compare-and-set,
 * 3. enable the Automation.
 * A retry repairs either intermediate state without creating a duplicate.
 */
import { execute, queryOne } from '../../db/pg-repo.js';
import { createAutomation, getAutomation, updateAutomation } from './automation-manager.js';
import type { LegacyTaskMigrationPlanItem } from './legacy-task-migration.js';

export interface LegacyTaskMigrationApplyResult {
  legacyTaskId: string;
  automationId: string;
  outcome: 'migrated' | 'recovered';
}

export async function applyLegacyTaskScheduleMigrationItem(item: LegacyTaskMigrationPlanItem): Promise<LegacyTaskMigrationApplyResult> {
  if (item.action !== 'create_automation' || !item.proposedAutomation) {
    throw new Error(item.reason || `legacy task ${item.legacyTaskId} is not migratable`);
  }

  const a = item.proposedAutomation;
  let existing = await queryOne<{ id: string; enabled: boolean }>(
    `SELECT id, enabled FROM automations
      WHERE definition_json->>'legacyTaskId' = $1
        AND status != 'archived'
      ORDER BY created_at ASC
      LIMIT 1`,
    [item.legacyTaskId],
  );
  let outcome: 'migrated' | 'recovered' = existing ? 'recovered' : 'migrated';

  if (!existing) {
    const automation = await createAutomation({
      userId: a.userId!,
      projectId: a.projectId || undefined,
      name: a.name,
      description: a.description,
      prompt: a.prompt,
      model: a.model || undefined,
      workflow: a.workflow || undefined,
      jobType: a.jobType,
      scopeType: a.scopeType,
      definitionJson: a.definitionJson,
      mode: a.mode,
      cwd: a.cwd,
      triggerType: a.triggerType,
      cronConfig: a.cronConfig || undefined,
      onceAt: a.onceAt || undefined,
      enabled: false,
    });
    existing = { id: automation.id, enabled: automation.enabled };
  }

  const legacy = await queryOne<{ schedule_enabled: number | boolean | null }>(
    'SELECT schedule_enabled FROM tasks WHERE id = $1',
    [item.legacyTaskId],
  );
  if (!legacy) throw new Error(`legacy task ${item.legacyTaskId} disappeared during migration`);

  const legacyEnabled = legacy.schedule_enabled === 1 || legacy.schedule_enabled === true;
  if (legacyEnabled) {
    const disabled = await execute(
      `UPDATE tasks SET schedule_enabled = 0, updated_at = CURRENT_TIMESTAMP
        WHERE id = $1 AND schedule_enabled = 1`,
      [item.legacyTaskId],
    );
    if (disabled.changes !== 1) throw new Error(`legacy task ${item.legacyTaskId} cutover lost its active-state race`);
  }

  const automation = await getAutomation(existing.id);
  if (!automation) throw new Error(`automation ${existing.id} disappeared during migration`);
  if (!automation.enabled) {
    const enabled = await updateAutomation(existing.id, { enabled: true, updatedByUserId: a.userId! });
    if (!enabled?.enabled) throw new Error(`failed to enable migrated automation ${existing.id}`);
  }

  return { legacyTaskId: item.legacyTaskId, automationId: existing.id, outcome };
}

#!/usr/bin/env tsx
/**
 * Migrate legacy scheduled tasks into the automations Job Registry.
 *
 * Usage:
 *   DATABASE_URL=... npx tsx scripts/migrate-legacy-tasks-to-automations.ts --dry-run
 *   DATABASE_URL=... npx tsx scripts/migrate-legacy-tasks-to-automations.ts --apply
 *
 * Safety:
 * - Dry-run by default.
 * - Idempotent: skips a legacy task if an automation already has
 *   definition_json.legacyTaskId = <task id>.
 * - Apply creates automation first, then disables the legacy task schedule to
 *   prevent double execution.
 */
import { closePgPool } from '../packages/backend/db/pg.js';
import { execute, queryOne } from '../packages/backend/db/pg-repo.js';
import { createAutomation } from '../packages/backend/services/task/automation-manager.js';
import { planLegacyTaskScheduleMigration } from '../packages/backend/services/task/legacy-task-migration.js';

const apply = process.argv.includes('--apply');
const dryRun = process.argv.includes('--dry-run') || !apply;

async function main() {
  const plan = await planLegacyTaskScheduleMigration();
  const result = {
    mode: dryRun ? 'dry-run' : 'apply',
    generatedAt: plan.generatedAt,
    candidateCount: plan.candidateCount,
    createCount: plan.createCount,
    skipCount: plan.skipCount,
    created: [] as Array<{ legacyTaskId: string; automationId: string }>,
    skipped: [] as Array<{ legacyTaskId: string; reason: string }>,
  };

  for (const item of plan.items) {
    if (item.action !== 'create_automation' || !item.proposedAutomation) {
      result.skipped.push({ legacyTaskId: item.legacyTaskId, reason: item.reason || 'not createable' });
      continue;
    }

    const existing = await queryOne<{ id: string }>(
      `SELECT id FROM automations
       WHERE definition_json->>'legacyTaskId' = $1
         AND status != 'archived'
       LIMIT 1`,
      [item.legacyTaskId],
    );
    if (existing) {
      result.skipped.push({ legacyTaskId: item.legacyTaskId, reason: `already migrated as ${existing.id}` });
      continue;
    }

    const a = item.proposedAutomation;
    if (dryRun) {
      result.created.push({ legacyTaskId: item.legacyTaskId, automationId: '<dry-run>' });
      continue;
    }

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
    });

    await execute(
      `UPDATE tasks
       SET schedule_enabled = 0, updated_at = CURRENT_TIMESTAMP
       WHERE id = $1`,
      [item.legacyTaskId],
    );

    result.created.push({ legacyTaskId: item.legacyTaskId, automationId: automation.id });
  }

  console.log(JSON.stringify(result, null, 2));
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closePgPool().catch(() => {});
  });

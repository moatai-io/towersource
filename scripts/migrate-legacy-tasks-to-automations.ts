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
 * - Apply creates/reuses a disabled Automation, disables the legacy schedule,
 *   then enables the Automation. Retries reconcile interrupted cutovers.
 */
import { closePgPool } from '../packages/backend/db/pg.js';
import { queryOne } from '../packages/backend/db/pg-repo.js';
import { applyLegacyTaskScheduleMigrationItem } from '../packages/backend/services/task/legacy-task-migration-apply.js';
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

    const existing = await queryOne<{ id: string; enabled: boolean }>(
      `SELECT id, enabled FROM automations
       WHERE definition_json->>'legacyTaskId' = $1
         AND status != 'archived'
       LIMIT 1`,
      [item.legacyTaskId],
    );
    if (dryRun && existing) {
      result.skipped.push({ legacyTaskId: item.legacyTaskId, reason: `already migrated as ${existing.id}; apply would reconcile cutover state` });
      continue;
    }

    if (dryRun) {
      result.created.push({ legacyTaskId: item.legacyTaskId, automationId: '<dry-run>' });
      continue;
    }

    const migrated = await applyLegacyTaskScheduleMigrationItem(item);
    result.created.push({ legacyTaskId: item.legacyTaskId, automationId: migrated.automationId });
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

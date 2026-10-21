import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();
const api = fs.readFileSync(path.join(root, 'packages/backend/routes/api.ts'), 'utf8');
const manager = fs.readFileSync(path.join(root, 'packages/backend/services/task/task-manager.ts'), 'utf8');
const runner = fs.readFileSync(path.join(root, 'packages/backend/services/task/task-runner.ts'), 'utf8');
const legacyScheduler = fs.readFileSync(path.join(root, 'packages/backend/services/task/task-scheduler.ts'), 'utf8');
const scheduler = fs.readFileSync(path.join(root, 'packages/backend/services/task/unified-scheduler.ts'), 'utf8');
const migration = fs.readFileSync(path.join(root, 'packages/backend/db/migrations/160_retire_legacy_task_scheduling.sql'), 'utf8');

describe('legacy task scheduling retirement', () => {
  it('rejects legacy scheduling fields at the Task API boundary', () => {
    expect(api).toContain('LEGACY_TASK_SCHEDULE_RETIRED: use the Automation Registry');
    expect(api).toContain('req.body?.scheduledAt !== undefined');
    expect(api).toContain('req.body?.scheduleCron !== undefined');
    expect(api).toContain('req.body?.scheduleEnabled !== undefined');
  });

  it('never persists schedules on newly created or updated Tasks', () => {
    expect(manager).toContain('null,\n    null,\n    0,');
    expect(manager).not.toContain("'completedAt' | 'scheduledAt' | 'scheduleCron' | 'scheduleEnabled'");
    expect(manager).not.toContain('fields.push(`scheduled_at =');
    expect(manager).not.toContain('fields.push(`schedule_cron =');
    expect(manager).not.toContain('fields.push(`schedule_enabled =');
  });

  it('does not execute or revive legacy Task schedules', () => {
    expect(scheduler).not.toContain('async function tickLegacyTasks');
    expect(scheduler).not.toContain('tickLegacyTasks();');
    expect(legacyScheduler).not.toContain('SELECT * FROM tasks');
    expect(legacyScheduler).not.toContain('startScheduler');
    expect(runner).not.toContain('Recurring task reset');
    expect(runner).not.toContain('rescheduled →');
  });

  it('archives legacy schedule snapshots before clearing active rows', () => {
    expect(migration).toContain('CREATE TABLE IF NOT EXISTS legacy_schedule_archive');
    expect(migration).toContain('to_jsonb(s)');
    expect(migration).toContain('jsonb_agg(to_jsonb(sr) ORDER BY sr.ran_at)');
    expect(migration.indexOf('INSERT INTO legacy_schedule_archive')).toBeLessThan(migration.indexOf('DELETE FROM schedules'));
    expect(migration).toContain('UPDATE tasks');
    expect(migration).toContain('SET archived = 1');
  });
});

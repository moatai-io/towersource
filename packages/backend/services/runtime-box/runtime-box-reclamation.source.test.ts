import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

const manager = fs.readFileSync(path.resolve(import.meta.dirname, 'runtime-box-manager.ts'), 'utf8');
const reclamation = fs.readFileSync(path.resolve(import.meta.dirname, 'runtime-box-reclamation.ts'), 'utf8');

describe('Runtime Box user budget reclamation contract', () => {
  it('serializes global and per-user starts and rechecks the budget after the normal stop lifecycle', () => {
    expect(manager).toContain("pg_advisory_lock(hashtextextended($1, 0))");
    expect(manager).toContain("'runtime-box-global-start'");
    expect(manager).toContain('`runtime-box-user-start:${userId}`');
    expect(manager).toContain('reclaimUserRuntimeBoxSlotOrThrow(userId, boxId)');
    expect(manager).toContain('tryWithRuntimeBoxActivityLock(candidate.id');
    expect(manager).toContain("await stopBoxWithLocksHeld(candidate.id, 'idle_stopped'");
    expect(manager).toContain('current = await countRunningBoxesByUser(userId)');
  });

  it('locks exec activity and rechecks candidates before stopping', () => {
    expect(manager).toContain('withRuntimeBoxActivityLock(req.boxId');
    expect(manager).toContain('const refreshed = await listUserRuntimeBoxOccupancy(userId, targetBoxId)');
    expect(manager).toContain('stillReclaimable?.id !== candidate.id');
  });

  it('limits candidates to the same owner, excludes the target, and blocks starting/active-service boxes', () => {
    expect(reclamation).toContain('b.created_by = $1');
    expect(reclamation).toContain('b.id <> $2');
    expect(reclamation).toContain("s.status IN ('pending', 'running')");
    expect(reclamation).toContain("box.status === 'running'");
    expect(reclamation).toContain('box.active_service_count === 0');
    expect(reclamation).toContain('box.seconds_until_idle_stop <= 0');
  });

  it('orders candidates by least recent activity and joins project names for diagnostics', () => {
    expect(reclamation).toContain('COALESCE(p.name, b.project_id) AS project_name');
    expect(reclamation).toContain('ORDER BY COALESCE(b.last_active_at, b.started_at, b.created_at) ASC');
    expect(reclamation).toContain('seconds_until_idle_stop');
  });
});

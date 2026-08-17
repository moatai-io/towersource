import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const source = fs.readFileSync(path.resolve(import.meta.dirname, 'api.ts'), 'utf8');
const section = source.slice(source.indexOf("router.get('/schedules'"), source.indexOf('// ═══════════════════════════════════════════════════════════════\n// Automations'));

describe('legacy schedules automation compatibility contract', () => {
  it('uses the automation registry for every compatibility operation', () => {
    expect(section).toContain('getAutomations(userId, role)');
    expect(section).toContain('getAutomation(id)');
    expect(section).toContain('setAutomationEnabled(existing, patch.controlUpdates.enabled as boolean, userId)');
    expect(section).toContain('deleteAutomation(id)');
    expect(section).toContain('runAutomationNow({ automation');
    expect(section).toContain('getAutomationRuns(id');
    expect(section).not.toMatch(/\b(?:getSchedules|getSchedule|updateSchedule|deleteSchedule|runScheduleNow|getScheduleRuns)\b/);
  });

  it('uses capability-specific automation permissions', () => {
    expect(section).toContain("canAccessAutomationJob(schedule, userId, role, 'read')");
    expect(section).toContain("canAccessAutomationJob(existing, userId, role, 'edit')");
    expect(section).toContain('schedule config changes require the automation change-intent API');
    expect(section).toContain("canAccessAutomationJob(existing, userId, role, 'archive')");
    expect(section).toContain("canAccessAutomationJob(automation, userId, role, 'run')");
  });
});

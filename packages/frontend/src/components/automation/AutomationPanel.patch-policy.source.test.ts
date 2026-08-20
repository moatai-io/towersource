import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const automationPanel = readFileSync(new URL('./AutomationPanel.tsx', import.meta.url), 'utf8');
const schedulePanel = readFileSync(new URL('../schedule/SchedulePanel.tsx', import.meta.url), 'utf8');

describe('automation frontend PATCH migration', () => {
  it('uses the explicit confirmed enabled control endpoint', () => {
    expect(automationPanel).toContain('`${API}/${id}/enabled`');
    expect(automationPanel).toContain('confirmed: true');
    expect(schedulePanel).toContain('`${API}/${job.id}/enabled`');
    expect(schedulePanel).toContain('confirmed: true');
  });

  it('does not directly PATCH automation config from active forms', () => {
    expect(automationPanel).not.toContain('`${API}/${editingId}`, { method: \'PATCH\'');
    expect(schedulePanel).not.toContain('`${API}/${job.id}`, { method: \'PATCH\'');
    expect(automationPanel).toContain("t('workbenchEditRequired')");
    expect(schedulePanel).toContain("t('editRequiresReview')");
  });
});

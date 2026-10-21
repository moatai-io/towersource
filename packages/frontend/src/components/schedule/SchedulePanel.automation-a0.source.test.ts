import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = readFileSync(new URL('./SchedulePanel.tsx', import.meta.url), 'utf8');

// Structural guard for the registry list and edit entry point. HTTP/component
// interaction tests are separate; this prevents the specific A0 regression.
describe('SchedulePanel automation A0 boundaries', () => {
  it('retains archived exclusion without hiding never-run manual definitions', () => {
    expect(source).toContain("data.filter((j) => j.status !== 'archived')");
    expect(source).not.toContain("j.triggerType !== 'manual' || j.runCount > 0");
    expect(source).toContain("setJobs(scheduleJobs)");
    expect(source).toContain("view === 'upcoming' ? upcomingJobs : registeredJobs");
  });

  it('keeps the upcoming list limited to enabled definitions with a next run', () => {
    expect(source).toContain('filteredJobs.filter((job) => job.enabled && job.nextRunAt)');
  });

  it('opens an existing change-review route instead of a form with a dead save action', () => {
    expect(source).toContain('onClick={() => void openAutomationAiThread(selectedJob)}');
    expect(source).toContain("isCreationDraft(selectedJob) ? 'planDraftResume' : 'reviewChanges'");
    expect(source).not.toContain('handleSaveEdit');
    expect(source).not.toContain('editFormFromJob');
    expect(source).not.toContain("setError(t('editRequiresReview'))");
  });
});

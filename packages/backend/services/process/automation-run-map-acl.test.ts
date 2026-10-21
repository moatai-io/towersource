import { beforeEach, describe, expect, it, vi } from 'vitest';
const m = vi.hoisted(() => ({ query: vi.fn(), session: vi.fn() }));
vi.mock('../../db/pg-repo.js', () => ({ query: m.query, queryOne: vi.fn() }));
vi.mock('../pm/project-access.js', () => ({ canAccessSession: m.session }));
import { getAutomationRunProcessMap } from './process-map-manager.js';
import type { Automation, AutomationRun } from '../task/automation-manager.js';

const automation = { id: 'job-a', name: 'Project briefing', description: 'Potentially private prompt', prompt: 'Private prompt',
  projectId: 'project-a', jobType: 'ai_prompt', triggerType: 'manual', createdBySessionId: 'source-private',
  sessionId: 'session-private', mode: 'spawn' } as Automation;
const run = { id: 'run-a', automationId: 'job-a', status: 'success', mode: 'spawn', trigger: 'manual',
  resultId: null, runnerKind: 'ai', runnerRef: null, summaryText: null, error: null,
  ranAt: '2026-09-01T00:00:00Z' } as AutomationRun;
const event = (id: string, sessionId: string | null, label: string) => ({
  id, project_id: 'project-a', session_id: sessionId, automation_id: 'job-a', run_id: 'run-a',
  source_type: 'skill_invocation', source_id: id, event_type: 'step_started', raw_label: label,
  raw_payload: { displayName: label, skillName: label }, occurred_at: '2026-09-01T00:00:00Z', created_at: '2026-09-01T00:00:00Z',
});
beforeEach(() => { vi.clearAllMocks(); m.query.mockResolvedValue([]); m.session.mockResolvedValue({ allowed: false }); });

describe('automation Process Map viewer projection', () => {
  it('queries only this run and excludes private and unproven event payloads before node creation', async () => {
    m.query.mockResolvedValue([
      event('secret', 'session-private', 'private-event-evidence'),
      event('untagged', null, 'untagged-event-evidence'),
      event('safe', 'session-shared', 'shared-event-evidence'),
    ]);
    m.session.mockImplementation(async (id: string) => ({ allowed: id === 'session-shared' }));
    const result = await getAutomationRunProcessMap(automation, run, { userId: 8, role: 'member' });
    expect(m.query).toHaveBeenCalledWith(expect.stringMatching(/WHERE run_id = \$1 AND automation_id = \$2/), ['run-a', 'job-a']);
    expect(JSON.stringify(result)).not.toMatch(/private-event-evidence|untagged-event-evidence|source-private|session-private|Private prompt|Potentially private prompt/);
    expect(JSON.stringify(result)).toContain('shared-event-evidence');
    expect(result.sourceRefs.sessionIds).toEqual([]);
  });
  it('fails closed when the Session authority lookup throws', async () => {
    m.query.mockResolvedValue([event('secret', 'session-private', 'secret-event-evidence')]);
    m.session.mockRejectedValue(new Error('Session authority unavailable'));
    const result = await getAutomationRunProcessMap(automation, run, { userId: 8, role: 'member' });
    expect(JSON.stringify(result)).not.toContain('secret-event-evidence');
  });
});

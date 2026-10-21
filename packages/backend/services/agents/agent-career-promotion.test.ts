import { beforeEach, describe, expect, it, vi } from 'vitest';

const { transactionMock, clientQuery } = vi.hoisted(() => ({
  transactionMock: vi.fn(),
  clientQuery: vi.fn(),
}));
vi.mock('../../db/pg-repo.js', () => ({ transaction: transactionMock }));

import { reconcileProjectAgentCareer, reconcileSessionProjectAgentCareer } from './agent-career-promotion.js';

beforeEach(() => {
  clientQuery.mockReset();
  transactionMock.mockReset().mockImplementation(async (fn) => fn({ query: clientQuery }));
});

describe('Agent career promotion reconciliation', () => {
  it('promotes an eligible intern once and records each crossed stage', async () => {
    clientQuery
      .mockResolvedValueOnce({ rows: [{ career_level: 'intern' }] })
      .mockResolvedValueOnce({ rows: [{ completed_workstreams: 10, successful_skill_invocations: 0 }] })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 });

    await expect(reconcileProjectAgentCareer('project-1')).resolves.toEqual({
      projectId: 'project-1', from: 'intern', to: 'manager',
      metrics: { completedWorkstreams: 10, successfulSkillInvocations: 0 }, promoted: true,
    });
    expect(clientQuery.mock.calls[0][0]).toContain('FOR UPDATE');
    expect(clientQuery.mock.calls[2][0]).toContain('instruction_version=instruction_version+1');
    expect(clientQuery.mock.calls.filter(([sql]) => String(sql).includes('INSERT INTO project_agent_promotions'))).toHaveLength(2);
  });

  it('does nothing when the stored level already matches the metrics', async () => {
    clientQuery
      .mockResolvedValueOnce({ rows: [{ career_level: 'practitioner' }] })
      .mockResolvedValueOnce({ rows: [{ completed_workstreams: 3, successful_skill_invocations: 0 }] });

    await expect(reconcileProjectAgentCareer('project-1')).resolves.toMatchObject({
      from: 'practitioner', to: 'practitioner', promoted: false,
    });
    expect(clientQuery).toHaveBeenCalledTimes(2);
  });

  it('resolves a Session Project before reconciling', async () => {
    clientQuery
      .mockResolvedValueOnce({ rows: [{ project_id: 'project-1' }] })
      .mockResolvedValueOnce({ rows: [{ career_level: 'intern' }] })
      .mockResolvedValueOnce({ rows: [{ completed_workstreams: 0, successful_skill_invocations: 0 }] });

    await expect(reconcileSessionProjectAgentCareer('session-1')).resolves.toMatchObject({ projectId: 'project-1', promoted: false });
    expect(clientQuery.mock.calls[0]).toEqual(['SELECT project_id FROM sessions WHERE id=$1', ['session-1']]);
  });
});

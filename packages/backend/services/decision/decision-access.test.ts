import { beforeEach, describe, expect, it, vi } from 'vitest';

const requireCurrentAgentExecutionAccess = vi.fn();
const requireBoundDecisionSpec = vi.fn();
vi.mock('../authority/agent-execution-access.js', () => ({ requireCurrentAgentExecutionAccess }));
vi.mock('./decision-spec-repository.js', () => ({ requireBoundDecisionSpec }));

const { requireDecisionSpecAccess } = await import('./decision-access.js');
const { TOWER_REQUEST_ROUTING_SPEC } = await import('./examples.js');

const input = { projectId: 'project-a', userId: 7, principal: { type: 'agent' as const, id: 'agent-a' }, specId: 'tower.request-routing', specRevision: 1 };

describe('DecisionSpec access gate', () => {
  beforeEach(() => { requireCurrentAgentExecutionAccess.mockReset(); requireBoundDecisionSpec.mockReset(); });

  it('checks current Project execution authority before binding', async () => {
    requireCurrentAgentExecutionAccess.mockResolvedValue({ projectMember: true });
    requireBoundDecisionSpec.mockResolvedValue(TOWER_REQUEST_ROUTING_SPEC);
    await expect(requireDecisionSpecAccess(input)).resolves.toMatchObject({ id: 'tower.request-routing', revision: 1 });
    expect(requireCurrentAgentExecutionAccess).toHaveBeenCalledWith({ projectId: 'project-a', userId: 7 });
    expect(requireCurrentAgentExecutionAccess.mock.invocationCallOrder[0]).toBeLessThan(requireBoundDecisionSpec.mock.invocationCallOrder[0]);
  });

  it('does not inspect bindings when current execution authority is denied', async () => {
    requireCurrentAgentExecutionAccess.mockRejectedValue(new Error('AGENT_EXECUTION_ACCESS_DENIED'));
    await expect(requireDecisionSpecAccess(input)).rejects.toThrow('AGENT_EXECUTION_ACCESS_DENIED');
    expect(requireBoundDecisionSpec).not.toHaveBeenCalled();
  });
});

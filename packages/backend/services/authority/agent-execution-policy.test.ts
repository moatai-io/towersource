import { describe, expect, it } from 'vitest';
import { resolveProjectAgentExecutionIdentity } from './agent-execution-policy.js';

const context = { projectId: 'agent-a', userId: 7, sessionId: 'session-a' };

describe('Agent execution identity', () => {
  it.each(['member', 'operator', 'admin'])('does not inherit %s execution scope', userRole => {
    const input = { ...context, userRole, superuser: true };
    expect(resolveProjectAgentExecutionIdentity(input)).toEqual({
      policyId: 'tower.agent-execution.authority.v1',
      principal: { kind: 'agent', projectId: 'agent-a' },
      requester: { userId: 7, sessionId: 'session-a' },
      scope: 'project',
    });
  });

  it('keeps attribution distinct when a different requester uses the same Agent', () => {
    const first = resolveProjectAgentExecutionIdentity(context);
    const second = resolveProjectAgentExecutionIdentity({ ...context, userId: 8, sessionId: 'session-b' });
    expect(first.principal).toEqual(second.principal);
    expect(first.scope).toEqual(second.scope);
    expect(first.requester).not.toEqual(second.requester);
  });

  it.each([
    { projectId: '' }, { projectId: ' ' }, { userId: 0 }, { userId: -1 },
    { userId: NaN }, { userId: 1.5 }, { sessionId: '' },
  ])('rejects incomplete server attribution %j', invalid => {
    expect(() => resolveProjectAgentExecutionIdentity({ ...context, ...invalid })).toThrow('AGENT_EXECUTION_IDENTITY_INVALID');
  });
});

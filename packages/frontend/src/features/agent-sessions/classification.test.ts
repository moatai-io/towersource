import { describe, expect, it } from 'vitest';
import { getSessionPresentationKind, isPureAgentSession, isTaskRunSession } from './classification';

const base = {
  id: 'session-1',
  name: 'Session',
} as any;

describe('session presentation classification', () => {
  it('keeps chats, agent backing sessions, and task runs mutually exclusive', () => {
    expect(getSessionPresentationKind(base)).toBe('chat');
    expect(getSessionPresentationKind({ ...base, label: 'agent' })).toBe('agent');
    expect(getSessionPresentationKind({ ...base, label: 'task' })).toBe('run');
    expect(getSessionPresentationKind({ ...base, kind: 'deployment', label: '배포 세션' })).toBe('deployment');
  });

  it('uses persisted label identity instead of session-name heuristics', () => {
    const legacyNamedOnly = { ...base, name: '[task] looks like a run' };
    expect(isTaskRunSession(legacyNamedOnly)).toBe(false);
    expect(getSessionPresentationKind(legacyNamedOnly)).toBe('chat');
  });

  it('preserves agent identity when an agent-backed row has another legacy label', () => {
    const backedAgent = { ...base, label: 'task', agent: { workerId: 'worker-1' } };
    expect(isPureAgentSession(backedAgent)).toBe(true);
    expect(getSessionPresentationKind(backedAgent)).toBe('agent');
  });
});

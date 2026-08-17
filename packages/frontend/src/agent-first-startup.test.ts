import { describe, expect, it } from 'vitest';
import { decideAgentFirstStartup } from './agent-first-startup';

const helper = { id: 'helper', name: 'Tower 도우미', systemKey: 'ai-talent-team' } as any;

describe('decideAgentFirstStartup', () => {
  it('opens the teammate creator directly for an enabled first-time user', () => {
    expect(decideAgentFirstStartup({ agentFirstEnabled: true, sessions: [], projects: [helper] }))
      .toEqual({ kind: 'open-agent-creator', project: helper });
  });

  it('never redirects an existing user', () => {
    expect(decideAgentFirstStartup({ agentFirstEnabled: true, sessions: [{ id: 'existing' } as any], projects: [helper] }))
      .toEqual({ kind: 'none' });
  });

  it('does nothing when disabled or the stable system context is unavailable', () => {
    expect(decideAgentFirstStartup({ agentFirstEnabled: false, sessions: [], projects: [helper] })).toEqual({ kind: 'none' });
    expect(decideAgentFirstStartup({ agentFirstEnabled: true, sessions: [], projects: [] })).toEqual({ kind: 'none' });
  });
});

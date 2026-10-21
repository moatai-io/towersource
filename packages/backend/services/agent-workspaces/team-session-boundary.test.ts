import { expect, it } from 'vitest';
import { listTeamWorkspaceIds } from './team-workspace-policy.js';
import { authorizeTowerAction } from '../authority/authorization-policy.js';

/** Composition contract: team file inventory is not Project/Session membership.
 * No HTTP or DB wiring is claimed by these pure-policy tests.
 */
it.each(['admin', 'operator', 'member'])('keeps team file access separate from another user Session for %s', role => {
  expect(listTeamWorkspaceIds({
    currentUser: { active: true, role },
    teamMemberships: [{ teamId: 'sales', active: true }],
    agent: { active: true, teamId: 'sales' },
    workspaces: [{ workspaceId: 'proposal-files', teamId: 'sales', active: true, registered: true }],
  })).toEqual(['proposal-files']);
  for (const sessionPrivate of [true, false]) {
    for (const action of ['read', 'inspect', 'send', 'write', 'execute', 'admin'] as const) {
      expect(authorizeTowerAction({ role, resource: 'session', action,
        facts: { sessionPrivate, sessionProjectShared: !sessionPrivate },
      }).allowed).toBe(false);
    }
  }
});
it('preserves separately established existing Project audience without opening private Sessions', () => {
  const facts = { projectMember: true, sessionProjectShared: true };
  expect(authorizeTowerAction({ role: 'member', resource: 'session', action: 'read', facts }).allowed).toBe(true);
  expect(authorizeTowerAction({ role: 'member', resource: 'session', action: 'read', facts: { ...facts, sessionPrivate: true } }).allowed).toBe(false);
});

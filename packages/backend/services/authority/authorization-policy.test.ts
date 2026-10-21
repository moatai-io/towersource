import { describe, expect, it } from 'vitest';
import {
  AUTHORIZATION_POLICY_ID,
  TOWER_ROLES,
  authorizeTowerAction,
  isAdminOrOperatorRole,
  isReadOnlyRole,
} from './authorization-policy.js';

const decide = (
  role: string,
  resource: Parameters<typeof authorizeTowerAction>[0]['resource'],
  action: Parameters<typeof authorizeTowerAction>[0]['action'],
  facts: Parameters<typeof authorizeTowerAction>[0]['facts'] = {},
) => authorizeTowerAction({ role, resource, action, facts });

describe('canonical Tower authorization policy', () => {
  it('defines only the active five-role model', () => {
    expect(TOWER_ROLES).toEqual(['admin', 'operator', 'member', 'viewer', 'guest']);
    expect(isAdminOrOperatorRole('admin')).toBe(true);
    expect(isAdminOrOperatorRole('operator')).toBe(true);
    expect(isReadOnlyRole('viewer')).toBe(true);
    expect(isReadOnlyRole('guest')).toBe(true);
    expect(decide('customer_manager', 'project', 'read', { projectMember: true })).toMatchObject({
      allowed: false,
      reason: 'unknown_role',
    });
  });

  it.each([
    ['admin', true, false, true],
    ['operator', true, false, false],
    ['member', true, false, false],
    ['viewer', true, false, false],
    ['guest', true, false, false],
  ] as const)('locks the Project read/admin and Credential reveal matrix for %s', (role, projectRead, projectAdmin, credentialReveal) => {
    expect(decide(role, 'project', 'read', { projectMember: true }).allowed).toBe(projectRead);
    expect(decide(role, 'project', 'admin', { projectOwner: role === 'member' }).allowed).toBe(projectAdmin || role === 'member');
    expect(decide(role, 'credential', 'reveal', { resourceOwner: true }).allowed).toBe(credentialReveal);
  });

  it('preserves operational inspection without granting content access or execution', () => {
    expect(decide('operator', 'session', 'read').allowed).toBe(false);
    expect(decide('operator', 'session', 'read', { administratorParticipant: true }).allowed).toBe(false);
    expect(decide('operator', 'session', 'send').allowed).toBe(false);
    expect(decide('operator', 'worker', 'inspect').allowed).toBe(true);
    expect(decide('operator', 'worker', 'execute').allowed).toBe(false);
    expect(decide('operator', 'credential', 'inspect').allowed).toBe(true);
    expect(decide('operator', 'credential', 'reveal')).toMatchObject({ allowed: false, reason: 'credential_management_denied' });
    expect(decide('operator', 'credential', 'admin')).toMatchObject({ allowed: false, reason: 'credential_management_denied' });
    expect(decide('operator', 'system', 'write')).toMatchObject({ allowed: false, reason: 'operator_core_settings_boundary' });
    expect(decide('operator', 'system', 'admin')).toMatchObject({ allowed: false, reason: 'operator_core_settings_boundary' });
  });

  it('separates shared Session read from owner-only send and mutation', () => {
    const shared = { sharedRead: true, projectMember: true };
    expect(decide('member', 'session', 'read', shared).allowed).toBe(true);
    expect(decide('member', 'session', 'send', shared).allowed).toBe(false);
    expect(decide('member', 'session', 'write', shared).allowed).toBe(false);
    expect(decide('member', 'session', 'admin', shared).allowed).toBe(false);

    const owned = { resourceOwner: true };
    expect(decide('member', 'session', 'send', owned).allowed).toBe(true);
    expect(decide('member', 'session', 'write', owned).allowed).toBe(true);
    expect(decide('member', 'session', 'admin', owned).allowed).toBe(true);
  });

  it('allows scoped credential management and use without revealing values', () => {
    expect(decide('member', 'credential', 'admin', { scope: 'project', projectMember: true }).allowed).toBe(true);
    expect(decide('member', 'credential', 'execute', { projectMember: true, credentialAttached: true }).allowed).toBe(true);
    expect(decide('member', 'credential', 'execute', { projectMember: true, credentialAttached: false })).toMatchObject({
      allowed: false,
      reason: 'credential_grant_required',
    });
    expect(decide('member', 'credential', 'reveal', { resourceOwner: true }).allowed).toBe(false);
  });

  it('lets company managers manage only explicitly scoped company connections', () => {
    for (const scope of ['project', 'workspace'] as const) {
      for (const action of ['write', 'admin', 'reveal'] as const) {
        expect(decide('operator', 'credential', action, { scope }).allowed).toBe(true);
      }
    }
    expect(decide('operator', 'credential', 'reveal', { scope: 'personal' }).allowed).toBe(false);
    expect(decide('operator', 'credential', 'reveal', { scope: 'system' }).allowed).toBe(false);
  });

  it('allows project connection managers to reveal but respects read-only memberships', () => {
    expect(decide('member', 'credential', 'reveal', { scope: 'project', projectMember: true }).allowed).toBe(true);
    for (const action of ['write', 'admin', 'reveal', 'execute'] as const) {
      expect(decide('member', 'credential', action, { scope: 'project', projectMember: true, projectWritable: false, credentialAttached: true }).allowed).toBe(false);
    }
    expect(decide('member', 'file', 'write', { projectMember: true, projectWritable: false }).allowed).toBe(false);
  });

  it('keeps private audience distinct from company participation and shared read from control', () => {
    expect(decide('operator', 'session', 'read', { sessionPrivate: true, administratorParticipant: true, projectMember: true }).allowed).toBe(false);
    expect(decide('operator', 'session', 'read', { sessionPrivate: true, sharedRead: true }).allowed).toBe(false);
    expect(decide('operator', 'session', 'send', { sharedRead: true }).allowed).toBe(false);
    expect(decide('operator', 'session', 'send', { resourceOwner: true }).allowed).toBe(true);
  });

  it.each(['admin', 'operator', 'member', 'viewer', 'guest'])('does not use %s as a content bypass', (role) => {
    for (const resource of ['project', 'session', 'file'] as const) {
      expect(decide(role, resource, 'read').allowed).toBe(false);
      expect(decide(role, resource, 'write').allowed).toBe(false);
    }
    expect(decide(role, 'session', 'read', { sessionPrivate: true, sharedRead: true, projectMember: true }).allowed).toBe(false);
    expect(decide(role, 'session', 'read', { administratorParticipant: true }).allowed).toBe(false);
    expect(decide(role, 'session', 'read', { sessionPrivate: true, resourceOwner: true }).allowed).toBe(true);
    expect(decide(role, 'session', 'read', { sharedRead: true }).allowed).toBe(false);
    expect(decide(role, 'session', 'read', { projectMember: true }).allowed).toBe(true);
    expect(decide(role, 'worker', 'execute', { projectOwner: true }).allowed).toBe(false);
    expect(decide(role, 'worker', 'execute', { projectMember: true }).allowed).toBe(!isReadOnlyRole(role));
  });

  it.each(['admin', 'operator', 'member'])('aligns %s project contribution with writable membership, not shared read', (role) => {
    expect(decide(role, 'session', 'send', { sharedRead: true }).allowed).toBe(false);
    expect(decide(role, 'session', 'send', { sessionProjectShared: true, projectMember: true }).allowed).toBe(true);
    expect(decide(role, 'session', 'send', { sessionProjectShared: true, projectMember: true, projectWritable: false }).allowed).toBe(false);
    expect(decide(role, 'session', 'admin', { sessionProjectShared: true, projectMember: true }).allowed).toBe(false);
  });

  it('returns explainable, auditable decision metadata', () => {
    expect(decide('operator', 'worker', 'execute')).toEqual({
      allowed: false,
      policyId: AUTHORIZATION_POLICY_ID,
      reason: 'project_write_required',
      requiredCapability: 'worker:execute',
      auditRequired: true,
    });
  });
});

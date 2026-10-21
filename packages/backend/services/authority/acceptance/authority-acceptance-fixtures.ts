import type { AuthorityAction, AuthorityFacts, AuthorityResource, TowerRole } from '../authorization-policy.js';

export interface AuthorityAcceptanceCase {
  name: string;
  role: TowerRole;
  resource: AuthorityResource;
  action: AuthorityAction;
  facts?: AuthorityFacts;
  allowed: boolean;
  reason: string;
}

/** User-visible role contract. Acceptance tests consume this instead of redefining expectations per subsystem. */
export const authorityAcceptanceCases: AuthorityAcceptanceCase[] = [
  { name: 'admin may reveal a Credential', role: 'admin', resource: 'credential', action: 'reveal', allowed: true, reason: 'admin_authority' },
  { name: 'operator may inspect Credentials', role: 'operator', resource: 'credential', action: 'inspect', allowed: true, reason: 'operator_operational_authority' },
  { name: 'operator may not reveal unclassified Credentials', role: 'operator', resource: 'credential', action: 'reveal', allowed: false, reason: 'credential_management_denied' },
  { name: 'operator may reveal company Credentials', role: 'operator', resource: 'credential', action: 'reveal', facts: { scope: 'workspace' }, allowed: true, reason: 'scoped_credential_management' },
  { name: 'operator may not send to another Session', role: 'operator', resource: 'session', action: 'send', allowed: false, reason: 'session_owner_required' },
  { name: 'member may send to an owned Session', role: 'member', resource: 'session', action: 'send', facts: { resourceOwner: true }, allowed: true, reason: 'session_owner_authority' },
  { name: 'member may read but not send to a shared Session', role: 'member', resource: 'session', action: 'send', facts: { sharedRead: true }, allowed: false, reason: 'session_owner_required' },
  { name: 'viewer member may read a shared Session', role: 'viewer', resource: 'session', action: 'read', facts: { sharedRead: true, projectMember: true }, allowed: true, reason: 'resource_readable' },
  { name: 'viewer may not execute Workbench', role: 'viewer', resource: 'worker', action: 'execute', facts: { projectMember: true }, allowed: false, reason: 'readonly_role' },
  { name: 'member may execute Workbench in a writable Project', role: 'member', resource: 'worker', action: 'execute', facts: { projectMember: true }, allowed: true, reason: 'project_worker_execution' },
  { name: 'member may use an attached Project Credential', role: 'member', resource: 'credential', action: 'execute', facts: { projectMember: true, credentialAttached: true }, allowed: true, reason: 'attached_credential_use' },
  { name: 'member may not use an unattached Credential', role: 'member', resource: 'credential', action: 'execute', facts: { projectMember: true, credentialAttached: false }, allowed: false, reason: 'credential_grant_required' },
  { name: 'guest may not mutate a Session', role: 'guest', resource: 'session', action: 'write', facts: { sharedRead: true }, allowed: false, reason: 'session_owner_required' },
];

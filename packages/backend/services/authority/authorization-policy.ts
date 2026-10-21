/**
 * Canonical Tower control-plane authorization vocabulary.
 *
 * This module is deliberately pure: callers load resource facts, then ask for a
 * decision. Runtime Box and Worker code must consume the narrowed decision or a
 * later authorization receipt instead of reinterpreting Tower roles.
 */

export const AUTHORIZATION_POLICY_ID = 'tower.control-plane.authorization.v1';

export const TOWER_ROLES = ['admin', 'operator', 'member', 'viewer', 'guest'] as const;
export type TowerRole = (typeof TOWER_ROLES)[number];

export type AuthorityResource = 'project' | 'session' | 'file' | 'credential' | 'worker' | 'system';
export type AuthorityAction = 'read' | 'inspect' | 'write' | 'send' | 'execute' | 'admin' | 'reveal';
export type AuthorityCapability = `${AuthorityResource}:${AuthorityAction}`;

export interface AuthorityFacts {
  /** Server-resolved; absent preserves ordinary Project execution. */
  executionScope?: 'project' | 'organization';
  projectMember?: boolean;
  /** Explicit read-only membership overrides the legacy membership write default. */
  projectWritable?: boolean;
  sessionPrivate?: boolean;
  /** Explicit project audience; absence must not grant contribution. */
  sessionProjectShared?: boolean;
  administratorParticipant?: boolean;
  projectOwner?: boolean;
  resourceOwner?: boolean;
  sharedRead?: boolean;
  credentialAttached?: boolean;
  scope?: 'personal' | 'project' | 'workspace' | 'system';
}

export interface AuthorityRequest {
  role: string | null | undefined;
  resource: AuthorityResource;
  action: AuthorityAction;
  facts?: AuthorityFacts;
}

export interface AuthorityResult {
  allowed: boolean;
  policyId: typeof AUTHORIZATION_POLICY_ID;
  reason: string;
  requiredCapability: AuthorityCapability;
  auditRequired: boolean;
}

export function isTowerRole(role: string | null | undefined): role is TowerRole {
  return TOWER_ROLES.includes(role as TowerRole);
}

export function isAdminRole(role: string | null | undefined): role is 'admin' {
  return role === 'admin';
}

export function isAdminOrOperatorRole(role: string | null | undefined): role is 'admin' | 'operator' {
  return role === 'admin' || role === 'operator';
}

export function isReadOnlyRole(role: string | null | undefined): role is 'viewer' | 'guest' {
  return role === 'viewer' || role === 'guest';
}

function result(input: AuthorityRequest, allowed: boolean, reason: string): AuthorityResult {
  const capability: AuthorityCapability = `${input.resource}:${input.action}`;
  const auditRequired = input.action === 'admin'
    || input.action === 'reveal'
    || input.action === 'execute'
    || input.action === 'send'
    || input.action === 'write';
  return { allowed, policyId: AUTHORIZATION_POLICY_ID, reason, requiredCapability: capability, auditRequired };
}

/**
 * Evaluate the stable role/resource/action contract after the caller has loaded
 * ownership, membership, sharing, and scope facts.
 */
export function authorizeTowerAction(input: AuthorityRequest): AuthorityResult {
  const facts = input.facts ?? {};
  if (!isTowerRole(input.role)) return result(input, false, 'unknown_role');
  if (input.role === 'admin' && (input.resource === 'system' || input.resource === 'credential'
    || (input.resource === 'worker' && input.action !== 'execute'))) {
    return result(input, true, 'admin_authority');
  }

  // Session audience is independent of company-wide management. A shared
  // transcript never grants control of someone else's conversation.
  if (input.resource === 'session') {
    if (input.action === 'read' || input.action === 'inspect') {
      const allowed = facts.resourceOwner === true || (facts.sessionPrivate !== true
        && facts.projectMember === true);
      return result(input, allowed, allowed ? 'resource_readable' : 'session_audience_required');
    }
    if (['send', 'write', 'admin', 'execute'].includes(input.action)) {
      const owner = facts.resourceOwner === true;
      const contributor = input.action !== 'admin' && facts.sessionPrivate !== true
        && facts.sessionProjectShared === true && facts.projectMember === true
        && facts.projectWritable !== false;
      const allowed = !isReadOnlyRole(input.role) && (owner || contributor);
      return result(input, allowed, allowed
        ? (owner ? 'session_owner_authority' : 'project_session_contribution') : 'session_owner_required');
    }
  }

  if (input.resource === 'credential') {
    const projectWriter = (facts.projectOwner === true || facts.projectMember === true)
      && facts.projectWritable !== false && !isReadOnlyRole(input.role);
    const personalOwner = facts.scope === 'personal' && facts.resourceOwner === true;
    const companyManager = input.role === 'operator'
      && (facts.scope === 'project' || facts.scope === 'workspace');
    if (['write', 'admin', 'reveal'].includes(input.action)) {
      const allowed = !isReadOnlyRole(input.role) && (companyManager || personalOwner
        || (facts.scope === 'project' && projectWriter));
      return result(input, allowed, allowed ? 'scoped_credential_management' : 'credential_management_denied');
    }
    if (input.action === 'execute') {
      const allowed = facts.credentialAttached === true && (projectWriter || companyManager || personalOwner)
        && !isReadOnlyRole(input.role);
      return result(input, allowed, allowed ? 'attached_credential_use' : 'credential_grant_required');
    }
    if (facts.scope === 'personal' || facts.scope === 'system') {
      return result(input, personalOwner, personalOwner ? 'resource_readable' : 'credential_scope_denied');
    }
  }

  if (input.role === 'operator' && (input.resource === 'system' || input.resource === 'credential'
    || (input.resource === 'worker' && input.action !== 'execute'))) {
    if (input.resource === 'system' && (input.action === 'write' || input.action === 'admin' || input.action === 'reveal')) {
      return result(input, false, 'operator_core_settings_boundary');
    }
    return result(input, true, 'operator_operational_authority');
  }

  const readable = facts.resourceOwner === true
    || facts.projectOwner === true
    || facts.projectMember === true
    || facts.sharedRead === true;
  const writableMember = !isReadOnlyRole(input.role) && facts.projectWritable !== false
    && (facts.resourceOwner === true || facts.projectOwner === true || facts.projectMember === true);

  if (input.action === 'read' || input.action === 'inspect') {
    if (input.resource === 'system' || input.resource === 'worker') {
      return result(input, false, 'workspace_operational_role_required');
    }
    return result(input, readable, readable ? 'resource_readable' : 'resource_not_accessible');
  }

  if (isReadOnlyRole(input.role)) return result(input, false, 'readonly_role');

  switch (input.resource) {
    case 'project':
    case 'file':
      if (input.action === 'write') return result(input, writableMember, writableMember ? 'project_write_access' : 'project_write_denied');
      if (input.action === 'admin') return result(input, facts.projectOwner === true, facts.projectOwner ? 'project_owner_authority' : 'project_owner_required');
      break;

    case 'session':
      if (input.action === 'send' || input.action === 'write' || input.action === 'admin') {
        return result(input, facts.resourceOwner === true, facts.resourceOwner ? 'session_owner_authority' : 'session_owner_required');
      }
      break;


    case 'worker':
      if (input.action === 'execute') {
        if (facts.executionScope !== undefined && !['project', 'organization'].includes(facts.executionScope)) {
          return result(input, false, 'execution_scope_invalid');
        }
        if (facts.executionScope === 'organization') {
          return result(input, false, 'execution_scope_unsupported');
        }
        const executableMember = facts.projectMember === true && facts.projectWritable !== false;
        return result(input, executableMember, executableMember ? 'project_worker_execution' : 'project_write_required');
      }
      if (input.action === 'admin') {
        return result(input, facts.projectOwner === true, facts.projectOwner ? 'project_owner_authority' : 'project_owner_required');
      }
      break;

    case 'system':
      return result(input, false, 'admin_or_operator_required');
  }

  return result(input, false, 'action_not_supported_for_resource');
}

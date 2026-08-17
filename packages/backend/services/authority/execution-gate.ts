/**
 * Owns: project-context execution policy decisions for Runbox/operator workflows.
 * Public API: evaluateExecutionGate, isHighImpactExecutionAction.
 * See README.md and workspace decisions linked there.
 */

export type ExecutionRole =
  | 'admin'
  | 'operator'
  | 'customer_manager'
  | 'member'
  | 'viewer'
  | 'guest'
  | string;

export type ExecutionTrustLevel = 'normal' | 'ops' | 'restricted';

export type ExecutionActionClass =
  | 'read'
  | 'write'
  | 'install-tool'
  | 'credential-use'
  | 'credential-admin'
  | 'secret-read'
  | 'cross-project'
  | 'self-hosted-server'
  | 'container'
  | 'deploy'
  | 'host-admin';

export type ExecutionSurface = 'host' | 'project-runbox' | 'operator-runbox' | 'backend';

export type ExecutionOperationKind =
  | 'status'
  | 'logs'
  | 'list'
  | 'inspect'
  | 'exec'
  | 'sync'
  | 'restart'
  | 'deploy'
  | 'delete'
  | 'write'
  | 'unknown';

export type ExecutionDecision = 'allow' | 'deny' | 'needs_setup' | 'needs_confirmation';

export interface ExecutionPolicy {
  /**
   * normal: ordinary project package; ops: intentionally trusted operational workbench;
   * restricted: execute observe-only/read actions unless elevated by admin/operator.
   */
  trustLevel?: ExecutionTrustLevel;
  /** Allow using project-provided credentials for external targets. */
  allowDirectCredentials?: boolean;
  /** Allow project actions that affect other projects or shared workspace areas. */
  allowCrossProject?: boolean;
  /** Allow self-hosted server operations when credentials/tools are present. */
  allowCustomerVmOps?: boolean;
  /** Allow container operations. Restart/exec still require confirmation by default. */
  allowContainerOps?: boolean;
  /** Allow deployment/release style actions from this project context. */
  allowDeploy?: boolean;
  /** Allow host/global admin actions from this project context. */
  allowHostAdmin?: boolean;
  /** Secret value reveal is intentionally stricter than secret use. Default: admin/operator only. */
  secretValueVisibility?: 'admin_only' | 'owner_admin' | 'project_members';
}

export interface ExecutionGateInput {
  userId?: number | null;
  userRole?: ExecutionRole | null;
  projectId?: string | null;
  projectMember?: boolean;
  projectRole?: 'owner' | 'member' | string | null;
  actionClass: ExecutionActionClass;
  target?: { type: string; id?: string; summary?: string; operation?: ExecutionOperationKind } | null;
  credentialAvailable?: boolean;
  credentialClass?: string | null;
  toolAvailable?: boolean;
  executionSurface?: ExecutionSurface;
  policy?: ExecutionPolicy | null;
  explicitConfirmation?: boolean;
  auditAvailable?: boolean;
}

export interface ExecutionGateResult {
  decision: ExecutionDecision;
  allowed: boolean;
  reason: string;
  requirements: string[];
  auditRequired: boolean;
  highImpact: boolean;
}

const HIGH_IMPACT_ACTIONS = new Set<ExecutionActionClass>([
  'credential-admin',
  'secret-read',
  'self-hosted-server',
  'container',
  'deploy',
  'host-admin',
]);

/** Returns true for action classes that should leave an audit trail and may need confirmation. */
export function isHighImpactExecutionAction(actionClass: ExecutionActionClass): boolean {
  return HIGH_IMPACT_ACTIONS.has(actionClass);
}

function isAdminOrOperator(role: ExecutionRole | null | undefined): boolean {
  return role === 'admin' || role === 'operator';
}

function isProjectParticipant(input: ExecutionGateInput): boolean {
  if (isAdminOrOperator(input.userRole)) return true;
  return input.projectMember === true || input.projectRole === 'owner' || input.projectRole === 'member';
}

function isObserveOnlyOperation(operation: ExecutionOperationKind | undefined): boolean {
  return operation === 'status' || operation === 'logs' || operation === 'list' || operation === 'inspect';
}

function allow(reason: string, requirements: string[] = [], highImpact = false): ExecutionGateResult {
  return { decision: 'allow', allowed: true, reason, requirements, auditRequired: highImpact, highImpact };
}

function deny(reason: string, requirements: string[] = [], highImpact = false): ExecutionGateResult {
  return { decision: 'deny', allowed: false, reason, requirements, auditRequired: highImpact, highImpact };
}

function needsSetup(reason: string, requirements: string[], highImpact = false): ExecutionGateResult {
  return { decision: 'needs_setup', allowed: false, reason, requirements, auditRequired: highImpact, highImpact };
}

function needsConfirmation(reason: string, requirements: string[], highImpact = true): ExecutionGateResult {
  return { decision: 'needs_confirmation', allowed: false, reason, requirements, auditRequired: true, highImpact };
}

/**
 * Evaluate the lightweight project execution policy.
 *
 * The default model is deliberately simple:
 * - project members may execute project-packaged read/write/install/credential-use actions;
 * - project owners/admins control membership and credential attachment outside this function;
 * - ops-level projects may run cross-project/customer/container/deploy actions when setup exists;
 * - secret value reveal and host-global mutation remain admin/operator-oriented.
 */
export function evaluateExecutionGate(input: ExecutionGateInput): ExecutionGateResult {
  const policy = input.policy ?? {};
  const trustLevel = policy.trustLevel ?? 'normal';
  const highImpact = isHighImpactExecutionAction(input.actionClass);

  if (!input.userId && !isAdminOrOperator(input.userRole)) {
    return deny('Authenticated user context is required', ['userId'], highImpact);
  }

  if (!isProjectParticipant(input)) {
    return deny('User is not a member of the project execution context', ['project_membership'], highImpact);
  }

  if (trustLevel === 'restricted' && !isAdminOrOperator(input.userRole) && input.actionClass !== 'read') {
    return deny('Restricted projects allow only read actions for non-admin users', ['admin_or_operator'], highImpact);
  }

  if (input.toolAvailable === false) {
    return needsSetup('Required tool is not available in this Runbox/project environment', ['install_or_select_runbox_profile'], highImpact);
  }

  switch (input.actionClass) {
    case 'read':
    case 'write':
    case 'install-tool':
      return allow('Project members may execute normal project-packaged actions', [], highImpact);

    case 'credential-use':
      if (input.credentialAvailable === false) {
        return needsSetup('Required credential is not available to this project execution context', ['credential_grant_or_direct_credential'], highImpact);
      }
      if (policy.allowDirectCredentials === false) {
        return deny('Direct credential use is disabled by this project policy', ['central_vault_grant_or_policy_change'], highImpact);
      }
      return allow('Project members may use credentials already attached to the project execution context', [], highImpact);

    case 'secret-read': {
      const visibility = policy.secretValueVisibility ?? 'admin_only';
      if (visibility === 'project_members') return allow('Project policy allows project members to reveal secret values', [], highImpact);
      if (visibility === 'owner_admin' && (input.projectRole === 'owner' || isAdminOrOperator(input.userRole))) {
        return allow('Project owner/admin may reveal secret values under project policy', [], highImpact);
      }
      if (isAdminOrOperator(input.userRole)) return allow('Admin/operator may reveal secret values when explicitly required', [], highImpact);
      return deny('Secret values are not visible to ordinary project members', ['admin_or_owner_secret_visibility'], highImpact);
    }

    case 'credential-admin':
      if (!isAdminOrOperator(input.userRole) && input.projectRole !== 'owner') {
        return deny('Credential grant/admin changes require project owner or admin/operator', ['project_owner_or_admin'], highImpact);
      }
      return allow('Project owner/admin may manage project credential attachment', [], highImpact);

    case 'cross-project':
      if (policy.allowCrossProject || trustLevel === 'ops' || isAdminOrOperator(input.userRole)) {
        return allow('Cross-project execution is permitted by policy or elevated role', [], highImpact);
      }
      return deny('Cross-project execution is not enabled for this project', ['allowCrossProject_or_ops_project'], highImpact);

    case 'self-hosted-server':
      if (input.credentialAvailable === false) {
        return needsSetup('Self-hosted server operation requires an attached/direct customer credential', ['customer_vm_credential'], highImpact);
      }
      if (!(policy.allowCustomerVmOps || trustLevel === 'ops' || isAdminOrOperator(input.userRole))) {
        return deny('Self-hosted server operations are not enabled for this project', ['allowCustomerVmOps_or_ops_project'], highImpact);
      }
      if (isObserveOnlyOperation(input.target?.operation)) {
        return allow('Self-hosted server observe-only operation allowed by project policy/elevated role', [], highImpact);
      }
      if (!input.explicitConfirmation) {
        return needsConfirmation('Self-hosted server operations are high impact and require explicit confirmation', ['explicit_confirmation'], highImpact);
      }
      return allow('Self-hosted server operation allowed by project policy and confirmation', [], highImpact);

    case 'container':
      if (!(policy.allowContainerOps || trustLevel === 'ops' || isAdminOrOperator(input.userRole))) {
        return deny('Container operations are not enabled for this project', ['allowContainerOps_or_ops_project'], highImpact);
      }
      if (isObserveOnlyOperation(input.target?.operation)) {
        return allow('Container observe-only operation allowed by project policy/elevated role', [], highImpact);
      }
      if (!input.explicitConfirmation) {
        return needsConfirmation('Container operations can affect shared runtime state and require explicit confirmation', ['explicit_confirmation'], highImpact);
      }
      return allow('Container operation allowed by project policy and confirmation', [], highImpact);

    case 'deploy':
      if (!(policy.allowDeploy || trustLevel === 'ops' || isAdminOrOperator(input.userRole))) {
        return deny('Deploy/release operations are not enabled for this project', ['allowDeploy_or_ops_project'], highImpact);
      }
      if (!input.explicitConfirmation) {
        return needsConfirmation('Deploy/release operations require explicit confirmation and preflight checks', ['explicit_confirmation', 'preflight_checks'], highImpact);
      }
      return allow('Deploy/release operation allowed by policy and confirmation', ['preflight_checks'], highImpact);

    case 'host-admin':
      if (!isAdminOrOperator(input.userRole) && !policy.allowHostAdmin) {
        return deny('Host/global admin actions require admin/operator or explicit project policy', ['admin_or_operator_or_allowHostAdmin'], highImpact);
      }
      if (!input.explicitConfirmation) {
        return needsConfirmation('Host/global admin actions require explicit confirmation', ['explicit_confirmation'], highImpact);
      }
      return allow('Host/global admin action allowed by elevated role/policy and confirmation', [], highImpact);

    default:
      return deny(`Unsupported project execution action class: ${input.actionClass}`, ['supported_action_class'], highImpact);
  }
}

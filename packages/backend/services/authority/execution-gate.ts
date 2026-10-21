import {
  AUTHORIZATION_POLICY_ID,
  authorizeTowerAction,
  type AuthorityCapability,
} from './authorization-policy.js';

/**
 * Owns: project-context execution policy decisions for Runbox/operator workflows.
 * Public API: evaluateExecutionGate, isHighImpactExecutionAction.
 * See README.md and workspace decisions linked there.
 */

export type ExecutionRole =
  | 'admin'
  | 'operator'
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
   * restricted: observe-only/read actions for every requester, including admin/operator.
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
  /** Trusted internal Runtime secret visibility. Deployed/restricted profiles must set admin_only or deny the capability entirely. */
  secretValueVisibility?: 'admin_only' | 'owner_admin' | 'project_members';
}

export interface ExecutionGateInput {
  userId?: number | null;
  userRole?: ExecutionRole | null;
  projectId?: string | null;
  projectMember?: boolean;
  /** Server-resolved write access; false must not be upgraded by membership. */
  projectWritable?: boolean;
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
  policyId: typeof AUTHORIZATION_POLICY_ID;
  reason: string;
  requiredCapability: AuthorityCapability;
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

function isObserveOnlyOperation(operation: ExecutionOperationKind | undefined): boolean {
  return operation === 'status' || operation === 'logs' || operation === 'list' || operation === 'inspect';
}

function executionCapability(actionClass: ExecutionActionClass): AuthorityCapability {
  if (actionClass === 'secret-read') return 'credential:reveal';
  if (actionClass === 'credential-admin') return 'credential:admin';
  if (actionClass === 'credential-use') return 'credential:execute';
  if (actionClass === 'read') return 'worker:read';
  if (actionClass === 'host-admin') return 'system:admin';
  return 'worker:execute';
}

function gateResult(
  decision: ExecutionDecision,
  allowed: boolean,
  actionClass: ExecutionActionClass,
  reason: string,
  requirements: string[],
  highImpact: boolean,
  auditRequired = highImpact,
): ExecutionGateResult {
  return {
    decision,
    allowed,
    policyId: AUTHORIZATION_POLICY_ID,
    reason,
    requiredCapability: executionCapability(actionClass),
    requirements,
    auditRequired,
    highImpact,
  };
}

function allow(actionClass: ExecutionActionClass, reason: string, requirements: string[] = [], highImpact = false): ExecutionGateResult {
  return gateResult('allow', true, actionClass, reason, requirements, highImpact);
}

function deny(actionClass: ExecutionActionClass, reason: string, requirements: string[] = [], highImpact = false): ExecutionGateResult {
  return gateResult('deny', false, actionClass, reason, requirements, highImpact);
}

function needsSetup(actionClass: ExecutionActionClass, reason: string, requirements: string[], highImpact = false): ExecutionGateResult {
  return gateResult('needs_setup', false, actionClass, reason, requirements, highImpact);
}

function needsConfirmation(actionClass: ExecutionActionClass, reason: string, requirements: string[], highImpact = true): ExecutionGateResult {
  return gateResult('needs_confirmation', false, actionClass, reason, requirements, highImpact, true);
}

/**
 * Evaluate the lightweight project execution policy.
 *
 * The default model is deliberately simple:
 * - project members may execute project-packaged read/write/install/credential-use actions;
 * - project owners/admins control membership and credential attachment outside this function;
 * - ops-level projects may run cross-project/customer/container/deploy actions when setup exists;
 * - trusted internal project members may reveal attached values; restricted/deployed profiles deny that capability.
 */
export function evaluateExecutionGate(input: ExecutionGateInput): ExecutionGateResult {
  const policy = input.policy ?? {};
  const trustLevel = policy.trustLevel ?? 'normal';
  const highImpact = isHighImpactExecutionAction(input.actionClass);

  if (!Number.isSafeInteger(input.userId) || Number(input.userId) <= 0) {
    return deny(input.actionClass, 'Authenticated user context is required', ['userId'], highImpact);
  }

  // Human role is used only at the entrance. A successful entrance never
  // adds cross-Project/host/deploy capabilities to the Agent policy below.
  const entrance = authorizeTowerAction({
    role: input.userRole,
    resource: input.actionClass === 'host-admin' ? 'system' : input.actionClass === 'read' ? 'project' : 'worker',
    action: input.actionClass === 'host-admin' ? 'admin' : input.actionClass === 'read' ? 'read' : 'execute',
    facts: {
      projectMember: input.projectMember === true || input.projectRole === 'member',
      projectOwner: input.projectRole === 'owner',
      projectWritable: input.projectWritable,
    },
  });
  const explicitOperatorHost = input.actionClass === 'host-admin' && input.userRole === 'operator'
    && policy.allowHostAdmin === true;
  if (!entrance.allowed && !explicitOperatorHost) {
    return deny(input.actionClass, 'User does not have access to the project execution context', [entrance.requiredCapability], highImpact);
  }

  if (trustLevel === 'restricted' && input.actionClass !== 'read') {
    return deny(input.actionClass, 'Restricted Agents allow only read actions for every requester', ['agent_execution_capability'], highImpact);
  }

  if (input.toolAvailable === false) {
    return needsSetup(input.actionClass, 'Required tool is not available in this Runbox/project environment', ['install_or_select_runbox_profile'], highImpact);
  }

  switch (input.actionClass) {
    case 'read':
    case 'write':
    case 'install-tool':
      return allow(input.actionClass, 'Project members may execute normal project-packaged actions', [], highImpact);

    case 'credential-use':
      if (input.credentialAvailable === false) {
        return needsSetup(input.actionClass, 'Required credential is not available to this project execution context', ['credential_grant_or_direct_credential'], highImpact);
      }
      if (policy.allowDirectCredentials === false) {
        return deny(input.actionClass, 'Direct credential use is disabled by this project policy', ['central_vault_grant_or_policy_change'], highImpact);
      }
      return allow(input.actionClass, 'Project members may use credentials already attached to the project execution context', [], highImpact);

    case 'secret-read': {
      if (trustLevel === 'restricted') {
        return deny(input.actionClass, 'Restricted or deployed Agents cannot reveal secret values', ['trusted_internal_runtime'], highImpact);
      }
      const visibility = policy.secretValueVisibility ?? 'project_members';
      if (input.auditAvailable === false) {
        return deny(input.actionClass, 'Credential reveal requires available audit persistence', ['audit_persistence'], highImpact);
      }
      if (visibility === 'project_members') {
        return allow(input.actionClass, 'Trusted internal Project members may reveal Credentials available to this Agent', [], highImpact);
      }
      // The explicit admin_only profile must not widen when shared credential
      // management policy permits operator/member reveal at the product layer.
      if (input.userRole === 'admin' || (visibility === 'owner_admin' && input.projectRole === 'owner')) {
        return allow(input.actionClass, 'Credential reveal is allowed by the configured trusted Runtime visibility', [], highImpact);
      }
      return deny(input.actionClass, 'Credential reveal is not allowed by this Runtime profile', ['credential_reveal_visibility'], highImpact);
    }

    case 'credential-admin': {
      const authority = authorizeTowerAction({
        role: input.userRole,
        resource: 'credential',
        action: 'admin',
        facts: {
          projectMember: input.projectMember === true || input.projectRole === 'member',
          projectWritable: input.projectWritable,
          projectOwner: input.projectRole === 'owner',
          scope: 'project',
        },
      });
      if (!authority.allowed) {
        return deny(input.actionClass, 'Credential administration requires scoped project management authority', [authority.requiredCapability], highImpact);
      }
      return allow(input.actionClass, 'Authorized project connection managers may manage project credential attachment', [], highImpact);
    }

    case 'cross-project':
      if (policy.allowCrossProject ?? trustLevel === 'ops') {
        return allow(input.actionClass, 'Cross-project execution is permitted by Agent policy', [], highImpact);
      }
      return deny(input.actionClass, 'Cross-project execution is not enabled for this project', ['allowCrossProject_or_ops_project'], highImpact);

    case 'self-hosted-server':
      if (input.credentialAvailable === false) {
        return needsSetup(input.actionClass, 'Self-hosted server operation requires an attached/direct customer credential', ['customer_vm_credential'], highImpact);
      }
      if (!(policy.allowCustomerVmOps ?? trustLevel === 'ops')) {
        return deny(input.actionClass, 'Self-hosted server operations are not enabled for this project', ['allowCustomerVmOps_or_ops_project'], highImpact);
      }
      if (isObserveOnlyOperation(input.target?.operation)) {
        return allow(input.actionClass, 'Self-hosted server observe-only operation allowed by Agent policy', [], highImpact);
      }
      if (!input.explicitConfirmation) {
        return needsConfirmation(input.actionClass, 'Self-hosted server operations are high impact and require explicit confirmation', ['explicit_confirmation'], highImpact);
      }
      return allow(input.actionClass, 'Self-hosted server operation allowed by project policy and confirmation', [], highImpact);

    case 'container':
      if (!(policy.allowContainerOps ?? trustLevel === 'ops')) {
        return deny(input.actionClass, 'Container operations are not enabled for this project', ['allowContainerOps_or_ops_project'], highImpact);
      }
      if (isObserveOnlyOperation(input.target?.operation)) {
        return allow(input.actionClass, 'Container observe-only operation allowed by Agent policy', [], highImpact);
      }
      if (!input.explicitConfirmation) {
        return needsConfirmation(input.actionClass, 'Container operations can affect shared runtime state and require explicit confirmation', ['explicit_confirmation'], highImpact);
      }
      return allow(input.actionClass, 'Container operation allowed by project policy and confirmation', [], highImpact);

    case 'deploy':
      if (!(policy.allowDeploy ?? trustLevel === 'ops')) {
        return deny(input.actionClass, 'Deploy/release operations are not enabled for this project', ['allowDeploy_or_ops_project'], highImpact);
      }
      if (!input.explicitConfirmation) {
        return needsConfirmation(input.actionClass, 'Deploy/release operations require explicit confirmation and preflight checks', ['explicit_confirmation', 'preflight_checks'], highImpact);
      }
      return allow(input.actionClass, 'Deploy/release operation allowed by policy and confirmation', ['preflight_checks'], highImpact);

    case 'host-admin': {
      if (policy.allowHostAdmin !== true) {
        return deny(input.actionClass, 'Host/global administration is not enabled for this Agent', ['allowHostAdmin'], highImpact);
      }
      if (!['admin', 'operator'].includes(input.userRole || '')) {
        return deny(input.actionClass, 'Host execution requires admin or operator', ['system:admin'], highImpact);
      }
      if (!input.explicitConfirmation) {
        return needsConfirmation(input.actionClass, 'Host/global admin actions require explicit confirmation', ['explicit_confirmation'], highImpact);
      }
      return allow(input.actionClass, 'Host/global admin action allowed by Agent capability, platform authority and confirmation', [], highImpact);
    }

    default:
      return deny(input.actionClass, `Unsupported project execution action class: ${input.actionClass}`, ['supported_action_class'], highImpact);
  }
}

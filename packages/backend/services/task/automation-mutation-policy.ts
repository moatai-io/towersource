/**
 * Owns: one server-side authorization/risk gate for automation create/update paths.
 * Public API: authorizeAutomationMutation(). Route handlers must not trust a
 * client-supplied riskLevel or let alternate mutation paths bypass creation policy.
 */
import type {
  Automation,
  AutomationJobType,
  AutomationRiskLevel,
  AutomationScopeType,
} from './automation-manager.js';
import { classifyJobRisk } from './job-risk.js';
import { canCreateAutomationJob, type PermissionResult } from './schedule-permissions.js';

export interface AutomationMutationActor {
  userId: number | undefined;
  role?: string | null;
}

export interface AutomationMutationInput {
  projectId?: string | null;
  jobType?: AutomationJobType | string | null;
  scopeType?: AutomationScopeType | string | null;
  definitionJson?: Record<string, unknown> | null;
  confirmedHighRisk?: boolean;
}

export interface AutomationMutationPolicyResult extends PermissionResult {
  projectId?: string | null;
  jobType?: AutomationJobType;
  scopeType?: AutomationScopeType;
  definitionJson?: Record<string, unknown>;
  riskLevel?: AutomationRiskLevel;
}

/**
 * Rebuild the effective execution definition, then apply the same permission and
 * high-risk confirmation policy for every mutation entry point.
 */
export async function authorizeAutomationMutation(params: {
  actor: AutomationMutationActor;
  existing?: Automation | null;
  mutation?: AutomationMutationInput | null;
}): Promise<AutomationMutationPolicyResult> {
  const mutation = params.mutation || {};
  const existing = params.existing || null;
  const projectId = mutation.projectId !== undefined
    ? mutation.projectId
    : existing?.projectId || null;
  const jobType = String(mutation.jobType ?? existing?.jobType ?? 'ai_prompt') as AutomationJobType;
  const scopeType = String(
    mutation.scopeType ?? existing?.scopeType ?? (projectId ? 'project' : 'system'),
  ) as AutomationScopeType;
  const definitionJson = mutation.definitionJson !== undefined
    ? (mutation.definitionJson || {})
    : (existing?.definitionJson || {});

  const access = await canCreateAutomationJob({
    userId: params.actor.userId,
    role: params.actor.role,
    projectId,
    jobType,
    scopeType,
    definitionJson,
  });
  if (!access.allowed) return access;

  // Always derive risk from the effective server-side definition. A caller may
  // not downgrade a dangerous command by submitting riskLevel="low".
  const riskLevel = classifyJobRisk(jobType, definitionJson);
  if (riskLevel === 'high' && !mutation.confirmedHighRisk) {
    return {
      allowed: false,
      status: 400,
      message: 'high risk schedule job requires confirmedHighRisk=true',
      projectId,
      jobType,
      scopeType,
      definitionJson,
      riskLevel,
    };
  }

  return {
    allowed: true,
    projectId,
    jobType,
    scopeType,
    definitionJson,
    riskLevel,
  };
}

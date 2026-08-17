/**
 * Owns: route-level permission decisions for Schedule/automation jobs.
 * Public API: canCreateAutomationJob(), canAccessAutomationJob(). See services/task/README.md.
 */
import { isProjectMember } from '../pm/project-membership-manager.js';
import { isRuntimeBoxEnabled } from '../runtime-box/policy.js';
import { getRunnerPolicy } from './runner-policy.js';
import type { Automation, AutomationJobType, AutomationScopeType } from './automation-manager.js';

export interface PermissionResult {
  allowed: boolean;
  status?: number;
  message?: string;
}

export type AutomationCapability = 'read' | 'propose' | 'run' | 'edit' | 'archive';

export function isScheduleOperator(role?: string | null): boolean {
  return role === 'admin' || role === 'operator';
}

/**
 * Capability access for an existing automation.
 *
 * Project membership grants visibility and the ability to draft proposals, not
 * operational control. Run/edit/archive stay with the automation owner or an
 * admin/operator until delegated automation operators are modeled explicitly.
 */
export async function canAccessAutomationJob(
  automation: Pick<Automation, 'userId' | 'projectId'>,
  userId: number | undefined,
  role?: string | null,
  capability: AutomationCapability = 'read',
): Promise<PermissionResult> {
  if (!userId) return { allowed: false, status: 401, message: 'unauthorized' };
  if (isScheduleOperator(role)) return { allowed: true };
  if (automation.userId === userId) return { allowed: true };

  const isMember = !!automation.projectId && await isProjectMember(automation.projectId, userId);
  if (isMember && (capability === 'read' || capability === 'propose')) return { allowed: true };

  return {
    allowed: false,
    status: 403,
    message: isMember
      ? `automation ${capability} requires the automation owner or an operator`
      : 'forbidden',
  };
}

/**
 * Creation policy for new Schedule jobs.
 * Host shell/script jobs remain admin/operator-only. Members may create shell/script
 * only for their project and only when the job explicitly runs in Runtime Box with
 * fail-closed fallback.
 */
export async function canCreateAutomationJob(params: {
  userId: number | undefined;
  role?: string | null;
  projectId?: string | null;
  jobType?: AutomationJobType | string | null;
  scopeType?: AutomationScopeType | string | null;
  definitionJson?: Record<string, unknown> | null;
}): Promise<PermissionResult> {
  const { userId, role, projectId, jobType, scopeType, definitionJson } = params;
  if (!userId) return { allowed: false, status: 401, message: 'unauthorized' };

  if (projectId && !isScheduleOperator(role) && !(await isProjectMember(projectId, userId))) {
    return { allowed: false, status: 403, message: 'Access denied: not a project member' };
  }

  if (jobType === 'workbench_execution') {
    if (!projectId || scopeType !== 'project') return { allowed: false, status: 403, message: 'Workbench execution schedules must be project-scoped' };
    if (!isRuntimeBoxEnabled()) return { allowed: false, status: 403, message: 'Runtime Box is not enabled for this server' };
    return { allowed: true };
  }

  if (jobType !== 'shell' && jobType !== 'script') return { allowed: true };
  if (isScheduleOperator(role)) return { allowed: true };

  if (!projectId || scopeType !== 'project') {
    return {
      allowed: false,
      status: 403,
      message: 'shell/script schedule jobs for members must be project-scoped Runtime Box jobs',
    };
  }

  const policy = getRunnerPolicy(definitionJson || {});
  if (policy.preference !== 'runtime_box' || policy.fallback !== 'fail') {
    return {
      allowed: false,
      status: 403,
      message: 'member shell/script schedule jobs require runner.preference="runtime_box" and fallback="fail"',
    };
  }

  if (!isRuntimeBoxEnabled()) {
    return {
      allowed: false,
      status: 403,
      message: 'Runtime Box is not enabled for this server',
    };
  }

  return { allowed: true };
}

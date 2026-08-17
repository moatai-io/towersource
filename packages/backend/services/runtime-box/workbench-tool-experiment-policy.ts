import { config } from '../../config.js';
import { isAdminOrOperator } from '../pm/project-access.js';
import { isCurrentRootTurnRecovering } from '../agent-turn/current-root-turn.js';

const UNIFIED_SHELL_ROLES = new Set(['admin', 'operator', 'member']);

export class WorkbenchToolExperimentAccessError extends Error {
  constructor(public readonly code: string, message: string) { super(message); }
}

export function assertExperimentalWorkbenchToolAccess(input: {
  projectId: string;
  role: string | undefined | null;
  sessionId?: string | null;
  /** DB rollout resolved by the async caller; env fallback preserves compatibility. */
  rolloutEnabled?: boolean;
}): void {
  if (!isAdminOrOperator(input.role)) {
    throw new WorkbenchToolExperimentAccessError('MUTATION_ROLE_REQUIRED', 'Experimental Workbench tools require admin or operator role');
  }
  if (!config.experimentalWorkbenchTools.enabled) {
    throw new WorkbenchToolExperimentAccessError('EXPERIMENT_DISABLED', 'Experimental Workbench tools are disabled');
  }
  const projectEnabled = input.rolloutEnabled
    ?? config.experimentalWorkbenchTools.projectIds.includes(input.projectId);
  if (!projectEnabled) {
    throw new WorkbenchToolExperimentAccessError('PROJECT_NOT_ALLOWLISTED', 'Project is not enabled for experimental Workbench tools');
  }
  if (input.sessionId && isCurrentRootTurnRecovering(input.sessionId)) {
    throw new WorkbenchToolExperimentAccessError('RECOVERY_EXECUTION_REFUSED', 'Experimental Workbench tools are unavailable during automatic recovery');
  }
}

/**
 * Allow ordinary Project work in explicitly allowlisted beta Projects without
 * granting persistent Workbench mutation or Runtime recovery authority.
 */
export function isExperimentalUnifiedShellVisible(input: {
  projectId: string;
  role: string | undefined | null;
  sessionId?: string | null;
  /** DB rollout resolved during async tool assembly; env fallback preserves direct callers/tests. */
  rolloutEnabled?: boolean;
}): boolean {
  if (!UNIFIED_SHELL_ROLES.has(input.role ?? '')) return false;
  if (!config.experimentalWorkbenchTools.enabled) return false;
  const projectEnabled = input.rolloutEnabled
    ?? config.experimentalWorkbenchTools.projectIds.includes(input.projectId);
  if (!projectEnabled) return false;
  if (input.sessionId && isCurrentRootTurnRecovering(input.sessionId)) return false;
  return true;
}

export function isExperimentalWorkbenchToolVisible(input: {
  projectId: string;
  role: string | undefined | null;
  sessionId?: string | null;
  rolloutEnabled?: boolean;
}): boolean {
  try { assertExperimentalWorkbenchToolAccess(input); return true; }
  catch { return false; }
}

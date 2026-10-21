import { getAutomation } from '../task/automation-manager.js';
import { canAccessAutomationJob } from '../task/schedule-permissions.js';
import { runAutomationNow } from '../task/automation-control.js';
import { getProjectMembershipIds } from '../pm/project-membership-manager.js';

/** Server-resolved binding only. Never construct from arbitrary app request fields. */
export interface DashboardRefreshBinding {
  publicationId: string;
  ownerProjectId: string;
  automationId: string;
}
export interface RefreshActor { userId: number; role: string }
export class DashboardRefreshError extends Error {
  constructor(public readonly code: 'forbidden' | 'unavailable' | 'confirmation_required') { super(code); }
}
/** Internal adapter, deliberately not exposed as an HTTP endpoint until trusted binding storage exists. */
export async function requestDashboardRefresh(binding: DashboardRefreshBinding, actor: RefreshActor, confirmed: boolean) {
  if (!confirmed) throw new DashboardRefreshError('confirmation_required');
  if (!binding.publicationId || !binding.ownerProjectId || !binding.automationId || !Number.isInteger(actor.userId) || actor.userId <= 0) throw new DashboardRefreshError('forbidden');
  const memberships = await getProjectMembershipIds(actor.userId);
  if (!memberships.includes(binding.ownerProjectId)) throw new DashboardRefreshError('forbidden');
  const automation = await getAutomation(binding.automationId);
  if (!automation || automation.projectId !== binding.ownerProjectId || automation.status === 'archived') throw new DashboardRefreshError('unavailable');
  const access = await canAccessAutomationJob(automation, actor.userId, actor.role, 'run');
  if (!access.allowed) throw new DashboardRefreshError('forbidden');
  const result = await runAutomationNow({ automation });
  // No stdout, credentials, internal errors or arbitrary result text in the viewer response.
  // Successful execution is NOT proof of a validated/fresh data snapshot.
  return { publicationId: binding.publicationId, automationId: binding.automationId, runId: result.runId, status: result.status };
}

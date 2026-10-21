/**
 * Compatibility boundary for historical Project compute settings and deployment bindings.
 * New Project Environment code must depend on this adapter, not on workbench-* modules.
 */
import {
  getProjectComputeDeploymentBinding,
  getProjectComputeSettings,
  type ProjectComputeSettings,
} from '../../runtime-box/workbench-project-compute-settings.js';

function missingTable(error: unknown, table: string): boolean {
  return error instanceof Error && error.message.includes(`relation "${table}" does not exist`);
}

export type LegacyProjectComputePlacement = ProjectComputeSettings;

/** Read the historical deployment-scoped placement without treating it as current authority. */
export async function readLegacyProjectComputePlacement(projectId: string, deploymentId: string): Promise<LegacyProjectComputePlacement | undefined> {
  const binding = await getProjectComputeDeploymentBinding(projectId, deploymentId).catch(error => {
    if (missingTable(error, 'project_compute_deployment_bindings')) return undefined;
    throw error;
  });
  if (binding !== undefined || deploymentId !== 'development') return binding;
  return getProjectComputeSettings(projectId).catch(error => {
    if (missingTable(error, 'project_compute_settings')) return undefined;
    throw error;
  });
}

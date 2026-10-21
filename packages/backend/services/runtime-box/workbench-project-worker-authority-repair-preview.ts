import { auditProjectWorkerAuthority, type ProjectWorkerAuthorityFinding } from './workbench-project-worker-authority-audit.js';

export interface ProjectWorkerAuthorityRepairPreview {
  projectId: string;
  projectName: string;
  disposition: 'safe_host_fallback' | 'manual_review' | 'no_action';
  proposedChanges: string[];
  reasons: string[];
}

/**
 * Build a non-mutating repair preview. Worker-to-Worker alignment is never
 * proposed without independently verified manifests because it may hide files.
 */
export function previewProjectWorkerAuthorityRepair(
  finding: ProjectWorkerAuthorityFinding,
): ProjectWorkerAuthorityRepairPreview {
  if (finding.problems.includes('file_authority_scope_missing') || finding.problems.includes('file_authority_worker_missing')) {
    return {
      projectId: finding.projectId,
      projectName: finding.projectName,
      disposition: 'safe_host_fallback',
      proposedChanges: ['set project_compute_settings.workstation_mode=false', 'preserve project_compute_settings.default_worker_id for audit'],
      reasons: ['Worker file authority cannot serve this Project', 'host Project root remains the non-destructive fallback'],
    };
  }
  if (finding.problems.includes('settings_binding_worker_mismatch')) {
    return {
      projectId: finding.projectId,
      projectName: finding.projectName,
      disposition: 'manual_review',
      proposedChanges: ['consider disabling legacy file authority after host/Worker manifest comparison'],
      reasons: ['file authority and execution binding target different Workers', 'automatic Worker alignment could hide divergent files'],
    };
  }
  return {
    projectId: finding.projectId,
    projectName: finding.projectName,
    disposition: 'no_action',
    proposedChanges: [],
    reasons: ['warning-only desired-state or rollout drift requires control-plane reconciliation, not file authority mutation'],
  };
}

export async function previewProjectWorkerAuthorityRepairs(deploymentId = 'production'): Promise<ProjectWorkerAuthorityRepairPreview[]> {
  return (await auditProjectWorkerAuthority(deploymentId)).map(previewProjectWorkerAuthorityRepair);
}

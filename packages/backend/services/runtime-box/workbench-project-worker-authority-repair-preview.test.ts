import { describe, expect, it } from 'vitest';
import { previewProjectWorkerAuthorityRepair } from './workbench-project-worker-authority-repair-preview.js';
import type { ProjectWorkerAuthorityFinding } from './workbench-project-worker-authority-audit.js';

const base: ProjectWorkerAuthorityFinding = {
  projectId: 'project-a', projectName: 'Project A', rootPath: '/workspace/project-a', severity: 'critical',
  problems: ['file_authority_scope_missing'],
  state: {
    settingsWorkerId: 'worker-a', fileAuthorityEnabled: true,
    bindingWorkerId: 'worker-a', executionBindingEnabled: true,
    workerProjectScope: false, rolloutStatus: 'enabled', desireWorkerId: 'worker-a', desireStatus: 'active',
  },
};

describe('Project Worker authority repair preview', () => {
  it('offers host fallback when Worker file authority is impossible', () => {
    expect(previewProjectWorkerAuthorityRepair(base)).toMatchObject({
      disposition: 'safe_host_fallback',
      proposedChanges: ['set project_compute_settings.workstation_mode=false', 'preserve project_compute_settings.default_worker_id for audit'],
    });
  });

  it('requires manual review for different file and execution Workers', () => {
    expect(previewProjectWorkerAuthorityRepair({ ...base, problems: ['settings_binding_worker_mismatch'] })).toMatchObject({
      disposition: 'manual_review',
    });
  });

  it('does not mutate file authority for warning-only desired-state drift', () => {
    expect(previewProjectWorkerAuthorityRepair({
      ...base, severity: 'warning', problems: ['active_desire_worker_mismatch'],
    })).toMatchObject({ disposition: 'no_action', proposedChanges: [] });
  });
});

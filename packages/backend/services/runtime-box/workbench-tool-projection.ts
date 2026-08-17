import path from 'node:path';
import { execute, queryOne } from '../../db/pg-repo.js';
import { config } from '../../config.js';
import { readAndVerifyManagedWorkbenchToolRevision, WorkbenchToolStoreError } from './workbench-tool-store.js';

export const WORKBENCH_TOOL_PROJECTION_TARGET = '/workspace/.runtime-box/workbench-tools/active';

interface ActiveManagedRevisionRow {
  current_revision: number | string | null;
  health: 'healthy' | 'degraded' | 'recovery_required';
  storage_mode: 'project-prefix' | 'tower-managed-v1';
  state: string | null;
  storage_kind: 'project-prefix' | 'tower-managed-v1' | null;
  store_ref: string | null;
  store_manifest_hash: string | null;
  manifest_hash: string | null;
}

export interface WorkbenchToolProjectionPlan {
  enabled: boolean;
  projectId: string;
  revision: number | null;
  manifestHash: string | null;
  storeRef: string | null;
  sourcePath?: string;
  targetPath: typeof WORKBENCH_TOOL_PROJECTION_TARGET;
  reason: 'experiment_disabled' | 'project_not_allowlisted' | 'uninitialized' | 'managed_revision_ready';
}

export class WorkbenchToolProjectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorkbenchToolProjectionError';
  }
}

export function runtimeWorkbenchToolDockerMountArgs(plan: WorkbenchToolProjectionPlan): string[] {
  if (!plan.enabled || !plan.sourcePath) return [];
  const sourcePath = path.resolve(plan.sourcePath);
  if (sourcePath.includes(',') || plan.targetPath.includes(',')) {
    throw new WorkbenchToolProjectionError('Workbench projection path is not Docker mount safe');
  }
  return [
    '--mount',
    `type=bind,src=${sourcePath},dst=${plan.targetPath},readonly,bind-propagation=rprivate`,
  ];
}

export async function buildWorkbenchToolProjectionPlan(projectId: string): Promise<WorkbenchToolProjectionPlan> {
  const base = {
    enabled: false,
    projectId,
    revision: null,
    manifestHash: null,
    storeRef: null,
    targetPath: WORKBENCH_TOOL_PROJECTION_TARGET,
  } as const;
  if (!config.experimentalWorkbenchTools.enabled) return { ...base, reason: 'experiment_disabled' };
  if (!config.experimentalWorkbenchTools.projectIds.includes(projectId)) return { ...base, reason: 'project_not_allowlisted' };

  const row = await queryOne<ActiveManagedRevisionRow>(
    `SELECT s.current_revision,s.health,s.storage_mode,
            r.state,r.storage_kind,r.store_ref,r.store_manifest_hash,r.manifest_hash
       FROM runtime_box_workbench_tool_states s
       LEFT JOIN runtime_box_workbench_tool_revisions r
         ON r.project_id=s.project_id AND r.revision=s.current_revision
      WHERE s.project_id=$1`,
    [projectId],
  );
  if (!row || row.current_revision == null) return { ...base, reason: 'uninitialized' };
  const revision = Number(row.current_revision);
  if (row.health !== 'healthy') throw new WorkbenchToolProjectionError(`Workbench state is ${row.health}`);
  if (row.state !== 'active' && row.state !== 'rollback') throw new WorkbenchToolProjectionError('Workbench current revision is not active');
  if (row.storage_mode !== 'tower-managed-v1' || row.storage_kind !== 'tower-managed-v1') {
    throw new WorkbenchToolProjectionError('Workbench current revision is not stored in the Tower-managed store');
  }
  if (!row.store_ref || !row.store_manifest_hash || row.store_manifest_hash !== row.manifest_hash) {
    throw new WorkbenchToolProjectionError('Workbench managed store metadata is incomplete or divergent');
  }
  try {
    const verified = readAndVerifyManagedWorkbenchToolRevision({
      projectId,
      revision,
      storeRef: row.store_ref,
      expectedManifestHash: row.store_manifest_hash,
    });
    return {
      enabled: true,
      projectId,
      revision,
      manifestHash: row.store_manifest_hash,
      storeRef: row.store_ref,
      sourcePath: verified.revisionPath,
      targetPath: WORKBENCH_TOOL_PROJECTION_TARGET,
      reason: 'managed_revision_ready',
    };
  } catch (error) {
    if (error instanceof WorkbenchToolStoreError) throw new WorkbenchToolProjectionError(error.message);
    throw error;
  }
}

export async function recordWorkbenchToolProjection(input: {
  boxId: number;
  plan: WorkbenchToolProjectionPlan;
}): Promise<void> {
  if (!input.plan.enabled || input.plan.revision == null || !input.plan.manifestHash || !input.plan.storeRef) return;
  await execute(
    `INSERT INTO runtime_box_workbench_tool_projections
       (box_id,project_id,revision,manifest_hash,store_ref,status,mounted_at,verified_at,updated_at)
     VALUES($1,$2,$3,$4,$5,'mounted',NOW(),NOW(),NOW())
     ON CONFLICT(box_id) DO UPDATE SET
       project_id=EXCLUDED.project_id,revision=EXCLUDED.revision,
       manifest_hash=EXCLUDED.manifest_hash,store_ref=EXCLUDED.store_ref,
       status='mounted',mounted_at=NOW(),verified_at=NOW(),updated_at=NOW()`,
    [input.boxId, input.plan.projectId, input.plan.revision, input.plan.manifestHash, input.plan.storeRef],
  );
}

export async function markWorkbenchToolProjectionUnmounted(boxId: number): Promise<void> {
  await execute(
    `UPDATE runtime_box_workbench_tool_projections
        SET status='unmounted',updated_at=NOW()
      WHERE box_id=$1 AND status <> 'recovery_required'`,
    [boxId],
  );
}

export async function markWorkbenchToolProjectionRecoveryRequired(boxId: number): Promise<void> {
  await execute(
    `UPDATE runtime_box_workbench_tool_projections
        SET status='recovery_required',updated_at=NOW()
      WHERE box_id=$1`,
    [boxId],
  );
}

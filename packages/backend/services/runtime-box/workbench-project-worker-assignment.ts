/**
 * Owns: restart-safe desired state for automatic sticky Project→Worker assignment.
 * Public API: request, claim, complete, fail, and inspect assignment desires.
 *
 * This module never mutates Worker config/systemd or activates a deployment binding.
 * A host reconciler must prepare and verify those external effects first.
 */
import { randomUUID } from 'node:crypto';
import { execute, queryOne, transaction, withClient } from '../../db/pg-repo.js';

export type ProjectWorkerAssignmentStatus = 'pending' | 'preparing' | 'active' | 'failed' | 'recovery_required' | 'cancelled';

export interface ProjectWorkerAssignmentDesire {
  project_id: string;
  deployment_id: string;
  desired_worker_id: string;
  status: ProjectWorkerAssignmentStatus;
  attempt: number;
  reason: string | null;
  last_error: string | null;
  requested_by_user_id: number | null;
  lease_owner: string | null;
  lease_expires_at: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

/** Record desired Worker placement without changing the Project execution path. */
export async function requestProjectWorkerAssignment(input: {
  projectId: string;
  deploymentId: string;
  workerId: string;
  requestedByUserId?: number | null;
  reason?: string;
}): Promise<ProjectWorkerAssignmentDesire> {
  const row = await queryOne<ProjectWorkerAssignmentDesire>(
    `INSERT INTO project_worker_assignment_desires(
       project_id,deployment_id,desired_worker_id,status,reason,requested_by_user_id
     ) VALUES($1,$2,$3,'pending',$4,$5)
     ON CONFLICT(project_id,deployment_id) DO UPDATE SET
       desired_worker_id=EXCLUDED.desired_worker_id,status='pending',reason=EXCLUDED.reason,
       last_error=NULL,lease_owner=NULL,lease_expires_at=NULL,completed_at=NULL,updated_at=NOW()
     WHERE project_worker_assignment_desires.status IN ('failed','cancelled')
     RETURNING *`,
    [input.projectId, input.deploymentId, input.workerId, input.reason?.trim() || null, input.requestedByUserId ?? null],
  );
  if (!row) throw new Error('PROJECT_WORKER_ASSIGNMENT_ALREADY_IN_PROGRESS_OR_ACTIVE');
  return row;
}

/** Claim one retryable desire. Expired preparing leases return to the queue. */
export async function claimProjectWorkerAssignment(input: {
  deploymentId: string;
  leaseSeconds?: number;
  owner?: string;
}): Promise<ProjectWorkerAssignmentDesire | undefined> {
  const leaseSeconds = Math.min(Math.max(Math.trunc(input.leaseSeconds ?? 60), 10), 600);
  const owner = input.owner?.trim() || `assignment-reconciler:${randomUUID()}`;
  return transaction(async client => {
    const db = withClient(client);
    const candidate = await db.queryOne<ProjectWorkerAssignmentDesire>(
      `SELECT * FROM project_worker_assignment_desires
       WHERE deployment_id=$1 AND (
         status='pending' OR status='failed' OR
         (status='preparing' AND lease_expires_at<NOW())
       )
       ORDER BY updated_at,project_id FOR UPDATE SKIP LOCKED LIMIT 1`,
      [input.deploymentId],
    );
    if (!candidate) return undefined;
    return db.queryOne<ProjectWorkerAssignmentDesire>(
      `UPDATE project_worker_assignment_desires SET status='preparing',attempt=attempt+1,
         lease_owner=$2,lease_expires_at=NOW()+($3*INTERVAL '1 second'),last_error=NULL,updated_at=NOW()
       WHERE project_id=$1 AND deployment_id=$4 RETURNING *`,
      [candidate.project_id, owner, leaseSeconds, input.deploymentId],
    );
  });
}

/** Mark active only after the reconciler has prepared Worker scope and activated the exact binding. */
export async function completeProjectWorkerAssignment(input: {
  projectId: string;
  deploymentId: string;
  leaseOwner: string;
}): Promise<boolean> {
  return (await execute(
    `UPDATE project_worker_assignment_desires SET status='active',lease_owner=NULL,lease_expires_at=NULL,
       completed_at=NOW(),updated_at=NOW() WHERE project_id=$1 AND deployment_id=$2
       AND status='preparing' AND lease_owner=$3`,
    [input.projectId, input.deploymentId, input.leaseOwner],
  )).changes === 1;
}

/** Preserve failure evidence and make the desire retryable without changing Project execution authority. */
export async function failProjectWorkerAssignment(input: {
  projectId: string;
  deploymentId: string;
  leaseOwner: string;
  error: string;
}): Promise<boolean> {
  return (await execute(
    `UPDATE project_worker_assignment_desires SET status='failed',last_error=$4,
       lease_owner=NULL,lease_expires_at=NULL,updated_at=NOW()
     WHERE project_id=$1 AND deployment_id=$2 AND status='preparing' AND lease_owner=$3`,
    [input.projectId, input.deploymentId, input.leaseOwner, input.error.slice(0, 2000)],
  )).changes === 1;
}

/** Mark post-binding audit ambiguity for explicit operator recovery. */
export async function markProjectWorkerAssignmentRecoveryRequired(input: {
  projectId: string;
  deploymentId: string;
  leaseOwner: string;
  error: string;
}): Promise<boolean> {
  return (await execute(
    `UPDATE project_worker_assignment_desires SET status='recovery_required',last_error=$4,
       lease_owner=NULL,lease_expires_at=NULL,updated_at=NOW()
     WHERE project_id=$1 AND deployment_id=$2 AND status='preparing' AND lease_owner=$3`,
    [input.projectId, input.deploymentId, input.leaseOwner, input.error.slice(0, 2000)],
  )).changes === 1;
}

/** Read assignment state for operator diagnostics. */
export async function getProjectWorkerAssignment(projectId: string, deploymentId: string): Promise<ProjectWorkerAssignmentDesire | undefined> {
  return queryOne<ProjectWorkerAssignmentDesire>(
    'SELECT * FROM project_worker_assignment_desires WHERE project_id=$1 AND deployment_id=$2',
    [projectId, deploymentId],
  );
}

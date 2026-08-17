/**
 * Owns: stale-safe Project-level emergency return from Worker-first to Runtime Box compatibility.
 * Public API: previewProjectWorkerEmergencyFallback, applyProjectWorkerEmergencyFallback.
 */
import { createHash } from 'node:crypto';
import { queryOne, transaction } from '../../db/pg-repo.js';
import type { ProjectComputeAuthorityMode } from './workbench-project-compute-settings.js';

export class ProjectWorkerEmergencyFallbackError extends Error {
  constructor(public code: string, message: string) { super(message); }
}

interface BindingSnapshot {
  projectId: string;
  deploymentId: string;
  defaultWorkerId: string | null;
  workstationMode: boolean;
  authorityMode: ProjectComputeAuthorityMode;
  updatedAt: string;
}

interface IntentRow {
  id: string;
  project_id: string;
  deployment_id: string;
  actor_user_id: number;
  expected_binding: BindingSnapshot;
  proposal_hash: string;
  status: 'previewed' | 'succeeded' | 'failed';
  expires_at: string;
  consumed_at: string | null;
}

function digest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function bindingDigest(binding: BindingSnapshot): string {
  return digest({
    projectId: binding.projectId,
    deploymentId: binding.deploymentId,
    defaultWorkerId: binding.defaultWorkerId,
    workstationMode: binding.workstationMode,
    authorityMode: binding.authorityMode,
    updatedAt: binding.updatedAt,
  });
}

function assertOperator(role: string): void {
  if (!['admin', 'operator'].includes(role)) throw new ProjectWorkerEmergencyFallbackError('OPERATOR_ROLE_REQUIRED', 'Admin or operator role required');
}

async function readBinding(projectId: string, deploymentId: string): Promise<BindingSnapshot | undefined> {
  const row = await queryOne<any>(
    `SELECT project_id,deployment_id,default_worker_id,workstation_mode,authority_mode,updated_at
       FROM project_compute_deployment_bindings WHERE project_id=$1 AND deployment_id=$2`,
    [projectId, deploymentId],
  );
  return row ? {
    projectId: row.project_id, deploymentId: row.deployment_id, defaultWorkerId: row.default_worker_id,
    workstationMode: row.workstation_mode, authorityMode: row.authority_mode,
    updatedAt: new Date(row.updated_at).toISOString(),
  } : undefined;
}

/** Preview exact binding removal without contacting the Worker. */
export async function previewProjectWorkerEmergencyFallback(input: {
  projectId: string;
  deploymentId: string;
  reason: string;
  actor: { userId: number; role: string; sessionId?: string | null };
}) {
  assertOperator(input.actor.role);
  if (!input.reason.trim()) throw new ProjectWorkerEmergencyFallbackError('REASON_REQUIRED', 'Emergency fallback reason required');
  const binding = await readBinding(input.projectId, input.deploymentId);
  if (!binding?.workstationMode) throw new ProjectWorkerEmergencyFallbackError('WORKSTATION_BINDING_NOT_ACTIVE', 'Active Workstation binding required');
  const proposalHash = digest({ actorUserId: input.actor.userId, binding, action: 'disable-worker-first' });
  const row = await queryOne<{ id: string; expires_at: string }>(
    `INSERT INTO project_worker_emergency_fallback_intents
      (project_id,deployment_id,actor_user_id,actor_session_id,expected_binding,proposal_hash,reason,expires_at)
     VALUES($1,$2,$3,$4,$5::jsonb,$6,$7,NOW()+INTERVAL '15 minutes') RETURNING id,expires_at`,
    [input.projectId, input.deploymentId, input.actor.userId, input.actor.sessionId ?? null,
      JSON.stringify(binding), proposalHash, input.reason.trim()],
  );
  if (!row) throw new ProjectWorkerEmergencyFallbackError('INTENT_CREATE_FAILED', 'Failed to create emergency fallback intent');
  return {
    intentId: row.id, proposalHash, expiresAt: row.expires_at, binding,
    impact: {
      nextDefaultRuntime: 'project-runtime-box', workerProcessChanged: false, workerRegistrationChanged: false,
      runningWorkerRunsInterrupted: false, newWorkerRunsPreventedForProject: true,
    },
    applyPolicy: { exactConfirmationRequired: true, staleBindingRejected: true },
  };
}

/** Consume one exact preview and disable only the selected Project+deployment binding. */
export async function applyProjectWorkerEmergencyFallback(input: {
  projectId: string;
  deploymentId: string;
  intentId: string;
  proposalHash: string;
  confirmed: true;
  actor: { userId: number; role: string };
}) {
  assertOperator(input.actor.role);
  if (input.confirmed !== true) throw new ProjectWorkerEmergencyFallbackError('CONFIRMATION_REQUIRED', 'Explicit confirmation required');
  return transaction(async client => {
    const intentResult = await client.query<IntentRow>(
      `SELECT * FROM project_worker_emergency_fallback_intents
        WHERE id=$1 AND project_id=$2 AND deployment_id=$3 AND actor_user_id=$4
          AND proposal_hash=$5 AND expires_at>NOW() FOR UPDATE`,
      [input.intentId, input.projectId, input.deploymentId, input.actor.userId, input.proposalHash],
    );
    const intent = intentResult.rows[0];
    if (!intent || intent.consumed_at || intent.status !== 'previewed') {
      throw new ProjectWorkerEmergencyFallbackError('INTENT_EXPIRED_OR_CONSUMED', 'Valid unused emergency fallback intent required');
    }
    const bindingResult = await client.query<any>(
      `SELECT project_id,deployment_id,default_worker_id,workstation_mode,authority_mode,updated_at
         FROM project_compute_deployment_bindings WHERE project_id=$1 AND deployment_id=$2 FOR UPDATE`,
      [input.projectId, input.deploymentId],
    );
    const row = bindingResult.rows[0];
    const current: BindingSnapshot | undefined = row ? {
      projectId: row.project_id, deploymentId: row.deployment_id, defaultWorkerId: row.default_worker_id,
      workstationMode: row.workstation_mode, authorityMode: row.authority_mode,
      updatedAt: new Date(row.updated_at).toISOString(),
    } : undefined;
    if (!current || bindingDigest(current) !== bindingDigest(intent.expected_binding)) {
      throw new ProjectWorkerEmergencyFallbackError('STALE_INTENT', 'Project Worker binding changed after preview');
    }
    const update = await client.query(
      `UPDATE project_compute_deployment_bindings
          SET default_worker_id=NULL,workstation_mode=FALSE,updated_by_user_id=$3,updated_at=NOW()
        WHERE project_id=$1 AND deployment_id=$2 AND workstation_mode=TRUE RETURNING updated_at`,
      [input.projectId, input.deploymentId, input.actor.userId],
    );
    if (update.rowCount !== 1) throw new ProjectWorkerEmergencyFallbackError('BINDING_STATE_CHANGED', 'Project Worker binding was not active');
    const result = {
      ok: true, projectId: input.projectId, deploymentId: input.deploymentId,
      previousWorkerId: current.defaultWorkerId, workstationMode: false,
      nextDefaultRuntime: 'project-runtime-box', workerProcessChanged: false,
    };
    const consumed = await client.query(
      `UPDATE project_worker_emergency_fallback_intents
          SET consumed_at=NOW(),status='succeeded',result=$2::jsonb,completed_at=NOW()
        WHERE id=$1 AND consumed_at IS NULL AND status='previewed'`,
      [intent.id, JSON.stringify(result)],
    );
    if (consumed.rowCount !== 1) throw new ProjectWorkerEmergencyFallbackError('INTENT_CONSUMED', 'Emergency fallback intent was consumed concurrently');
    return result;
  });
}

/**
 * Owns: preview/apply contract for changing one Project deployment's sticky Workstation.
 * Public API: previewProjectWorkstationChange, applyProjectWorkstationChange.
 */
import { createHash } from 'node:crypto';
import { queryOne, transaction } from '../../db/pg-repo.js';
import { getPersistedWorkbenchWorker } from './workbench-worker-repository.js';
import { createRemoteWorkbenchHttpTransport } from './workbench-remote-http-transport.js';
import { getWorkbenchWorkerTransportCredentialBinding, resolveWorkbenchWorkerTransportToken } from './workbench-worker-transport-credentials.js';
import type { ProjectComputeAuthorityMode } from './workbench-project-compute-settings.js';

export class ProjectWorkstationChangeError extends Error {
  constructor(public code: string, message: string) { super(message); }
}

type BindingSnapshot = {
  projectId: string;
  deploymentId: string;
  defaultWorkerId: string | null;
  workstationMode: boolean;
  authorityMode: ProjectComputeAuthorityMode;
  updatedAt: string;
};

type TargetSnapshot = {
  workerId: string;
  deploymentId: string;
  authorityMode: ProjectComputeAuthorityMode;
  status: string;
  heartbeatAt: string;
  capabilities: string[];
  projectAuthorized: boolean;
  transportConfigured: boolean;
  capacity: { activeRuns: number; maxRuns: number };
};

type IntentRow = {
  id: string;
  target_worker_id: string;
  expected_binding: BindingSnapshot | null;
  target_snapshot: TargetSnapshot;
  status: 'previewed' | 'succeeded' | 'failed';
  consumed_at: string | null;
  proposal_hash?: string;
  smoke_receipt_hash?: string | null;
  smoke_verified_at?: string | null;
};

function digest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function targetConfigurationDigest(target: TargetSnapshot): string {
  return digest({
    workerId: target.workerId,
    deploymentId: target.deploymentId,
    authorityMode: target.authorityMode,
    capabilities: target.capabilities,
    projectAuthorized: target.projectAuthorized,
    transportConfigured: target.transportConfigured,
    maxRuns: target.capacity.maxRuns,
  });
}

function assertOperator(role: string): void {
  if (!['admin', 'operator'].includes(role)) throw new ProjectWorkstationChangeError('OPERATOR_ROLE_REQUIRED', 'Admin or operator role required');
}

function normalizeBinding(row: any): BindingSnapshot {
  return {
    projectId: row.project_id,
    deploymentId: row.deployment_id,
    defaultWorkerId: row.default_worker_id,
    workstationMode: row.workstation_mode,
    authorityMode: row.authority_mode,
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}

async function readBinding(projectId: string, deploymentId: string): Promise<BindingSnapshot | null> {
  const row = await queryOne<any>(
    `SELECT project_id,deployment_id,default_worker_id,workstation_mode,authority_mode,updated_at
       FROM project_compute_deployment_bindings WHERE project_id=$1 AND deployment_id=$2`,
    [projectId, deploymentId],
  );
  return row ? normalizeBinding(row) : null;
}

async function readTarget(projectId: string, deploymentId: string, workerId: string, authorityMode: ProjectComputeAuthorityMode): Promise<TargetSnapshot> {
  const worker = await getPersistedWorkbenchWorker(workerId);
  if (!worker) throw new ProjectWorkstationChangeError('TARGET_WORKER_NOT_REGISTERED', 'Target Workstation is not registered');
  const requiredCapabilities = ['job', ...(authorityMode === 'operator-plane' ? ['operator-plane'] : [])];
  const missing = requiredCapabilities.filter(capability => !worker.capabilities.includes(capability));
  const transportConfigured = Boolean(await getWorkbenchWorkerTransportCredentialBinding(workerId));
  const target: TargetSnapshot = {
    workerId: worker.workerId,
    deploymentId: worker.deploymentId,
    authorityMode,
    status: worker.status,
    heartbeatAt: worker.heartbeatAt,
    capabilities: [...worker.capabilities].sort(),
    projectAuthorized: worker.projectIds.includes(projectId),
    transportConfigured,
    capacity: { activeRuns: worker.capacity.activeRuns, maxRuns: worker.capacity.maxRuns },
  };
  if (target.deploymentId !== deploymentId) throw new ProjectWorkstationChangeError('TARGET_WORKER_DEPLOYMENT_MISMATCH', 'Target Workstation belongs to another deployment');
  if (target.status !== 'healthy') throw new ProjectWorkstationChangeError('TARGET_WORKER_NOT_HEALTHY', `Target Workstation status is ${target.status}`);
  if (!target.projectAuthorized) throw new ProjectWorkstationChangeError('TARGET_WORKER_PROJECT_SCOPE_MISSING', 'Target Workstation is not authorized for this Project');
  if (missing.length) throw new ProjectWorkstationChangeError('TARGET_WORKER_CAPABILITY_MISSING', `Target Workstation is missing ${missing.join(',')}`);
  if (!target.transportConfigured) throw new ProjectWorkstationChangeError('TARGET_WORKER_TRANSPORT_UNAVAILABLE', 'Target Workstation transport is not configured');
  if (target.capacity.maxRuns < 3) throw new ProjectWorkstationChangeError('TARGET_WORKER_CAPACITY_INVALID', 'Target Workstation capacity must support the heaviest single request');
  return target;
}

export async function previewProjectWorkstationChange(input: {
  projectId: string;
  deploymentId: string;
  targetWorkerId: string;
  authorityMode?: ProjectComputeAuthorityMode;
  reason: string;
  actor: { userId: number; role: string; sessionId?: string | null };
}) {
  assertOperator(input.actor.role);
  if (!input.reason.trim()) throw new ProjectWorkstationChangeError('REASON_REQUIRED', 'Workstation change reason required');
  const authorityMode = input.authorityMode ?? 'project';
  const binding = await readBinding(input.projectId, input.deploymentId);
  if (binding?.defaultWorkerId === input.targetWorkerId && binding.workstationMode && binding.authorityMode === authorityMode) {
    throw new ProjectWorkstationChangeError('TARGET_ALREADY_ACTIVE', 'Target Workstation is already active');
  }
  const target = await readTarget(input.projectId, input.deploymentId, input.targetWorkerId, authorityMode);
  const proposal = { actorUserId: input.actor.userId, projectId: input.projectId, deploymentId: input.deploymentId, binding, target, authorityMode };
  const proposalHash = digest(proposal);
  const row = await queryOne<{ id: string; expires_at: string }>(
    `INSERT INTO project_workstation_change_intents
      (project_id,deployment_id,target_worker_id,actor_user_id,actor_session_id,expected_binding,target_snapshot,proposal_hash,reason,expires_at)
     VALUES($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8,$9,NOW()+INTERVAL '15 minutes') RETURNING id,expires_at`,
    [input.projectId, input.deploymentId, input.targetWorkerId, input.actor.userId, input.actor.sessionId ?? null,
      binding ? JSON.stringify(binding) : null, JSON.stringify(target), proposalHash, input.reason.trim()],
  );
  if (!row) throw new ProjectWorkstationChangeError('INTENT_CREATE_FAILED', 'Failed to create Workstation change intent');
  return {
    intentId: row.id,
    proposalHash,
    expiresAt: row.expires_at,
    current: binding,
    target,
    authorityMode,
    checks: { health: 'pass', projectScope: 'pass', capabilities: 'pass', transport: 'pass', capacity: 'pass', executionSmoke: 'required-before-apply' },
    impact: { bindingOnly: true, workerProcessChanged: false, runningCommandsInterrupted: false, rollbackWorkerId: binding?.defaultWorkerId ?? null },
  };
}

export async function verifyProjectWorkstationChangeSmoke(input: {
  projectId: string;
  deploymentId: string;
  intentId: string;
  proposalHash: string;
  actor: { userId: number; role: string };
}) {
  assertOperator(input.actor.role);
  const intent = await queryOne<IntentRow>(
    `SELECT * FROM project_workstation_change_intents
      WHERE id=$1 AND project_id=$2 AND deployment_id=$3 AND actor_user_id=$4
        AND proposal_hash=$5 AND expires_at>NOW() AND consumed_at IS NULL AND status='previewed'`,
    [input.intentId, input.projectId, input.deploymentId, input.actor.userId, input.proposalHash],
  );
  if (!intent) throw new ProjectWorkstationChangeError('INTENT_EXPIRED_OR_CONSUMED', 'Valid unused Workstation change intent required');
  const authorityMode = intent.target_snapshot.authorityMode;
  const target = await readTarget(input.projectId, input.deploymentId, intent.target_worker_id, authorityMode);
  if (targetConfigurationDigest(target) !== targetConfigurationDigest(intent.target_snapshot)) {
    throw new ProjectWorkstationChangeError('TARGET_STATE_CHANGED', 'Target Workstation configuration changed after preview');
  }
  const token = await resolveWorkbenchWorkerTransportToken(target.workerId, input.actor.userId);
  if (!token) throw new ProjectWorkstationChangeError('TARGET_WORKER_TRANSPORT_UNAVAILABLE', 'Target Workstation transport is not configured');
  const transport = createRemoteWorkbenchHttpTransport({ workerId: target.workerId, baseUrl: (await getPersistedWorkbenchWorker(target.workerId))!.baseUrl, token });
  let stdout = '';
  let stderr = '';
  const command = `set -eu
printf 'user=%s\\n' "$(id -un)"
printf 'home=%s\\n' "$HOME"
printf 'cwd=%s\\n' "$PWD"
command -v node >/dev/null
command -v chromium >/dev/null
test -n "$HOME"
test -d "$HOME"
test -w "$HOME"
for k in DATABASE_URL JWT_SECRET SECRET_STORE_MASTER_KEY TOWER_REMOTE_WORKER_TOKEN; do test -z "$(printenv "$k" 2>/dev/null || true)"; done
printf smoke > .tower-workstation-change-smoke
test "$(cat .tower-workstation-change-smoke)" = smoke
rm .tower-workstation-change-smoke
printf 'workstation-smoke-ok\\n'`;
  const result = await transport.execute({
    spec: {
      jobId: Date.now(), projectId: input.projectId, command,
      cwd: '/workspace', timeoutSec: 30, workbenchRevision: null, environmentKeys: [], artifacts: [],
    },
    signal: AbortSignal.timeout(35_000),
    onStdout: chunk => { stdout = `${stdout}${chunk}`.slice(-8_192); },
    onStderr: chunk => { stderr = `${stderr}${chunk}`.slice(-8_192); },
  });
  if (result.execResult.exit_code !== 0 || !stdout.includes('workstation-smoke-ok')) {
    throw new ProjectWorkstationChangeError('TARGET_WORKER_SMOKE_FAILED', `Target Workstation smoke failed with exit ${result.execResult.exit_code}: ${stderr.slice(-500)}`);
  }
  const verifiedAt = new Date().toISOString();
  const receiptHash = digest({ intentId: intent.id, proposalHash: input.proposalHash, targetConfiguration: targetConfigurationDigest(target), verifiedAt });
  const updated = await queryOne<{ smoke_verified_at: string }>(
    `UPDATE project_workstation_change_intents
        SET smoke_receipt_hash=$2,smoke_verified_at=$3
      WHERE id=$1 AND consumed_at IS NULL AND status='previewed' AND proposal_hash=$4 RETURNING smoke_verified_at`,
    [intent.id, receiptHash, verifiedAt, input.proposalHash],
  );
  if (!updated) throw new ProjectWorkstationChangeError('INTENT_STATE_CHANGED', 'Workstation change intent changed during smoke');
  return {
    ok: true, intentId: intent.id, receiptHash, verifiedAt: updated.smoke_verified_at,
    workerId: target.workerId,
    checks: { execution: 'pass', projectCwd: 'pass', persistentHome: 'pass', node: 'pass', chromium: 'pass', secretIsolation: 'pass', fileRoundTrip: 'pass' },
  };
}

export async function applyProjectWorkstationChange(input: {
  projectId: string;
  deploymentId: string;
  intentId: string;
  proposalHash: string;
  confirmed: true;
  smokeReceiptHash: string;
  actor: { userId: number; role: string };
}) {
  assertOperator(input.actor.role);
  if (input.confirmed !== true || !/^[0-9a-f]{64}$/.test(input.smokeReceiptHash)) throw new ProjectWorkstationChangeError('CONFIRMATION_AND_SMOKE_RECEIPT_REQUIRED', 'Explicit confirmation and a server-issued smoke receipt are required');
  return transaction(async client => {
    const intentResult = await client.query<IntentRow>(
      `SELECT * FROM project_workstation_change_intents
        WHERE id=$1 AND project_id=$2 AND deployment_id=$3 AND actor_user_id=$4
          AND proposal_hash=$5 AND expires_at>NOW() FOR UPDATE`,
      [input.intentId, input.projectId, input.deploymentId, input.actor.userId, input.proposalHash],
    );
    const intent = intentResult.rows[0];
    if (!intent || intent.consumed_at || intent.status !== 'previewed') throw new ProjectWorkstationChangeError('INTENT_EXPIRED_OR_CONSUMED', 'Valid unused Workstation change intent required');
    if (!intent.smoke_receipt_hash || intent.smoke_receipt_hash !== input.smokeReceiptHash || !intent.smoke_verified_at) {
      throw new ProjectWorkstationChangeError('SMOKE_RECEIPT_INVALID', 'A matching server-issued smoke receipt is required');
    }
    const bindingResult = await client.query<any>(
      `SELECT project_id,deployment_id,default_worker_id,workstation_mode,authority_mode,updated_at
         FROM project_compute_deployment_bindings WHERE project_id=$1 AND deployment_id=$2 FOR UPDATE`,
      [input.projectId, input.deploymentId],
    );
    const current = bindingResult.rows[0] ? normalizeBinding(bindingResult.rows[0]) : null;
    if (digest(current) !== digest(intent.expected_binding)) throw new ProjectWorkstationChangeError('STALE_INTENT', 'Project Workstation binding changed after preview');
    const authorityMode = intent.target_snapshot.authorityMode;
    const target = await readTarget(input.projectId, input.deploymentId, intent.target_worker_id, authorityMode);
    if (targetConfigurationDigest(target) !== targetConfigurationDigest(intent.target_snapshot)) throw new ProjectWorkstationChangeError('TARGET_STATE_CHANGED', 'Target Workstation configuration changed after preview');
    await client.query(
      `INSERT INTO project_compute_deployment_bindings(project_id,deployment_id,default_worker_id,workstation_mode,authority_mode,updated_by_user_id)
       VALUES($1,$2,$3,TRUE,$4,$5)
       ON CONFLICT(project_id,deployment_id) DO UPDATE SET
         default_worker_id=EXCLUDED.default_worker_id,workstation_mode=TRUE,authority_mode=EXCLUDED.authority_mode,
         updated_by_user_id=EXCLUDED.updated_by_user_id,updated_at=NOW()`,
      [input.projectId, input.deploymentId, intent.target_worker_id, authorityMode, input.actor.userId],
    );
    const result = { ok: true, projectId: input.projectId, deploymentId: input.deploymentId, previousWorkerId: current?.defaultWorkerId ?? null, workerId: intent.target_worker_id, workstationMode: true, authorityMode };
    const consumed = await client.query(
      `UPDATE project_workstation_change_intents SET consumed_at=NOW(),status='succeeded',result=$2::jsonb,completed_at=NOW()
        WHERE id=$1 AND consumed_at IS NULL AND status='previewed'`,
      [intent.id, JSON.stringify(result)],
    );
    if (consumed.rowCount !== 1) throw new ProjectWorkstationChangeError('INTENT_CONSUMED', 'Workstation change intent was consumed concurrently');
    return result;
  });
}

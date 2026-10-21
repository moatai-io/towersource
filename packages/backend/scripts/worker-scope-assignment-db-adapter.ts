import { assertScopeExecutionBinding } from './worker-scope-assignment-lifecycle.js';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { PoolClient } from 'pg';
import { query, queryOne, transaction } from '../db/pg-repo.js';
import { issueWorkbenchWorkerIdentity, verifyWorkbenchWorkerIdentity } from '../services/runtime-box/workbench-worker-identity.js';
import { getWorkbenchWorkerIdentity, rotateWorkbenchWorkerIdentity, type WorkbenchWorkerIdentityRow } from '../services/runtime-box/workbench-worker-identity-repository.js';
import { activateProjectWorkerFirstWithClient } from '../services/runtime-box/workbench-project-worker-first-activation.js';
import { digest, durableWrite, protectedPath, scopeDigest, type AssignmentInput, type AssignmentOperation, type FileEvidence, type Scope, type ScopeLifecycleAdapters } from './worker-scope-assignment-lifecycle.js';

/** Concrete identity + PostgreSQL subset. No pool is opened at module load by this
 * adapter, no installer/systemctl or root escalation. Caller must already hold the
 * approved mutation EX lock and durable owner. The remaining authorization, idle,
 * heartbeat/restart and HTTP adapters MUST be supplied separately.
 */
export type ScopeAssignmentDbMethods = Pick<ScopeLifecycleAdapters,
  'assertLease' | 'readIdentity' | 'stageIdentity' | 'rotateIdentity' | 'publishIdentity' | 'publishedIdentity' |
  'bindingState' | 'commitBinding' | 'finishWithoutBinding'>;

interface Options {
  input: AssignmentInput;
  actorUserId: number;
  /** Pre-created protected directory. Never infer from cwd or /tmp. */
  stagingDirectory: string;
  /** Keep legacy signed-grant file authority semantics explicit. */
  fileAuthorityReady: boolean;
  /** Installed trusted owner/execution-group, captured by installation policy. */
  installedIdentity: { uid: number; gid: number; mode: 0o600 | 0o640 };
}
const same = (a: string[], b: string[]) => [...a].sort().join('\0') === [...b].sort().join('\0');
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
function fail(code: string): never { throw new Error(code); }

function secureToken(file: string, expected?: { uid: number; gid: number; mode: number }): string {
  protectedPath(file);
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile() || st.nlink !== 1 || (expected ? (st.mode & ~0o100640) !== 0 : (st.mode & 0o077) !== 0) || (st.mode & 0o7000)
      || (expected && (st.uid !== expected.uid || st.gid !== expected.gid || (st.mode & 0o777) !== expected.mode))) fail('SCOPE_IDENTITY_FILE_UNSAFE');
    const bytes = fs.readFileSync(fd, 'utf8').trim();
    if (bytes.length > 16384) fail('SCOPE_IDENTITY_FILE_INVALID');
    return bytes;
  } finally { fs.closeSync(fd); }
}
function verifiedToken(file: string, expected?: { uid: number; gid: number; mode: number }) {
  const identity = verifyWorkbenchWorkerIdentity(secureToken(file, expected));
  if (!identity) fail('SCOPE_IDENTITY_TOKEN_INVALID');
  return identity;
}

export function createWorkerScopeAssignmentDbAdapter(options: Options): ScopeAssignmentDbMethods {
  const { input, actorUserId, stagingDirectory, fileAuthorityReady } = options;
  if (!Number.isSafeInteger(actorUserId) || actorUserId < 1 || typeof fileAuthorityReady !== 'boolean') fail('SCOPE_DB_ADAPTER_INPUT_INVALID');
  const installed = options.installedIdentity;
  if (!installed || ![0o600, 0o640].includes(installed.mode) || !Number.isSafeInteger(installed.uid) || installed.uid < 0 || !Number.isSafeInteger(installed.gid) || installed.gid < 0) fail('SCOPE_INSTALLED_IDENTITY_POLICY_REQUIRED');
  async function preflightPublication() {
    secureToken(input.identityFile, installed);
    // Exercise exact parent rename/chown/mode authority BEFORE any DB rotation.
    // This private empty artifact contains no JWT; never chmod the installed file.
    const probe = path.join(path.dirname(input.identityFile), `.identity-preflight-${crypto.randomUUID()}`);
    try { durableWrite(probe, '', installed); secureToken(probe, installed); }
    finally { if (fs.existsSync(probe)) fs.unlinkSync(probe); }
  }
  const keys = [input.projectId, input.deploymentId];
  function checkInput(value: AssignmentInput) {
    if (['projectId', 'workerId', 'deploymentId', 'leaseOwner', 'configFile', 'identityFile', 'stateFile', 'root'].some(key => value[key as keyof AssignmentInput] !== input[key as keyof AssignmentInput])) fail('SCOPE_DB_INPUT_MISMATCH');
  }
  function checkOperation(op: AssignmentOperation) {
    if (op.kind !== 'scope-assignment' || op.version !== 1 || !uuid.test(op.id) || op.projectId !== input.projectId
      || op.workerId !== input.workerId || op.deploymentId !== input.deploymentId || op.leaseOwner !== input.leaseOwner
      || op.config.path !== input.configFile || op.identity.path !== input.identityFile
      || op.newScope[op.projectId] !== input.root || Object.hasOwn(op.oldScope, op.projectId)
      || scopeDigest(op.newScope) !== scopeDigest({ ...op.oldScope, [op.projectId]: input.root })) fail('SCOPE_DB_OPERATION_MISMATCH');
  }
  function ownedOperation(): AssignmentOperation {
    protectedPath(input.stateFile);
    const state = JSON.parse(fs.readFileSync(input.stateFile, 'utf8'));
    const op = state.operation as AssignmentOperation;
    if (!op || state.version !== 1 || state.owner !== op.id) fail('SCOPE_DB_OWNER_REQUIRED');
    checkOperation(op); return op;
  }
  function stageFile(jti: string) { if (!uuid.test(jti)) fail('SCOPE_STAGED_JTI_INVALID'); return path.join(stagingDirectory, `${jti}.jwt`); }
  function checkStageDirectory() {
    protectedPath(stagingDirectory);
    const stat = fs.statSync(stagingDirectory);
    if (!stat.isDirectory() || stat.mode & 0o077) fail('SCOPE_STAGING_DIRECTORY_UNSAFE');
  }
  async function soleActive(): Promise<WorkbenchWorkerIdentityRow> {
    // Count every active row: list(limit) must not hide multiple active identities.
    const rows = await query<WorkbenchWorkerIdentityRow>(
      `SELECT * FROM runtime_box_workbench_worker_identities WHERE worker_id=$1
       AND revoked_at IS NULL AND expires_at>NOW() ORDER BY jti`, [input.workerId]);
    if (rows.length !== 1) fail('SCOPE_ACTIVE_IDENTITY_COUNT_INVALID');
    const row = rows[0];
    if (row.worker_id !== input.workerId || row.revoked_at || !row.capabilities.length) fail('SCOPE_ACTIVE_IDENTITY_INVALID');
    return row;
  }
  async function lockedDesire(client: PoolClient) {
    const result = await client.query(
      `SELECT project_id,deployment_id,desired_worker_id,status,lease_owner,lease_expires_at
       FROM project_worker_assignment_desires WHERE project_id=$1 AND deployment_id=$2 FOR UPDATE`, keys);
    const row = result.rows[0];
    // Never steal an expired lease. Ownership remains durable until exact recovery;
    // expiry is not silently used as authorization for another caller.
    if (row?.status !== 'preparing' || row.lease_owner !== input.leaseOwner || row.desired_worker_id !== input.workerId) fail('SCOPE_ASSIGNMENT_LEASE_LOST');
    return row;
  }
  function evidence(op: AssignmentOperation): string {
    return `scope-assignment:${op.id}:${digest(JSON.stringify({ lease: op.leaseOwner, jti: op.newJti, probe: op.probe, execution: op.executionReceipt }))}`;
  }
  function assertProbe(op: AssignmentOperation) {
    const e = op.executionReceipt;
    if (!e || e.owner !== op.id || e.projectId !== input.projectId || e.rootDigest !== digest(input.root)
      || e.scopeDigest !== scopeDigest(op.newScope) || e.pid !== op.livePid || e.commandVerified !== true
      || e.backendSharedWriteVerified !== true || e.cleaned !== true) fail('SCOPE_PROJECT_EXECUTION_RECEIPT_REQUIRED');
    assertScopeExecutionBinding(op,e);
    const p = op.probe;
    if (!op.newJti || !p || p.owner !== op.id || p.projectId !== input.projectId || p.rootDigest !== digest(input.root)
      || p.scopeDigest !== scopeDigest(op.newScope) || p.pid !== op.livePid || !Number.isSafeInteger(p.pid) || p.pid <= 0 || p.cleaned !== true) fail('SCOPE_BINDING_PROBE_REQUIRED');
  }
  function terminalEvidence(op: AssignmentOperation, result: 'deferred' | 'rolled-back') {
    return `scope-terminal:${op.id}:${digest(JSON.stringify({ lease: op.leaseOwner, result, oldJti: op.oldJti, rollbackJti: op.rollbackJti, config: op.config.sha256, terminalVerification: op.terminalVerification }))}`;
  }
  const methods: ScopeAssignmentDbMethods = {
    async assertLease(value) {
      checkInput(value);
      await transaction(async client => {
        await lockedDesire(client);
        const result = await client.query('SELECT project_id FROM project_compute_deployment_bindings WHERE project_id=$1 AND deployment_id=$2', keys);
        if (result.rows.length) fail('SCOPE_ASSIGNMENT_BINDING_EXISTS');
      });
    },
    async readIdentity() {
      const active = await soleActive();
      const predecessors = await query<WorkbenchWorkerIdentityRow>(
        'SELECT * FROM runtime_box_workbench_worker_identities WHERE replaced_by_jti=$1', [active.jti]);
      if (predecessors.length > 1 || predecessors.some(p => p.worker_id !== input.workerId || !p.revoked_at)) fail('SCOPE_IDENTITY_LINKAGE_AMBIGUOUS');
      return { activeJti: active.jti, previousJti: predecessors[0]?.jti ?? null, projectIds: active.project_ids };
    },
    async stageIdentity(scope: Scope, operationId, purpose) {
      await preflightPublication();
      const op = ownedOperation();
      if (op.id !== operationId || op.phase !== (purpose === 'forward' ? 'stage-intent' : 'rollback-stage-intent')
        || scopeDigest(scope) !== scopeDigest(purpose === 'forward' ? op.newScope : op.oldScope)) fail('SCOPE_STAGE_OPERATION_MISMATCH');
      const active = await soleActive();
      const old = await getWorkbenchWorkerIdentity(op.oldJti);
      if (!old || old.worker_id !== input.workerId || !same(old.capabilities, active.capabilities)
        || active.jti !== (purpose === 'forward' ? op.oldJti : op.newJti)) fail('SCOPE_STAGE_IDENTITY_DRIFT');
      checkStageDirectory();
      // Preserve the official prior capability ceiling; do not invent job/service/shell.
      const issued = issueWorkbenchWorkerIdentity({ workerId: input.workerId, projectIds: Object.keys(scope), capabilities: old.capabilities, expiresIn: '30d' });
      const file = stageFile(issued.identity.jti);
      if (fs.existsSync(file)) fail('SCOPE_STAGED_IDENTITY_COLLISION');
      durableWrite(file, `${issued.token}\n`); // 0600, current authorized process owner
      return { jti: issued.identity.jti };
    },
    async rotateIdentity(previousJti, newJti) {
      await preflightPublication();
      const op = ownedOperation();
      const rollback = op.phase === 'rollback-rotation-intent';
      if (!rollback && op.phase !== 'rotation-intent') fail('SCOPE_ROTATION_PHASE_INVALID');
      if (previousJti !== (rollback ? op.newJti : op.oldJti) || newJti !== (rollback ? op.rollbackJti : op.newJti)) fail('SCOPE_ROTATION_INTENT_MISMATCH');
      const active = await soleActive();
      const replacement = verifiedToken(stageFile(newJti));
      if (active.jti !== previousJti || replacement.jti !== newJti || replacement.workerId !== input.workerId
        || !same(replacement.capabilities, active.capabilities)
        || !same(replacement.projectIds, Object.keys(rollback ? op.oldScope : op.newScope))) fail('SCOPE_ROTATION_SCOPE_MISMATCH');
      // Existing official transaction records replacement and revokes old with
      // replaced_by_jti linkage. Controller journals intent before this call.
      await rotateWorkbenchWorkerIdentity({ previousJti, replacement, issuedByUserId: actorUserId, reason: `Scope assignment ${op.id}${rollback ? ' rollback' : ''}` });
      const prior = await getWorkbenchWorkerIdentity(previousJti);
      const next = await soleActive();
      if (!prior?.revoked_at || prior.replaced_by_jti !== newJti || next.jti !== newJti) fail('SCOPE_ROTATION_READBACK_AMBIGUOUS');
    },
    async publishIdentity(jti, target: FileEvidence) {
      const op = ownedOperation();
      const expected = op.phase === 'rollback-files-intent' ? op.rollbackJti : op.phase === 'identity-file-intent' ? op.newJti : undefined;
      if (jti !== expected || target.path !== input.identityFile || target.uid !== op.identity.uid || target.gid !== op.identity.gid || target.mode !== op.identity.mode
        || target.uid !== installed.uid || target.gid !== installed.gid || target.mode !== installed.mode) fail('SCOPE_PUBLISH_INTENT_MISMATCH');
      const current = fs.lstatSync(target.path);
      // No silent permission/owner repair. Existing old token may be expired, but
      // it must remain a protected regular file with its exact captured metadata.
      secureToken(target.path, target);
      if (!current.isFile()) fail('SCOPE_IDENTITY_FILE_UNSAFE');
      const active = await soleActive(); const staged = verifiedToken(stageFile(jti));
      if (active.jti !== jti || staged.jti !== jti || staged.workerId !== input.workerId || !same(active.project_ids, staged.projectIds)
        || !same(active.capabilities, staged.capabilities)) fail('SCOPE_PUBLISH_IDENTITY_INACTIVE');
      durableWrite(target.path, `${secureToken(stageFile(jti))}\n`, target);
      if (verifiedToken(target.path, target).jti !== jti) fail('SCOPE_PUBLISH_VERIFY_FAILED');
    },
    async publishedIdentity() {
      const identity = verifiedToken(input.identityFile, installed); const stat = fs.statSync(input.identityFile);
      if (identity.workerId !== input.workerId) fail('SCOPE_PUBLISHED_WORKER_MISMATCH');
      return { jti: identity.jti, uid: stat.uid, gid: stat.gid, mode: stat.mode & 0o777 };
    },
    async commitBinding(op) {
      checkOperation(op); assertProbe(op);
      const current = ownedOperation();
      if (current.id !== op.id || current.phase !== 'binding-intent' || evidence(current) !== evidence(op)) fail('SCOPE_BINDING_JOURNAL_MISMATCH');
      await transaction(async client => {
        await lockedDesire(client);
        // Official activation performs insert-only deployment binding + settings
        // + rollout on THIS client, so desire active shares the same commit.
        await activateProjectWorkerFirstWithClient(client, {
          projectId: input.projectId, deploymentId: input.deploymentId, workerId: input.workerId,
          authorityMode: 'project', actorUserId, rolloutCohort: 'scope-assignment', requireUnbound: true,
          reason: evidence(op), fileAuthorityReady, verificationEvidence: 'worker-file-roundtrip',
        });
        const result = await client.query(
          `UPDATE project_worker_assignment_desires SET status='active',lease_owner=NULL,lease_expires_at=NULL,
             completed_at=NOW(),updated_at=NOW()
           WHERE project_id=$1 AND deployment_id=$2 AND desired_worker_id=$3 AND status='preparing' AND lease_owner=$4 RETURNING project_id`,
          [...keys, input.workerId, input.leaseOwner]);
        if (result.rows.length !== 1) fail('SCOPE_ASSIGNMENT_COMPLETE_REJECTED');
      });
    },
    async bindingState(op) {
      checkOperation(op);
      try {
        // One MVCC statement: avoid mixed snapshots across separate reads.
        const row = await queryOne<any>(
          `SELECT d.status,d.lease_owner,d.desired_worker_id,d.completed_at,d.last_error,
            b.project_id AS binding_project,b.default_worker_id AS binding_worker,b.workstation_mode AS binding_workstation,b.authority_mode AS binding_authority,
            s.default_worker_id AS settings_worker,s.workstation_mode AS settings_workstation,s.authority_mode AS settings_authority,
            r.status AS rollout_status,r.cohort AS rollout_cohort,r.reason AS rollout_reason
           FROM project_worker_assignment_desires d
           LEFT JOIN project_compute_deployment_bindings b ON b.project_id=d.project_id AND b.deployment_id=d.deployment_id
           LEFT JOIN project_compute_settings s ON s.project_id=d.project_id
           LEFT JOIN runtime_box_workbench_rollouts r ON r.project_id=d.project_id
           WHERE d.project_id=$1 AND d.deployment_id=$2`, keys);
        if (!row || row.desired_worker_id !== input.workerId) return 'ambiguous';
        if (!row.binding_project && row.lease_owner === null && op.terminalIntent
          && row.status === (op.terminalIntent === 'deferred' ? 'pending' : 'failed')
          && row.last_error === terminalEvidence(op, op.terminalIntent)) return op.terminalIntent;
        if (!row.binding_project && row.status === 'preparing' && row.lease_owner === input.leaseOwner) return 'absent';
        if (row.status !== 'active' || row.lease_owner !== null || !row.completed_at || row.binding_project !== input.projectId
          || row.binding_worker !== input.workerId || row.binding_workstation !== true || row.binding_authority !== 'project'
          || row.settings_worker !== input.workerId || row.settings_workstation !== fileAuthorityReady || row.settings_authority !== 'project'
          || row.rollout_status !== 'enabled' || row.rollout_cohort !== 'scope-assignment' || row.rollout_reason !== evidence(op)) return 'ambiguous';
        assertProbe(op); return 'committed';
      } catch { return 'ambiguous'; } // DB errors/response loss cannot authorize rollback
    },
    async finishWithoutBinding(op, result) {
      checkOperation(op); const current = ownedOperation();
      if (current.id !== op.id || current.terminalIntent !== result || current.phase !== 'terminal-intent' || terminalEvidence(current, result) !== terminalEvidence(op, result)) fail('SCOPE_FINISH_PHASE_INVALID');
      await transaction(async client => {
        await lockedDesire(client);
        const binding = await client.query('SELECT project_id FROM project_compute_deployment_bindings WHERE project_id=$1 AND deployment_id=$2', keys);
        if (binding.rows.length) fail('SCOPE_ASSIGNMENT_BINDING_EXISTS');
        const updated = await client.query(
          `UPDATE project_worker_assignment_desires SET status=$5,last_error=$6,lease_owner=NULL,lease_expires_at=NULL,updated_at=NOW()
           WHERE project_id=$1 AND deployment_id=$2 AND desired_worker_id=$3 AND status='preparing' AND lease_owner=$4 RETURNING project_id`,
          [...keys, input.workerId, input.leaseOwner, result === 'deferred' ? 'pending' : 'failed', terminalEvidence(op, result)]);
        if (updated.rows.length !== 1) fail('SCOPE_ASSIGNMENT_FINISH_REJECTED');
      });
    },
  };
  return methods;
}

/** Explicit unwired boundary, not a mock/default implementation. Do not install
 * until real authorized OS/HTTP adapters replace ALL these methods. */
export function withUnwiredScopeRuntime(db: ScopeAssignmentDbMethods): ScopeLifecycleAdapters {
  const unsupported = async (): Promise<never> => fail('SCOPE_RUNTIME_ADAPTER_NOT_CONNECTED');
  return { ...db, authorize: unsupported, observe: unsupported, idle: unsupported, captureHeartbeatEvidence: unsupported, verifyHeartbeat: unsupported, preflightHeartbeatRestore: unsupported, restart: unsupported,
    maintenanceSmoke: unsupported, projectProbe: unsupported, projectExecutionProbe: unsupported, verifyCommittedProbe:unsupported };
}

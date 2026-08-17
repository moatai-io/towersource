import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { query, queryOne, transaction, withClient } from '../../db/pg-repo.js';
import { workbenchToolStoreRoot } from './workbench-tool-store.js';
import { withWorkbenchMutationLock } from './workbench-mutation-lock.js';
import { assertExperimentalWorkbenchToolAccess } from './workbench-tool-experiment-policy.js';
import type { WorkbenchToolCommandActor } from './workbench-tool-commands.js';

export type WorkbenchRecoveryDisposition =
  | 'healthy'
  | 'auto_cleanup_candidate'
  | 'operator_review'
  | 'recovery_required';

type InterruptedStatus = 'reserved' | 'running';
interface RecoveryCommandRow {
  id: string;
  status: InterruptedStatus;
  before_revision: number | null;
  after_revision: number | null;
  started_at: Date | string | null;
  completed_at: Date | string | null;
}

export interface WorkbenchRecoveryInspection {
  projectId: string;
  disposition: WorkbenchRecoveryDisposition;
  health: 'healthy' | 'degraded' | 'recovery_required';
  currentRevision: number | null;
  interruptedCommands: Array<{
    commandId: string;
    status: InterruptedStatus;
    beforeRevision: number | null;
    afterRevision: number | null;
    candidateExists: boolean;
    finalRevisionExists: boolean;
  }>;
  safeCleanupCandidates: string[];
  orphanFinalizedRevisions: number[];
  blockers: string[];
  nextAction: 'none' | 'preview_candidate_cleanup' | 'operator_review' | 'repair_required';
}

export interface WorkbenchRecoveryPreview {
  intentId: string;
  proposalHash: string;
  expiresAt: string;
  projectId: string;
  commandId: string;
  action: 'cleanup-orphan-candidate';
  expectedRevision: number | null;
  expectedCommandStatus: InterruptedStatus;
  impact: { deletesCommandScopedStaging: true; changesActiveRevision: false; preservesCommandEvidence: true };
  warnings: string[];
}

interface RecoveryIntentRow {
  id: string;
  project_id: string;
  command_id: string;
  actor_user_id: number;
  expected_revision: number | null;
  expected_command_status: InterruptedStatus;
  proposal_hash: string;
  consumed_at: string | null;
  status: 'previewed' | 'applying' | 'succeeded' | 'failed' | 'recovery_required';
}

export class WorkbenchRecoveryError extends Error {
  constructor(public readonly code: string, message: string) { super(message); }
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${JSON.stringify(k)}:${stable(v)}`).join(',')}}`;
  return JSON.stringify(value) ?? 'undefined';
}
function digest(value: unknown): string { return createHash('sha256').update(stable(value)).digest('hex'); }
function assertAccess(projectId: string, actor: WorkbenchToolCommandActor): void {
  try { assertExperimentalWorkbenchToolAccess({ projectId, role: actor.role, sessionId: actor.sessionId }); }
  catch (error: any) { throw new WorkbenchRecoveryError(error?.code || 'EXPERIMENT_ACCESS_REFUSED', error?.message || 'Experimental Workbench recovery access refused'); }
}

function commandPaths(projectId: string, command: Pick<RecoveryCommandRow, 'id' | 'after_revision'>) {
  const projectStore = path.resolve(workbenchToolStoreRoot(), 'projects', projectId);
  const candidatePath = path.resolve(projectStore, 'staging', command.id);
  const finalRevisionPath = command.after_revision == null
    ? null
    : path.resolve(projectStore, 'revisions', String(command.after_revision).padStart(6, '0'));
  if (!candidatePath.startsWith(`${projectStore}${path.sep}`)) throw new WorkbenchRecoveryError('STORE_PATH_INVALID', 'Workbench recovery candidate escaped project store');
  return { candidatePath, finalRevisionPath };
}

function listManagedStoreRevisionNumbers(projectId: string): number[] {
  const revisionsRoot = path.resolve(workbenchToolStoreRoot(), 'projects', projectId, 'revisions');
  try {
    return fs.readdirSync(revisionsRoot, { withFileTypes: true })
      .filter(entry => entry.isDirectory() && /^\d{6}$/.test(entry.name))
      .map(entry => Number(entry.name))
      .sort((a, b) => a - b);
  } catch (error: any) {
    if (error?.code === 'ENOENT') return [];
    throw new WorkbenchRecoveryError('STORE_INSPECTION_FAILED', 'Workbench managed revision store cannot be inspected');
  }
}

/** Classify interrupted Workbench mutations without mutating DB or filesystem state. */
export async function inspectWorkbenchToolRecovery(input: {
  projectId: string;
  staleBefore?: Date;
}): Promise<WorkbenchRecoveryInspection> {
  const staleBefore = input.staleBefore ?? new Date(Date.now() - 15 * 60_000);
  const [state] = await query<{
    current_revision: number | null;
    health: 'healthy' | 'degraded' | 'recovery_required';
  }>(
    'SELECT current_revision, health FROM runtime_box_workbench_tool_states WHERE project_id=$1',
    [input.projectId],
  );
  const commands = await query<RecoveryCommandRow>(
    `SELECT id,status,before_revision,after_revision,started_at,completed_at
       FROM runtime_box_workbench_tool_commands
      WHERE project_id=$1
        AND status IN ('reserved','running')
        AND COALESCE(started_at, created_at) <= $2
      ORDER BY created_at ASC`,
    [input.projectId, staleBefore],
  );
  const knownRevisions = await query<{ revision: number }>(
    'SELECT revision FROM runtime_box_workbench_tool_revisions WHERE project_id=$1 ORDER BY revision',
    [input.projectId],
  );
  const knownRevisionSet = new Set(knownRevisions.map(row => Number(row.revision)));
  const orphanFinalizedRevisions = listManagedStoreRevisionNumbers(input.projectId)
    .filter(revision => !knownRevisionSet.has(revision));

  const blockers: string[] = [];
  if (orphanFinalizedRevisions.length > 0) {
    blockers.push(`managed store has finalized revisions without DB ledger rows: ${orphanFinalizedRevisions.join(', ')}`);
  }
  const safeCleanupCandidates: string[] = [];
  const interruptedCommands = commands.map(command => {
    const { candidatePath, finalRevisionPath } = commandPaths(input.projectId, command);
    const candidateExists = fs.existsSync(candidatePath);
    const finalRevisionExists = finalRevisionPath == null ? false : fs.existsSync(finalRevisionPath);
    const currentRevision = state?.current_revision == null ? null : Number(state.current_revision);
    const beforeRevision = command.before_revision == null ? null : Number(command.before_revision);
    const afterRevision = command.after_revision == null ? null : Number(command.after_revision);

    if (finalRevisionExists || (afterRevision != null && currentRevision === afterRevision)) {
      blockers.push(`command ${command.id} may have finalized revision ${afterRevision}; automatic cleanup is forbidden`);
    } else if (currentRevision !== beforeRevision) {
      blockers.push(`command ${command.id} observed current revision ${currentRevision}, expected ${beforeRevision}`);
    } else if (candidateExists) {
      safeCleanupCandidates.push(command.id);
    } else {
      blockers.push(`command ${command.id} has no candidate or final revision evidence`);
    }

    return { commandId: command.id, status: command.status, beforeRevision, afterRevision, candidateExists, finalRevisionExists };
  });

  const health = state?.health ?? 'healthy';
  let disposition: WorkbenchRecoveryDisposition = 'healthy';
  let nextAction: WorkbenchRecoveryInspection['nextAction'] = 'none';
  if (health === 'recovery_required') { disposition = 'recovery_required'; nextAction = 'repair_required'; }
  else if (blockers.length > 0) {
    safeCleanupCandidates.length = 0;
    disposition = 'operator_review';
    nextAction = 'operator_review';
  }
  else if (safeCleanupCandidates.length > 0) { disposition = 'auto_cleanup_candidate'; nextAction = 'preview_candidate_cleanup'; }

  return {
    projectId: input.projectId,
    disposition,
    health,
    currentRevision: state?.current_revision == null ? null : Number(state.current_revision),
    interruptedCommands,
    safeCleanupCandidates,
    orphanFinalizedRevisions,
    blockers,
    nextAction,
  };
}

/** Issue a short-lived approval for exactly one safe orphan candidate cleanup. */
export async function previewWorkbenchToolRecovery(input: {
  projectId: string;
  commandId: string;
  actor: WorkbenchToolCommandActor;
  inspect?: typeof inspectWorkbenchToolRecovery;
}): Promise<WorkbenchRecoveryPreview> {
  assertAccess(input.projectId, input.actor);
  const inspection = await (input.inspect ?? inspectWorkbenchToolRecovery)({ projectId: input.projectId });
  const command = inspection.interruptedCommands.find(item => item.commandId === input.commandId);
  if (inspection.disposition !== 'auto_cleanup_candidate' || !command || !inspection.safeCleanupCandidates.includes(input.commandId)) {
    throw new WorkbenchRecoveryError('CLEANUP_NOT_SAFE', 'Command is not an isolated orphan candidate cleanup target');
  }
  const snapshot = {
    projectId: input.projectId,
    commandId: input.commandId,
    actorUserId: input.actor.userId,
    expectedRevision: inspection.currentRevision,
    expectedCommandStatus: command.status,
    action: 'cleanup-orphan-candidate' as const,
  };
  const proposalHash = digest(snapshot);
  const row = await queryOne<{ id: string; expires_at: string }>(
    `INSERT INTO runtime_box_workbench_recovery_intents
      (project_id,command_id,actor_user_id,actor_session_id,actor_role,expected_revision,expected_command_status,action_kind,inspection_snapshot,proposal_hash,expires_at)
     VALUES($1,$2,$3,$4,$5,$6,$7,'cleanup-orphan-candidate',$8::jsonb,$9,NOW()+INTERVAL '15 minutes')
     RETURNING id,expires_at`,
    [input.projectId, input.commandId, input.actor.userId, input.actor.sessionId ?? null, input.actor.role, inspection.currentRevision, command.status, JSON.stringify(inspection), proposalHash],
  );
  if (!row) throw new WorkbenchRecoveryError('INTENT_CREATE_FAILED', 'Failed to issue Workbench recovery intent');
  return {
    intentId: row.id, proposalHash, expiresAt: row.expires_at,
    projectId: input.projectId, commandId: input.commandId, action: 'cleanup-orphan-candidate',
    expectedRevision: inspection.currentRevision, expectedCommandStatus: command.status,
    impact: { deletesCommandScopedStaging: true, changesActiveRevision: false, preservesCommandEvidence: true },
    warnings: ['Only the exact command-scoped staging directory is deleted.', 'Active revision and immutable finalized revisions are never changed.', 'Apply revalidates the same evidence under the Workbench mutation lock.'],
  };
}

async function loadRecoveryIntent(input: { projectId: string; intentId: string; proposalHash: string; actorUserId: number }): Promise<RecoveryIntentRow> {
  const row = await queryOne<RecoveryIntentRow>(
    `SELECT * FROM runtime_box_workbench_recovery_intents
      WHERE id=$1 AND project_id=$2 AND actor_user_id=$3 AND proposal_hash=$4 AND expires_at>NOW()`,
    [input.intentId, input.projectId, input.actorUserId, input.proposalHash],
  );
  if (!row || row.consumed_at || row.status !== 'previewed') throw new WorkbenchRecoveryError('INTENT_EXPIRED_OR_CONSUMED', 'Valid unused Workbench recovery intent required');
  return row;
}

/** Apply one approved candidate cleanup after exact state revalidation under the mutation lock. */
export async function applyWorkbenchToolRecovery(input: {
  projectId: string;
  intentId: string;
  proposalHash: string;
  confirmed: true;
  actor: WorkbenchToolCommandActor;
  inspect?: typeof inspectWorkbenchToolRecovery;
  removeCandidate?: (candidatePath: string) => Promise<void>;
}): Promise<{ commandId: string; candidateRemoved: true; activeRevisionChanged: false; commandEvidencePreserved: true }> {
  assertAccess(input.projectId, input.actor);
  if (input.confirmed !== true) throw new WorkbenchRecoveryError('CONFIRMATION_REQUIRED', 'Explicit Workbench recovery confirmation is required');
  await loadRecoveryIntent({ projectId: input.projectId, intentId: input.intentId, proposalHash: input.proposalHash, actorUserId: input.actor.userId });

  return withWorkbenchMutationLock(input.projectId, async () => {
    const intent = await loadRecoveryIntent({ projectId: input.projectId, intentId: input.intentId, proposalHash: input.proposalHash, actorUserId: input.actor.userId });
    const inspection = await (input.inspect ?? inspectWorkbenchToolRecovery)({ projectId: input.projectId });
    const command = inspection.interruptedCommands.find(item => item.commandId === intent.command_id);
    if (inspection.currentRevision !== (intent.expected_revision == null ? null : Number(intent.expected_revision))
      || inspection.disposition !== 'auto_cleanup_candidate'
      || !command
      || command.status !== intent.expected_command_status
      || !inspection.safeCleanupCandidates.includes(intent.command_id)) {
      throw new WorkbenchRecoveryError('STALE_RECOVERY_INTENT', 'Workbench recovery evidence changed after preview');
    }

    const consumed = await queryOne<{ id: string }>(
      `UPDATE runtime_box_workbench_recovery_intents SET consumed_at=NOW(),status='applying'
        WHERE id=$1 AND consumed_at IS NULL AND status='previewed' RETURNING id`, [intent.id],
    );
    if (!consumed) throw new WorkbenchRecoveryError('INTENT_CONSUMED', 'Workbench recovery intent was already consumed');
    const { candidatePath } = commandPaths(input.projectId, { id: intent.command_id, after_revision: command.afterRevision });
    try {
      await (input.removeCandidate ?? (candidate => fsp.rm(candidate, { recursive: true, force: false })))(candidatePath);
      const result = { commandId: intent.command_id, candidateRemoved: true as const, activeRevisionChanged: false as const, commandEvidencePreserved: true as const };
      await transaction(async client => {
        const db = withClient(client);
        const commandRow = await db.queryOne(
          `UPDATE runtime_box_workbench_tool_commands
              SET status='failed',error_code='RECOVERED_ORPHAN_CANDIDATE',error_summary='Approved recovery removed orphan command staging; active revision unchanged',completed_at=NOW()
            WHERE id=$1 AND project_id=$2 AND status=$3 RETURNING id`,
          [intent.command_id, input.projectId, intent.expected_command_status],
        );
        if (!commandRow) throw new WorkbenchRecoveryError('COMMAND_STATE_CHANGED', 'Workbench command changed during recovery finalization');
        const intentRow = await db.queryOne(
          `UPDATE runtime_box_workbench_recovery_intents SET status='succeeded',result=$2::jsonb,completed_at=NOW()
            WHERE id=$1 AND status='applying' RETURNING id`, [intent.id, JSON.stringify(result)],
        );
        if (!intentRow) throw new WorkbenchRecoveryError('AUDIT_FINALIZATION_FAILED', 'Workbench recovery audit finalization failed');
      });
      return result;
    } catch (error) {
      await queryOne(
        `UPDATE runtime_box_workbench_recovery_intents SET status='recovery_required',failure_code=$2,result=$3::jsonb,completed_at=NOW()
          WHERE id=$1 AND status='applying' RETURNING id`,
        [intent.id, (error as any)?.code ?? 'CLEANUP_FAILED', JSON.stringify({ message: String((error as Error)?.message ?? error).slice(0, 2000) })],
      ).catch(() => undefined);
      throw error;
    }
  });
}

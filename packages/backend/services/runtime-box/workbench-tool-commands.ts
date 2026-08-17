import { createHash } from 'node:crypto';
import path from 'node:path';
import { getPgPool } from '../../db/pg.js';
import { queryOne, transaction, withClient } from '../../db/pg-repo.js';
import {
  assertSafeToolSpec,
  inspectWorkbenchTools,
  type WorkbenchToolActor,
  type WorkbenchToolManifest,
  type WorkbenchToolSpec,
} from './workbench-tools.js';
import { assertExperimentalWorkbenchToolAccess } from './workbench-tool-experiment-policy.js';
import {
  classifyWorkbenchToolAcquisition,
  type WorkbenchToolAcquisitionDecision,
  type WorkbenchToolAcquisitionRequest,
} from './workbench-tool-acquisition-policy.js';

export type WorkbenchToolAction =
  | { kind: 'install'; manager: 'uv-tool'; tool: WorkbenchToolSpec }
  | { kind: 'import-project-prefix' }
  | { kind: 'rollback'; targetRevision: number };

export interface WorkbenchToolCommandActor extends WorkbenchToolActor {
  userId: number;
  role: string;
}

export interface WorkbenchToolChangePreview {
  intentId: string;
  proposalHash: string;
  expiresAt: string;
  projectId: string;
  currentRevision: number | null;
  runtime: {
    status: 'running' | 'stopped' | 'absent' | 'unknown';
    mountedRevision: number | null;
    recreateRequiredAfterApply: true | false | 'unknown';
  };
  action: WorkbenchToolAction;
  impact: {
    environmentMutation: true;
    credentialsSuppressed: true;
    servicesMayNeedRestart: boolean;
    projectFilesOutsideManagedPrefixChanged: 'not_guaranteed';
  };
  warnings: string[];
  rollback: { available: boolean; targetRevision: number | null };
}

export interface WorkbenchToolCommandDependencies {
  inspect(input: { projectId: string; projectRoot: string }): Promise<{
    dbRevision: number | null;
    filesystemRevision: number | null;
    storageMode?: 'project-prefix' | 'tower-managed-v1' | null;
    runtimeStatus: 'running' | 'stopped' | 'absent' | 'unknown';
    mountedRevision: number | null;
    recreateStatus: 'required' | 'not_required' | 'unknown';
    recreateRequired: boolean | null;
    health: 'healthy' | 'degraded' | 'recovery_required';
    reason: string;
  }>;
  install(input: {
    projectId: string;
    projectRoot: string;
    spec: WorkbenchToolSpec;
    expectedRevision?: number | null;
    actor: WorkbenchToolActor;
  }): Promise<WorkbenchToolManifest>;
  importProjectPrefix(input: {
    projectId: string;
    projectRoot: string;
    expectedRevision: number;
    actor: WorkbenchToolActor;
  }): Promise<WorkbenchToolManifest>;
  rollback(input: {
    projectId: string;
    projectRoot: string;
    targetRevision: number;
    actor: WorkbenchToolActor;
  }): Promise<number>;
}

export interface WorkbenchToolCredentialFreeExec {
  (input: {
    command: string;
    cwd: '/workspace';
    credentialMode: 'none';
    candidateHostPath: string;
    candidateContainerPath: '/workspace/.runtime-box/workbench-tools/active';
    candidateMountMode: 'rw' | 'ro';
  }): Promise<{ exitCode: number; stdout: string; stderr: string }>;
}

/** Adapt Runtime Box exec to the prefix primitive without allowing caller credential or env policy. */
export function createCredentialFreeWorkbenchToolRunner(exec: WorkbenchToolCredentialFreeExec) {
  return async (input: {
    command: string;
    cwd: string;
    credentialFree: true;
    candidateHostPath: string;
    candidateContainerPath: '/workspace/.runtime-box/workbench-tools/active';
    candidateMountMode: 'rw' | 'ro';
  }) => {
    if (input.credentialFree !== true || input.cwd !== '/workspace'
      || input.candidateContainerPath !== '/workspace/.runtime-box/workbench-tools/active'
      || !path.isAbsolute(input.candidateHostPath)) {
      throw new WorkbenchToolCommandError('RUNNER_POLICY_VIOLATION', 'Workbench tool commands require fixed cwd, final projection target, absolute candidate source, and credential suppression');
    }
    return exec({
      command: input.command,
      cwd: '/workspace',
      credentialMode: 'none',
      candidateHostPath: input.candidateHostPath,
      candidateContainerPath: input.candidateContainerPath,
      candidateMountMode: input.candidateMountMode,
    });
  };
}

export class WorkbenchToolCommandError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
  }
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function hash(value: unknown): string {
  return createHash('sha256').update(stable(value)).digest('hex');
}

function assertExperimentAccess(projectId: string, actor: WorkbenchToolCommandActor): void {
  try { assertExperimentalWorkbenchToolAccess({ projectId, role: actor.role, sessionId: actor.sessionId }); }
  catch (error: any) { throw new WorkbenchToolCommandError(error?.code || 'EXPERIMENT_ACCESS_REFUSED', error?.message || 'Experimental Workbench tool access refused'); }
}

function assertAction(action: WorkbenchToolAction): void {
  if (action.kind === 'install') {
    if (action.manager !== 'uv-tool') throw new WorkbenchToolCommandError('INVALID_TOOL_SPEC', 'Unsupported Workbench tool manager');
    try { assertSafeToolSpec(action.tool); }
    catch (error) { throw new WorkbenchToolCommandError('INVALID_TOOL_SPEC', (error as Error).message); }
    return;
  }
  if (action.kind === 'import-project-prefix') return;
  if (!Number.isSafeInteger(action.targetRevision) || action.targetRevision < 1) {
    throw new WorkbenchToolCommandError('INVALID_ROLLBACK_TARGET', 'Rollback target must be a positive revision');
  }
}

export function workbenchToolProposalHash(input: {
  projectId: string;
  actorUserId: number;
  expectedRevision: number | null;
  action: WorkbenchToolAction;
  reason: string;
}): string {
  return hash(input);
}

export interface WorkbenchToolAcquisitionPreview {
  acquisition: WorkbenchToolAcquisitionDecision;
  change: WorkbenchToolChangePreview;
}

/** Translate an AI capability choice into the existing immutable preview/apply contract. */
export async function previewWorkbenchToolAcquisition(input: {
  projectId: string;
  projectRoot: string;
  expectedRevision: number | null;
  request: WorkbenchToolAcquisitionRequest;
  actor: WorkbenchToolCommandActor;
  inspect?: WorkbenchToolCommandDependencies['inspect'];
}): Promise<WorkbenchToolAcquisitionPreview> {
  const acquisition = classifyWorkbenchToolAcquisition(input.request);
  if (acquisition.disposition === 'refused') {
    throw new WorkbenchToolCommandError('ACQUISITION_AUTHORITY_REQUIRED', acquisition.reasons.join(' '));
  }
  const change = await previewWorkbenchToolChange({
    projectId: input.projectId,
    projectRoot: input.projectRoot,
    expectedRevision: input.expectedRevision,
    action: { kind: 'install', manager: 'uv-tool', tool: acquisition.normalizedTool },
    reason: `AI tool acquisition: ${input.request.capability} — ${input.request.purpose.trim()}`,
    actor: input.actor,
    inspect: input.inspect,
  });
  return { acquisition, change };
}

export async function previewWorkbenchToolChange(input: {
  projectId: string;
  projectRoot: string;
  expectedRevision: number | null;
  action: WorkbenchToolAction;
  reason: string;
  actor: WorkbenchToolCommandActor;
  inspect?: WorkbenchToolCommandDependencies['inspect'];
}): Promise<WorkbenchToolChangePreview> {
  assertExperimentAccess(input.projectId, input.actor);
  assertAction(input.action);
  const inspect = input.inspect ?? inspectWorkbenchTools;
  const inspection = await inspect({ projectId: input.projectId, projectRoot: input.projectRoot });
  if (inspection.health === 'recovery_required') {
    throw new WorkbenchToolCommandError('RECOVERY_REQUIRED', inspection.reason);
  }
  if (inspection.dbRevision !== input.expectedRevision) {
    throw new WorkbenchToolCommandError('STALE_REVISION', 'Expected Workbench tool revision is stale');
  }
  if (input.action.kind === 'install' && inspection.storageMode === 'project-prefix' && inspection.dbRevision != null) {
    throw new WorkbenchToolCommandError('LEGACY_IMPORT_REQUIRED', 'Legacy project-prefix state requires an explicit import-project-prefix preview and approval');
  }
  if (input.action.kind === 'import-project-prefix' && (inspection.storageMode !== 'project-prefix' || inspection.dbRevision == null)) {
    throw new WorkbenchToolCommandError('LEGACY_IMPORT_NOT_AVAILABLE', 'No active legacy project-prefix revision is available to import');
  }
  const proposalHash = workbenchToolProposalHash({
    projectId: input.projectId,
    actorUserId: input.actor.userId,
    expectedRevision: input.expectedRevision,
    action: input.action,
    reason: input.reason,
  });
  const row = await queryOne<{ id: string; expires_at: string }>(
    `INSERT INTO runtime_box_workbench_tool_change_intents
      (project_id,actor_user_id,actor_session_id,actor_role,expected_revision,action,reason,proposal_hash,risk,expires_at)
     VALUES($1,$2,$3,$4,$5,$6::jsonb,$7,$8,'high',NOW()+INTERVAL '30 minutes')
     RETURNING id,expires_at`,
    [input.projectId, input.actor.userId, input.actor.sessionId ?? null, input.actor.role, input.expectedRevision, JSON.stringify(input.action), input.reason, proposalHash],
  );
  if (!row) throw new WorkbenchToolCommandError('INTENT_CREATE_FAILED', 'Failed to issue Workbench tool change intent');
  return {
    intentId: row.id,
    proposalHash,
    expiresAt: row.expires_at,
    projectId: input.projectId,
    currentRevision: inspection.dbRevision,
    runtime: {
      status: inspection.runtimeStatus ?? 'unknown',
      mountedRevision: inspection.mountedRevision ?? inspection.filesystemRevision ?? null,
      recreateRequiredAfterApply: inspection.runtimeStatus === 'running'
        ? true
        : inspection.runtimeStatus === 'unknown'
          ? 'unknown'
          : false,
    },
    action: input.action,
    impact: {
      environmentMutation: true,
      credentialsSuppressed: true,
      servicesMayNeedRestart: true,
      projectFilesOutsideManagedPrefixChanged: 'not_guaranteed',
    },
    warnings: [
      'High-risk internal experiment; not approved for production or customer use.',
      'The Project source is mounted read-only and mutation runs in an ephemeral workspace copy.',
      'The candidate managed-store path is mounted as a child bind at the final Runtime target /workspace/.runtime-box/workbench-tools/active, then finalized outside the Project root.',
      'Package hooks and network/index provenance are not isolated or verified.',
      'Vault credential materialization is suppressed, but this does not make the package supply chain safe.',
      'Only command-scoped orphan staging cleanup is automatically recoverable; finalized or pointer ambiguity requires operator review.',
      'Running Runtime and services remain on their mounted revision until a separately approved recreate.',
    ],
    rollback: { available: inspection.dbRevision != null, targetRevision: inspection.dbRevision },
  };
}

interface IntentRow {
  id: string;
  project_id: string;
  actor_user_id: number;
  actor_session_id: string | null;
  expected_revision: number | null;
  action: WorkbenchToolAction;
  reason: string;
  proposal_hash: string;
}

interface CommandRow {
  id: string;
  status: 'reserved' | 'running' | 'succeeded' | 'failed' | 'recovery_required';
  request_hash: string;
  result: unknown;
}

async function withCommandLock<T>(actorUserId: number, idempotencyKey: string, fn: () => Promise<T>): Promise<T> {
  const client = await getPgPool().connect();
  const key = `runtime-box-workbench-tool-command:${actorUserId}:${idempotencyKey}`;
  try {
    await client.query('SELECT pg_advisory_lock(hashtextextended($1,0))', [key]);
    return await fn();
  } finally {
    try { await client.query('SELECT pg_advisory_unlock(hashtextextended($1,0))', [key]); }
    finally { client.release(); }
  }
}

async function reserveCommand(input: {
  projectId: string;
  intentId: string;
  proposalHash: string;
  expectedRevision: number | null;
  idempotencyKey: string;
  actor: WorkbenchToolCommandActor;
}, requestHash: string): Promise<{ command: CommandRow; intent: IntentRow }> {
  return transaction(async client => {
    const db = withClient(client);
    const intent = await db.queryOne<IntentRow>(
      `SELECT * FROM runtime_box_workbench_tool_change_intents
       WHERE id=$1 AND project_id=$2 AND actor_user_id=$3 AND proposal_hash=$4
         AND (expires_at>NOW() OR consumed_by_command_id IS NOT NULL)
       FOR UPDATE`,
      [input.intentId, input.projectId, input.actor.userId, input.proposalHash],
    );
    if (!intent) throw new WorkbenchToolCommandError('INTENT_EXPIRED', 'Valid unexpired Workbench tool change intent required');
    if ((intent.expected_revision == null ? null : Number(intent.expected_revision)) !== input.expectedRevision) {
      throw new WorkbenchToolCommandError('STALE_REVISION', 'Intent expected revision does not match apply request');
    }
    const inserted = await db.queryOne<CommandRow>(
      `INSERT INTO runtime_box_workbench_tool_commands
        (intent_id,project_id,actor_user_id,actor_session_id,idempotency_key,request_hash,action_kind,expected_revision,before_revision)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$8)
       ON CONFLICT(actor_user_id,idempotency_key) DO NOTHING RETURNING *`,
      [intent.id, input.projectId, input.actor.userId, input.actor.sessionId ?? null, input.idempotencyKey, requestHash, intent.action.kind, input.expectedRevision],
    );
    const command = inserted ?? await db.queryOne<CommandRow>(
      'SELECT * FROM runtime_box_workbench_tool_commands WHERE actor_user_id=$1 AND idempotency_key=$2',
      [input.actor.userId, input.idempotencyKey],
    );
    if (!command) throw new WorkbenchToolCommandError('COMMAND_RESERVATION_FAILED', 'Failed to reserve Workbench tool command');
    if (command.request_hash !== requestHash) {
      throw new WorkbenchToolCommandError('IDEMPOTENCY_CONFLICT', 'Idempotency key was already used with a different request');
    }
    const consumed = await db.queryOne<{ id: string }>(
      `UPDATE runtime_box_workbench_tool_change_intents
          SET consumed_at=COALESCE(consumed_at,NOW()),
              consumed_by_command_id=COALESCE(consumed_by_command_id,$2)
        WHERE id=$1 AND (consumed_by_command_id IS NULL OR consumed_by_command_id=$2)
        RETURNING id`,
      [intent.id, command.id],
    );
    if (!consumed) throw new WorkbenchToolCommandError('INTENT_CONSUMED', 'Workbench tool change intent was already consumed');
    const action = intent.action;
    if (!action || typeof action !== 'object' || !['install', 'rollback', 'import-project-prefix'].includes((action as any).kind)) {
      throw new WorkbenchToolCommandError('INVALID_INTENT_ACTION', 'Stored Workbench action is invalid');
    }
    return { command, intent: { ...intent, action } };
  });
}

function commandError(error: unknown): { code: string; summary: string } {
  if (error instanceof WorkbenchToolCommandError) return { code: error.code, summary: error.message.slice(0, 2000) };
  return { code: 'MUTATION_FAILED', summary: String((error as Error)?.message ?? error).slice(0, 2000) };
}

export async function applyWorkbenchToolChange(input: {
  projectId: string;
  projectRoot: string;
  intentId: string;
  proposalHash: string;
  expectedRevision: number | null;
  idempotencyKey: string;
  confirmed: true;
  actor: WorkbenchToolCommandActor;
  dependencies: WorkbenchToolCommandDependencies;
}): Promise<unknown> {
  assertExperimentAccess(input.projectId, input.actor);
  if (input.confirmed !== true) throw new WorkbenchToolCommandError('CONFIRMATION_REQUIRED', 'Explicit confirmation is required');
  const requestHash = hash({
    projectId: input.projectId,
    intentId: input.intentId,
    proposalHash: input.proposalHash,
    expectedRevision: input.expectedRevision,
    actorUserId: input.actor.userId,
  });
  return withCommandLock(input.actor.userId, input.idempotencyKey, async () => {
    const { command, intent } = await reserveCommand(input, requestHash);
    if (command.status === 'succeeded') return command.result;
    if (command.status === 'failed' || command.status === 'recovery_required') {
      throw new WorkbenchToolCommandError('COMMAND_TERMINAL', 'Workbench tool command already reached a terminal failure state');
    }
    const inspection = await input.dependencies.inspect({ projectId: input.projectId, projectRoot: input.projectRoot });
    if (inspection.health === 'recovery_required') {
      await queryOne(
        `UPDATE runtime_box_workbench_tool_commands SET status='recovery_required',error_code='RECOVERY_REQUIRED',error_summary=$2,completed_at=NOW()
         WHERE id=$1 RETURNING id`,
        [command.id, inspection.reason.slice(0, 2000)],
      ).catch(() => undefined);
      throw new WorkbenchToolCommandError('RECOVERY_REQUIRED', inspection.reason);
    }
    if (inspection.dbRevision !== input.expectedRevision) {
      await queryOne(
        `UPDATE runtime_box_workbench_tool_commands SET status='failed',error_code='STALE_REVISION',error_summary=$2,completed_at=NOW()
         WHERE id=$1 RETURNING id`,
        [command.id, 'Workbench tool revision changed after preview'],
      ).catch(() => undefined);
      throw new WorkbenchToolCommandError('STALE_REVISION', 'Workbench tool revision changed after preview');
    }
    await queryOne(`UPDATE runtime_box_workbench_tool_commands SET status='running',started_at=COALESCE(started_at,NOW()) WHERE id=$1 RETURNING id`, [command.id]);
    try {
      let result: unknown;
      if (intent.action.kind === 'install') {
        result = await input.dependencies.install({
          projectId: input.projectId,
          projectRoot: input.projectRoot,
          spec: intent.action.tool,
          expectedRevision: intent.expected_revision == null ? null : Number(intent.expected_revision),
          actor: { userId: input.actor.userId, sessionId: input.actor.sessionId, jobId: command.id },
        });
      } else if (intent.action.kind === 'import-project-prefix') {
        if (intent.expected_revision == null) throw new WorkbenchToolCommandError('LEGACY_IMPORT_NOT_AVAILABLE', 'Legacy import requires an active source revision');
        result = await input.dependencies.importProjectPrefix({
          projectId: input.projectId,
          projectRoot: input.projectRoot,
          expectedRevision: Number(intent.expected_revision),
          actor: { userId: input.actor.userId, sessionId: input.actor.sessionId, jobId: command.id },
        });
      } else {
        result = { revision: await input.dependencies.rollback({
          projectId: input.projectId,
          projectRoot: input.projectRoot,
          targetRevision: intent.action.targetRevision,
          actor: { userId: input.actor.userId, sessionId: input.actor.sessionId, jobId: command.id },
        }) };
      }
      const inspectionAfter = await input.dependencies.inspect({ projectId: input.projectId, projectRoot: input.projectRoot });
      const revision = (result as any)?.revision ?? null;
      const commandResult = {
        revision,
        manifest: intent.action.kind === 'install' ? result : undefined,
        activation: 'pointer_updated',
        runtime: {
          changed: false,
          status: inspectionAfter.runtimeStatus ?? 'unknown',
          mountedRevision: inspectionAfter.mountedRevision ?? inspectionAfter.filesystemRevision ?? null,
          currentRevision: inspectionAfter.dbRevision,
          recreateStatus: inspectionAfter.recreateStatus ?? 'unknown',
          recreateRequired: inspectionAfter.recreateRequired ?? null,
        },
        nextAction: (inspectionAfter.recreateStatus === 'required' || inspectionAfter.recreateRequired === true) ? 'preview_runtime_recreate' : null,
      };
      await queryOne(
        `UPDATE runtime_box_workbench_tool_commands SET status='succeeded',after_revision=$2,result=$3::jsonb,completed_at=NOW()
         WHERE id=$1 RETURNING id`,
        [command.id, revision, JSON.stringify(commandResult)],
      );
      return commandResult;
    } catch (error) {
      const inspectionAfter = await input.dependencies.inspect({ projectId: input.projectId, projectRoot: input.projectRoot }).catch(() => null);
      const details = commandError(error);
      const status = inspectionAfter?.health === 'recovery_required' ? 'recovery_required' : 'failed';
      await queryOne(
        `UPDATE runtime_box_workbench_tool_commands SET status=$2,error_code=$3,error_summary=$4,completed_at=NOW()
         WHERE id=$1 RETURNING id`,
        [command.id, status, details.code, details.summary],
      ).catch(() => undefined);
      throw error;
    }
  });
}

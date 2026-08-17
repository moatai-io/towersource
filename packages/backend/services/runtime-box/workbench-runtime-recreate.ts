// Owns: A4b-minimal explicit preview/apply for one exact Runtime recreate.
// Public API: previewWorkbenchRuntimeRecreate, applyWorkbenchRuntimeRecreate. See runtime-box/README.md.

import { createHash } from 'node:crypto';
import { query, queryOne, execute } from '../../db/pg-repo.js';
import {
  execInBoxWithActivityLockHeld,
  recreateRuntimeBoxExactWithLocksHeld,
  type RuntimeBoxExactRecreateAudit,
} from './runtime-box-manager.js';
import {
  probeRuntimeBoxActivity,
  tryWithRuntimeBoxActivityLock,
  type RuntimeBoxActivityEvidence,
} from './runtime-box-activity-lock.js';
import { withRuntimeBoxLifecycleLock } from './runtime-box-lifecycle-lock.js';
import { withWorkbenchMutationLock } from './workbench-mutation-lock.js';
import { inspectWorkbenchTools, type WorkbenchToolInspection, type WorkbenchToolManifest } from './workbench-tools.js';
import type { BoxRow, ServiceRow } from './types.js';
import { queryBoxOne } from './runtime-box-row-repository.js';
import { normalizeRuntimeBoxId, normalizeRuntimeBoxServiceId } from './runtime-box-row-normalization.js';
import type { WorkbenchToolCommandActor } from './workbench-tool-commands.js';
import { assertExperimentalWorkbenchToolAccess } from './workbench-tool-experiment-policy.js';

export class WorkbenchRuntimeRecreateError extends Error {
  constructor(public readonly code: string, message: string) { super(message); }
}

type ImpactService = Pick<ServiceRow, 'id' | 'name' | 'status' | 'pinned' | 'internal_port' | 'host_port' | 'process_pid' | 'command'>;
interface RawImpactService extends Omit<ImpactService, 'id'> { id: unknown; }
interface RecreateSnapshot {
  box: Pick<BoxRow, 'id' | 'project_id' | 'status' | 'container_id' | 'last_active_at'>;
  services: ImpactService[];
  inspection: WorkbenchToolInspection;
  targetManifest: WorkbenchToolManifest;
  targetState: string;
}
export interface WorkbenchRuntimeRecreateDependencies {
  snapshot(projectId: string, projectRoot: string): Promise<RecreateSnapshot>;
  activity(boxId: number): Promise<RuntimeBoxActivityEvidence>;
  recreate(input: { boxId: number; projectId: string; expectedContainerId: string; activity: Parameters<typeof recreateRuntimeBoxExactWithLocksHeld>[0]['activity']; lifecycle: Parameters<typeof recreateRuntimeBoxExactWithLocksHeld>[0]['lifecycle']; onDestructiveStart: () => void }): Promise<{ box: BoxRow; audit: RuntimeBoxExactRecreateAudit }>;
  smoke(input: { boxId: number; userId: number; manifest: WorkbenchToolManifest; activity: Parameters<typeof execInBoxWithActivityLockHeld>[1] }): Promise<Array<{ command: string; exitCode: number }>>;
}
export interface WorkbenchRuntimeRecreatePreview {
  intentId: string;
  proposalHash: string;
  expiresAt: string;
  projectId: string;
  revisions: { current: number; mounted: number; target: number };
  runtime: { boxId: number; status: 'running'; containerId: string; lastActivityAt: string | null };
  activity: RuntimeBoxActivityEvidence;
  services: { runningCount: number; affected: Array<{ id: number; name: string; status: string; pinned: boolean; internalPort: number | null; hostPort: number | null; processPid: number | null }> };
  processesInterrupted: Array<{ kind: 'service'; serviceId: number; name: string; pid: number | null }>;
  containerProcessImpact: { scope: 'all-processes-in-container'; registeredServicesListed: number; unregisteredProcesses: 'unknown'; warning: string };
  applyPolicy: { explicitConfirmationRequired: true; serviceImpactAcknowledgementRequired: boolean; automaticServiceRestart: false };
  postRecreateSmoke: string[];
  warnings: string[];
}
interface RecreateIntentRow {
  id: string;
  project_id: string;
  box_id: number;
  actor_user_id: number;
  current_revision: number;
  mounted_revision: number;
  target_revision: number;
  container_id: string;
  service_snapshot: ImpactService[];
  activity_snapshot: RuntimeBoxActivityEvidence;
  runtime_snapshot: Record<string, unknown>;
  proposal_hash: string;
  expires_at: string;
  consumed_at: string | null;
  status: 'previewed' | 'applying' | 'succeeded' | 'failed' | 'recovery_required';
  stage: string;
  result: unknown;
}

interface RawRecreateIntentRow extends Omit<RecreateIntentRow, 'box_id'> { box_id: unknown; }
function normalizeRecreateIntentRow(row: RawRecreateIntentRow): RecreateIntentRow {
  return { ...row, box_id: normalizeRuntimeBoxId(row.box_id) };
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${JSON.stringify(k)}:${stable(v)}`).join(',')}}`;
  return JSON.stringify(value) ?? 'undefined';
}
function digest(value: unknown): string { return createHash('sha256').update(stable(value)).digest('hex'); }
function serviceImpact(services: Array<ImpactService | RawImpactService>) {
  return services.map((service: any) => ({
    id: normalizeRuntimeBoxServiceId(service.id), name: service.name, status: service.status, pinned: service.pinned,
    internal_port: service.internal_port == null ? null : Number(service.internal_port),
    host_port: service.host_port == null ? null : Number(service.host_port),
    process_pid: service.process_pid == null ? null : Number(service.process_pid), command: service.command,
  })).sort((a, b) => a.id - b.id);
}
function assertAccess(projectId: string, actor: WorkbenchToolCommandActor): void {
  try { assertExperimentalWorkbenchToolAccess({ projectId, role: actor.role, sessionId: actor.sessionId }); }
  catch (error: any) { throw new WorkbenchRuntimeRecreateError(error?.code || 'EXPERIMENT_ACCESS_REFUSED', error?.message || 'Experimental Workbench access refused'); }
}
function assertSafeSnapshot(snapshot: RecreateSnapshot): { current: number; mounted: number; containerId: string } {
  const { inspection, box } = snapshot;
  if (inspection.health === 'recovery_required') throw new WorkbenchRuntimeRecreateError('RECOVERY_REQUIRED', inspection.reason);
  if (inspection.storageMode !== 'tower-managed-v1' || inspection.dbRevision == null || !['active', 'rollback'].includes(snapshot.targetState)) {
    throw new WorkbenchRuntimeRecreateError('TARGET_NOT_FINALIZED', 'Target must be the current finalized managed Workbench revision');
  }
  if (box.status !== 'running' || !box.container_id) throw new WorkbenchRuntimeRecreateError('RUNTIME_NOT_RUNNING', 'Runtime must be running to recreate');
  if (inspection.runtimeStatus !== 'running' || inspection.projectionStatus !== 'mounted' || inspection.mountedRevision == null) {
    throw new WorkbenchRuntimeRecreateError('PROJECTION_UNKNOWN', 'Runtime projection must be known and mounted before recreate');
  }
  if (inspection.recreateRequired !== true || inspection.mountedRevision === inspection.dbRevision) {
    throw new WorkbenchRuntimeRecreateError('RECREATE_NOT_REQUIRED', 'Runtime already mounts the current managed revision');
  }
  if (snapshot.targetManifest.revision !== inspection.dbRevision) throw new WorkbenchRuntimeRecreateError('TARGET_NOT_FINALIZED', 'Target manifest is not current');
  return { current: inspection.dbRevision, mounted: inspection.mountedRevision, containerId: box.container_id };
}
async function defaultSnapshot(projectId: string, projectRoot: string): Promise<RecreateSnapshot> {
  const [box, inspection, revision] = await Promise.all([
    queryBoxOne('SELECT * FROM project_runtime_boxes WHERE project_id=$1', [projectId]),
    inspectWorkbenchTools({ projectId, projectRoot }),
    queryOne<{ state: string; manifest: WorkbenchToolManifest }>(`SELECT r.state,r.manifest FROM runtime_box_workbench_tool_states s JOIN runtime_box_workbench_tool_revisions r ON r.project_id=s.project_id AND r.revision=s.current_revision WHERE s.project_id=$1`, [projectId]),
  ]);
  if (!box) throw new WorkbenchRuntimeRecreateError('RUNTIME_ABSENT', 'Runtime Box is absent');
  const rawServices = await query<RawImpactService & { project_id: string }>(
    `SELECT id,project_id,name,status,pinned,internal_port,host_port,process_pid,command
       FROM runtime_box_services
      WHERE box_id=$1 AND status IN ('running','pending') ORDER BY id`,
    [box.id],
  );
  if (rawServices.some(service => service.project_id !== projectId)) {
    throw new WorkbenchRuntimeRecreateError('SERVICE_IDENTITY_MISMATCH', 'Runtime Service project does not match the exact Runtime Box project');
  }
  const services = serviceImpact(rawServices);
  if (!revision) throw new WorkbenchRuntimeRecreateError('TARGET_NOT_FINALIZED', 'Current finalized managed revision is absent');
  return { box, services, inspection, targetManifest: revision.manifest, targetState: revision.state };
}
async function defaultSmoke(input: { boxId: number; userId: number; manifest: WorkbenchToolManifest; activity: Parameters<typeof execInBoxWithActivityLockHeld>[1] }) {
  const commands = [...new Set(input.manifest.tools.flatMap(tool => tool.entrypoints))]
    .map(entrypoint => `${JSON.stringify(`/workspace/.runtime-box/workbench-tools/active/bin/${entrypoint}`)} --version`);
  const results: Array<{ command: string; exitCode: number }> = [];
  for (const command of commands) {
    const result = await execInBoxWithActivityLockHeld({ boxId: input.boxId, userId: input.userId, cmd: command, cwd: '/workspace', credentialMode: 'none' }, input.activity);
    results.push({ command, exitCode: result.exit_code });
    if (result.exit_code !== 0) throw new WorkbenchRuntimeRecreateError('ENTRYPOINT_SMOKE_FAILED', `Post-recreate smoke failed: ${command}`);
  }
  return results;
}
export const defaultWorkbenchRuntimeRecreateDependencies: WorkbenchRuntimeRecreateDependencies = {
  snapshot: defaultSnapshot,
  activity: probeRuntimeBoxActivity,
  recreate: recreateRuntimeBoxExactWithLocksHeld,
  smoke: defaultSmoke,
};

export async function previewWorkbenchRuntimeRecreate(input: { projectId: string; projectRoot: string; actor: WorkbenchToolCommandActor; dependencies?: WorkbenchRuntimeRecreateDependencies }): Promise<WorkbenchRuntimeRecreatePreview> {
  assertAccess(input.projectId, input.actor);
  const dependencies = input.dependencies ?? defaultWorkbenchRuntimeRecreateDependencies;
  const snapshot = await dependencies.snapshot(input.projectId, input.projectRoot);
  const safe = assertSafeSnapshot(snapshot);
  const activity = await dependencies.activity(Number(snapshot.box.id));
  if (activity.status === 'active') throw new WorkbenchRuntimeRecreateError('ACTIVE_EXECUTION', 'Runtime Box has an active execution');
  if (activity.status === 'unknown') throw new WorkbenchRuntimeRecreateError('ACTIVITY_UNKNOWN', activity.reason);
  const services = serviceImpact(snapshot.services);
  const runtimeSnapshot = { boxId: snapshot.box.id, status: snapshot.box.status, containerId: safe.containerId, lastActivityAt: snapshot.box.last_active_at, currentRevision: safe.current, mountedRevision: safe.mounted, targetRevision: safe.current, projectionStatus: snapshot.inspection.projectionStatus };
  const proposalHash = digest({ projectId: input.projectId, actorUserId: input.actor.userId, runtimeSnapshot, services, activity });
  const row = await queryOne<{ id: string; expires_at: string }>(`INSERT INTO runtime_box_workbench_runtime_recreate_intents
    (project_id,box_id,actor_user_id,actor_session_id,actor_role,current_revision,mounted_revision,target_revision,container_id,service_snapshot,activity_snapshot,runtime_snapshot,proposal_hash,expires_at)
    VALUES($1,$2,$3,$4,$5,$6,$7,$6,$8,$9::jsonb,$10::jsonb,$11::jsonb,$12,NOW()+INTERVAL '15 minutes') RETURNING id,expires_at`,
  [input.projectId, snapshot.box.id, input.actor.userId, input.actor.sessionId ?? null, input.actor.role, safe.current, safe.mounted, safe.containerId, JSON.stringify(services), JSON.stringify(activity), JSON.stringify(runtimeSnapshot), proposalHash]);
  if (!row) throw new WorkbenchRuntimeRecreateError('INTENT_CREATE_FAILED', 'Failed to issue Runtime recreate intent');
  const smoke = [...new Set(snapshot.targetManifest.tools.flatMap(tool => tool.entrypoints))].map(entrypoint => `${entrypoint} --version`);
  return {
    intentId: row.id, proposalHash, expiresAt: row.expires_at, projectId: input.projectId,
    revisions: { current: safe.current, mounted: safe.mounted, target: safe.current },
    runtime: { boxId: Number(snapshot.box.id), status: 'running', containerId: safe.containerId, lastActivityAt: snapshot.box.last_active_at }, activity,
    services: { runningCount: services.length, affected: services.map(s => ({ id: s.id, name: s.name, status: s.status, pinned: s.pinned, internalPort: s.internal_port, hostPort: s.host_port, processPid: s.process_pid })) },
    processesInterrupted: services.map(s => ({ kind: 'service', serviceId: s.id, name: s.name, pid: s.process_pid })),
    containerProcessImpact: { scope: 'all-processes-in-container', registeredServicesListed: services.length, unregisteredProcesses: 'unknown', warning: 'Recreate stops the whole container; unregistered processes cannot be enumerated reliably.' },
    applyPolicy: { explicitConfirmationRequired: true, serviceImpactAcknowledgementRequired: services.length > 0, automaticServiceRestart: false },
    postRecreateSmoke: ['Runtime running', `projection mounted revision ${safe.current}`, ...smoke],
    warnings: ['The exact current Runtime container will be stopped and removed.', 'Services stop and do not restart automatically.', 'A4b-minimal assumes the server process and database remain available; crash recovery is a later seam.'],
  };
}

async function loadIntent(input: { projectId: string; intentId: string; proposalHash: string; actorUserId: number }): Promise<RecreateIntentRow> {
  const rawIntent = await queryOne<RawRecreateIntentRow>(`SELECT * FROM runtime_box_workbench_runtime_recreate_intents WHERE id=$1 AND project_id=$2 AND actor_user_id=$3 AND proposal_hash=$4 AND expires_at>NOW()`, [input.intentId, input.projectId, input.actorUserId, input.proposalHash]);
  const intent = rawIntent ? normalizeRecreateIntentRow(rawIntent) : undefined;
  if (!intent || intent.consumed_at || intent.status !== 'previewed') throw new WorkbenchRuntimeRecreateError('INTENT_EXPIRED_OR_CONSUMED', 'Valid unused Runtime recreate intent required');
  return intent;
}
async function markIntentApplying(id: string): Promise<boolean> {
  return Boolean(await queryOne(`UPDATE runtime_box_workbench_runtime_recreate_intents SET consumed_at=NOW(),status='applying',stage='validated',audit_result=$2::jsonb WHERE id=$1 AND consumed_at IS NULL AND status='previewed' RETURNING id`, [id, JSON.stringify({ exactSnapshotRevalidated: true })]));
}
async function recordOutcome(id: string, status: 'succeeded' | 'failed' | 'recovery_required', stage: string, failureCode: string | null, audit: unknown, result: unknown): Promise<void> {
  const row = await queryOne(`UPDATE runtime_box_workbench_runtime_recreate_intents SET status=$2,stage=$3,failure_code=$4,audit_result=$5::jsonb,result=$6::jsonb,completed_at=NOW() WHERE id=$1 AND status='applying' RETURNING id`, [id, status, stage, failureCode, JSON.stringify(audit), JSON.stringify(result)]);
  if (!row) throw new WorkbenchRuntimeRecreateError('AUDIT_FINALIZATION_FAILED', 'Runtime recreate audit finalization failed');
}

async function markPostDestructiveRecoveryRequired(boxId: number, reason: string): Promise<void> {
  const box = await execute(`UPDATE project_runtime_boxes SET status='error',last_error=$2,error_at=NOW(),updated_at=NOW() WHERE id=$1`, [boxId, reason.slice(0, 2000)]);
  if (box.changes !== 1) throw new WorkbenchRuntimeRecreateError('AUDIT_FINALIZATION_FAILED', 'Failed to mark Runtime Box error after destructive recreate failure');
  await execute(`UPDATE runtime_box_workbench_tool_projections SET status='recovery_required',updated_at=NOW() WHERE box_id=$1`, [boxId]);
}

export async function applyWorkbenchRuntimeRecreate(input: { projectId: string; projectRoot: string; intentId: string; proposalHash: string; confirmed: true; serviceImpactAcknowledged: boolean; actor: WorkbenchToolCommandActor; dependencies?: WorkbenchRuntimeRecreateDependencies }): Promise<unknown> {
  assertAccess(input.projectId, input.actor);
  if (input.confirmed !== true) throw new WorkbenchRuntimeRecreateError('CONFIRMATION_REQUIRED', 'Explicit Runtime recreate confirmation is required');
  const dependencies = input.dependencies ?? defaultWorkbenchRuntimeRecreateDependencies;
  const initial = await loadIntent({ projectId: input.projectId, intentId: input.intentId, proposalHash: input.proposalHash, actorUserId: input.actor.userId });
  if ((initial.service_snapshot ?? []).length > 0 && !input.serviceImpactAcknowledged) {
    throw new WorkbenchRuntimeRecreateError('SERVICE_IMPACT_ACK_REQUIRED', 'Separate service impact acknowledgement is required');
  }

  return withWorkbenchMutationLock(input.projectId, async () => {
    const intent = await loadIntent({ projectId: input.projectId, intentId: input.intentId, proposalHash: input.proposalHash, actorUserId: input.actor.userId });
    if ((intent.service_snapshot ?? []).length > 0 && !input.serviceImpactAcknowledged) {
      throw new WorkbenchRuntimeRecreateError('SERVICE_IMPACT_ACK_REQUIRED', 'Separate service impact acknowledgement is required');
    }

    const activityAttempt = await tryWithRuntimeBoxActivityLock(Number(intent.box_id), async activity => {
      let safe!: ReturnType<typeof assertSafeSnapshot>;
      let before!: RecreateSnapshot;
      let recreated!: Awaited<ReturnType<WorkbenchRuntimeRecreateDependencies['recreate']>>;
      let after!: RecreateSnapshot;
      let destructiveStarted = false;

      try {
        await withRuntimeBoxLifecycleLock(Number(intent.box_id), async lifecycle => {
          before = await dependencies.snapshot(input.projectId, input.projectRoot);
          try { safe = assertSafeSnapshot(before); }
          catch (error) {
            if (['TARGET_NOT_FINALIZED', 'RECREATE_NOT_REQUIRED'].includes((error as any)?.code)) {
              throw new WorkbenchRuntimeRecreateError('STALE_INTENT', `Runtime target changed before destructive action: ${(error as Error).message}`);
            }
            throw error;
          }
          const services = serviceImpact(before.services);
          const stale = [
            Number(before.box.id) !== Number(intent.box_id) ? 'box' : null,
            safe.containerId !== intent.container_id ? 'container' : null,
            safe.current !== Number(intent.current_revision) ? 'current' : null,
            safe.mounted !== Number(intent.mounted_revision) ? 'mounted' : null,
            safe.current !== Number(intent.target_revision) ? 'target' : null,
            before.targetManifest.revision !== Number(intent.target_revision) ? 'finalized-manifest' : null,
            !['active', 'rollback'].includes(before.targetState) ? 'finalized-state' : null,
            digest(services) !== digest(serviceImpact(intent.service_snapshot ?? [])) ? 'services' : null,
          ].filter(Boolean);
          if (stale.length) throw new WorkbenchRuntimeRecreateError('STALE_INTENT', `Runtime snapshot changed before destructive action (${stale.join(',')})`);
          if (!await markIntentApplying(intent.id)) {
            throw new WorkbenchRuntimeRecreateError('INTENT_EXPIRED_OR_CONSUMED', 'Runtime recreate intent was consumed concurrently');
          }

          recreated = await dependencies.recreate({
            boxId: Number(before.box.id),
            projectId: input.projectId,
            expectedContainerId: safe.containerId,
            activity,
            lifecycle,
            onDestructiveStart: () => { destructiveStarted = true; },
          });
          after = await dependencies.snapshot(input.projectId, input.projectRoot);
          if (after.inspection.health !== 'healthy' || after.inspection.runtimeStatus !== 'running'
            || after.inspection.projectionStatus !== 'mounted' || after.inspection.mountedRevision !== safe.current
            || after.inspection.dbRevision !== safe.current || after.inspection.recreateRequired !== false) {
            throw new WorkbenchRuntimeRecreateError('POST_RECREATE_PROJECTION_FAILED', `Post-recreate projection verification failed: ${after.inspection.reason}`);
          }
          const stillRunning = after.services.filter(service => service.status === 'running' || service.status === 'pending');
          if (stillRunning.length) throw new WorkbenchRuntimeRecreateError('SERVICE_AUTO_RESTART_DETECTED', 'Service registry indicates automatic restart');
        });

        const smoke = await dependencies.smoke({ boxId: Number(recreated.box.id), userId: input.actor.userId, manifest: after.targetManifest, activity });
        const result = {
          ok: true,
          revisions: { previousMounted: safe.mounted, current: safe.current, mounted: after.inspection.mountedRevision },
          runtime: { boxId: Number(recreated.box.id), status: recreated.box.status, previousContainerId: safe.containerId, containerId: recreated.box.container_id },
          lifecycleAudit: recreated.audit,
          services: { interrupted: intent.service_snapshot, autoRestarted: false, registryStatus: 'stopped' },
          smoke,
        };
        await recordOutcome(intent.id, 'succeeded', 'smoke-complete', null, { projection: 'mounted-current', servicesAutoRestarted: false, smoke: 'passed' }, result);
        return result;
      } catch (error) {
        const code = (error as any)?.code ?? 'RECREATE_FAILED';
        const currentIntent = await queryOne<Pick<RecreateIntentRow, 'status'>>('SELECT status FROM runtime_box_workbench_runtime_recreate_intents WHERE id=$1', [intent.id]);
        if (currentIntent?.status === 'applying') {
          const status = destructiveStarted ? 'recovery_required' : 'failed';
          if (destructiveStarted) await markPostDestructiveRecoveryRequired(Number(intent.box_id), `${code}: ${(error as Error).message}`);
          await recordOutcome(intent.id, status, destructiveStarted ? 'recreate' : 'validated', code, { destructiveStarted, error: (error as Error).message.slice(0, 1000) }, { ok: false });
        }
        throw error;
      }
    });

    if (!activityAttempt.acquired) {
      throw new WorkbenchRuntimeRecreateError('ACTIVE_EXECUTION', 'Runtime Box has an active execution; intent remains unused');
    }
    return activityAttempt.value;
  });
}

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { queryOne, execute } from '../../db/pg-repo.js';
import {
  applyWorkbenchRuntimeRecreate,
  previewWorkbenchRuntimeRecreate,
  WorkbenchRuntimeRecreateError,
  type WorkbenchRuntimeRecreateDependencies,
} from './workbench-runtime-recreate.js';

vi.mock('../../db/pg-repo.js', () => ({ query: vi.fn(), queryOne: vi.fn(), execute: vi.fn(), transaction: vi.fn(), withClient: vi.fn() }));
vi.mock('./runtime-box-manager.js', () => ({ execInBoxWithActivityLockHeld: vi.fn(), recreateRuntimeBoxExactWithLocksHeld: vi.fn() }));
vi.mock('./runtime-box-activity-lock.js', () => ({ probeRuntimeBoxActivity: vi.fn(), tryWithRuntimeBoxActivityLock: vi.fn(async (_boxId: number, fn: (held: object) => Promise<unknown>) => ({ acquired: true, value: await fn({}) })) }));
vi.mock('./runtime-box-lifecycle-lock.js', () => ({ withRuntimeBoxLifecycleLock: vi.fn(async (_boxId: number, fn: (held: object) => Promise<unknown>) => fn({})) }));
vi.mock('./workbench-mutation-lock.js', () => ({ withWorkbenchMutationLock: vi.fn(async (_projectId: string, fn: (held: object) => Promise<unknown>) => fn({})) }));
vi.mock('./workbench-tools.js', () => ({ inspectWorkbenchTools: vi.fn() }));

const actor = { userId: 7, role: 'operator', sessionId: 'session-a' };
const manifest: any = { revision: 2, tools: [{ name: 'ruff', version: '1', entrypoints: ['ruff'] }] };
const box: any = { id: 10, project_id: 'project-a', status: 'running', container_id: 'container-old', last_active_at: '2026-07-31T00:00:00Z' };
const service: any = { id: 20, name: 'api', status: 'running', pinned: true, internal_port: 8000, host_port: null, process_pid: 123, command: 'api' };
const inspection: any = {
  projectId: 'project-a', dbRevision: 2, filesystemRevision: 1, storageMode: 'tower-managed-v1', health: 'healthy', reason: 'recreate required',
  runtimeStatus: 'running', projectionStatus: 'mounted', mountedRevision: 1, recreateStatus: 'required', recreateRequired: true,
};
function intentRow() {
  return { id: 'i', project_id: 'project-a', box_id: 10, actor_user_id: 7, current_revision: 2, mounted_revision: 1, target_revision: 2, container_id: 'container-old', service_snapshot: [service], activity_snapshot: { status: 'inactive', activeExecutions: 0, evidence: 'activity-advisory-lock' }, runtime_snapshot: {}, proposal_hash: 'a'.repeat(64), expires_at: '2099-01-01', consumed_at: null, status: 'previewed', stage: 'previewed', audit_result: {}, result: null };
}

function deps(overrides: Partial<WorkbenchRuntimeRecreateDependencies> = {}): WorkbenchRuntimeRecreateDependencies {
  return {
    snapshot: vi.fn().mockResolvedValue({ box, services: [service], inspection, targetManifest: manifest, targetState: 'active' }),
    activity: vi.fn().mockResolvedValue({ status: 'inactive', activeExecutions: 0, evidence: 'activity-advisory-lock' }),
    recreate: vi.fn().mockResolvedValue({ box: { ...box, container_id: 'container-new' }, audit: { stage: 'complete' } }),
    smoke: vi.fn().mockResolvedValue([{ command: 'ruff --version', exitCode: 0 }]),
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('TOWER_EXPERIMENTAL_WORKBENCH_TOOLS_ENABLED', 'true');
  vi.stubEnv('TOWER_EXPERIMENTAL_WORKBENCH_TOOL_PROJECT_IDS', JSON.stringify(['project-a']));
  vi.mocked(execute).mockResolvedValue({ changes: 1 });
  vi.mocked(queryOne).mockImplementation(async (sql: string) => {
    if (sql.includes('SELECT * FROM runtime_box_workbench_runtime_recreate_intents')) return intentRow() as any;
    if (sql.includes("SET consumed_at=NOW()")) return { id: 'i' } as any;
    if (sql.includes('SELECT status FROM runtime_box_workbench_runtime_recreate_intents')) return { status: 'applying' } as any;
    if (sql.includes('UPDATE runtime_box_workbench_runtime_recreate_intents')) return { id: 'i', consumed_at: '2026-08-01T00:00:00Z' } as any;
    return { id: 'intent-a', expires_at: '2026-08-01T00:00:00Z' } as any;
  });
});

describe('Workbench Runtime recreate orchestration', () => {
  it('previews exact revisions, service/process impact, activity evidence, and no auto restart', async () => {
    const preview = await previewWorkbenchRuntimeRecreate({ projectId: 'project-a', projectRoot: '/p', actor, dependencies: deps() });
    expect(preview.revisions).toEqual({ current: 2, mounted: 1, target: 2 });
    expect(preview.services).toMatchObject({ runningCount: 1, affected: [{ name: 'api', pinned: true, internalPort: 8000 }] });
    expect(preview.processesInterrupted).toEqual([{ kind: 'service', serviceId: 20, name: 'api', pid: 123 }]);
    expect(preview.containerProcessImpact).toMatchObject({ scope: 'all-processes-in-container', unregisteredProcesses: 'unknown' });
    expect(preview.applyPolicy).toEqual({ explicitConfirmationRequired: true, serviceImpactAcknowledgementRequired: true, automaticServiceRestart: false });
    expect(preview.postRecreateSmoke).toContain('ruff --version');
  });

  it.each([
    ['active', { status: 'active', activeExecutions: 1, evidence: 'activity-advisory-lock' }, 'ACTIVE_EXECUTION'],
    ['unknown', { status: 'unknown', activeExecutions: null, evidence: 'activity-advisory-lock', reason: 'probe failed' }, 'ACTIVITY_UNKNOWN'],
  ])('rejects %s activity during preview', async (_name, activity: any, code) => {
    await expect(previewWorkbenchRuntimeRecreate({ projectId: 'project-a', projectRoot: '/p', actor, dependencies: deps({ activity: vi.fn().mockResolvedValue(activity) }) }))
      .rejects.toMatchObject({ code });
  });

  it.each([
    [{ ...inspection, health: 'recovery_required' }, 'RECOVERY_REQUIRED'],
    [{ ...inspection, projectionStatus: 'recovery_required', recreateRequired: null }, 'PROJECTION_UNKNOWN'],
    [{ ...inspection, dbRevision: 3 }, 'TARGET_NOT_FINALIZED'],
  ])('rejects recovery/unknown/non-current target', async (badInspection, code) => {
    const dependencies = deps({ snapshot: vi.fn().mockResolvedValue({ box, services: [], inspection: badInspection, targetManifest: manifest, targetState: 'active' }) });
    await expect(previewWorkbenchRuntimeRecreate({ projectId: 'project-a', projectRoot: '/p', actor, dependencies })).rejects.toMatchObject({ code });
  });

  it('rejects apply without explicit confirmation', async () => {
    await expect(applyWorkbenchRuntimeRecreate({ projectId: 'project-a', projectRoot: '/p', intentId: 'i', proposalHash: 'a'.repeat(64), confirmed: false as true, serviceImpactAcknowledged: false, actor, dependencies: deps() }))
      .rejects.toMatchObject({ code: 'CONFIRMATION_REQUIRED' });
  });

  it('requires separate service acknowledgement without consuming intent', async () => {
    vi.mocked(queryOne).mockResolvedValueOnce({ ...intentRow(), service_snapshot: [service] } as any);
    await expect(applyWorkbenchRuntimeRecreate({ projectId: 'project-a', projectRoot: '/p', intentId: 'i', proposalHash: 'a'.repeat(64), confirmed: true, serviceImpactAcknowledged: false, actor, dependencies: deps() }))
      .rejects.toMatchObject({ code: 'SERVICE_IMPACT_ACK_REQUIRED' });
    expect(queryOne).not.toHaveBeenCalledWith(expect.stringContaining("SET consumed_at=NOW()"), expect.anything());
  });

  it('leaves the exact intent unused when the Runtime activity lock is contended at apply time', async () => {
    const { tryWithRuntimeBoxActivityLock } = await import('./runtime-box-activity-lock.js');
    vi.mocked(tryWithRuntimeBoxActivityLock).mockResolvedValueOnce({ acquired: false });
    const dependencies = deps();

    await expect(applyWorkbenchRuntimeRecreate({
      projectId: 'project-a', projectRoot: '/p', intentId: 'i', proposalHash: 'a'.repeat(64),
      confirmed: true, serviceImpactAcknowledged: true, actor, dependencies,
    })).rejects.toMatchObject({ code: 'ACTIVE_EXECUTION' });

    expect(dependencies.snapshot).not.toHaveBeenCalled();
    expect(dependencies.recreate).not.toHaveBeenCalled();
    expect(queryOne).not.toHaveBeenCalledWith(expect.stringContaining('SET consumed_at=NOW()'), expect.anything());
  });

  it('records stage/audit after destructive lifecycle failure and never reports false success', async () => {
    const failing = deps({ recreate: vi.fn().mockImplementation(async input => { input.onDestructiveStart(); throw new Error('create failed'); }) });
    await expect(applyWorkbenchRuntimeRecreate({ projectId: 'project-a', projectRoot: '/p', intentId: 'i', proposalHash: 'a'.repeat(64), confirmed: true, serviceImpactAcknowledged: true, actor, dependencies: failing })).rejects.toThrow('create failed');
    expect(queryOne).toHaveBeenCalledWith(expect.stringContaining("WHERE id=$1 AND status='applying' RETURNING id"), expect.arrayContaining(['i', 'recovery_required', 'recreate']));
  });

  it('records a Docker identity mismatch before stop as failed without changing Box or projection state', async () => {
    const dockerStop = vi.fn();
    const mismatch = deps({ recreate: vi.fn().mockImplementation(async () => {
      // Manager rejects during exact DB/Docker identity revalidation, before its stop boundary callback.
      throw new Error('STALE_RUNTIME: approved container cannot be verified (absent)');
    }) });
    await expect(applyWorkbenchRuntimeRecreate({ projectId: 'project-a', projectRoot: '/p', intentId: 'i', proposalHash: 'a'.repeat(64), confirmed: true, serviceImpactAcknowledged: true, actor, dependencies: mismatch }))
      .rejects.toThrow('STALE_RUNTIME');
    expect(dockerStop).not.toHaveBeenCalled();
    expect(queryOne).toHaveBeenCalledWith(expect.stringContaining("WHERE id=$1 AND status='applying' RETURNING id"), expect.arrayContaining(['i', 'failed', 'validated']));
    expect(execute).not.toHaveBeenCalledWith(expect.stringContaining("SET status='error'"), expect.anything());
    expect(execute).not.toHaveBeenCalledWith(expect.stringContaining("SET status='recovery_required'"), expect.anything());
  });

  it('runs apply under shared M, A, and L without an ad-hoc destructive lock', async () => {
    const after = { box: { ...box, container_id: 'container-new' }, services: [{ ...service, status: 'stopped', process_pid: null }], inspection: { ...inspection, mountedRevision: 2, recreateRequired: false, projectionStatus: 'mounted' }, targetManifest: manifest, targetState: 'active' };
    const dependencies = deps({ snapshot: vi.fn().mockResolvedValueOnce({ box, services: [service], inspection, targetManifest: manifest, targetState: 'active' }).mockResolvedValue(after) });
    await expect(applyWorkbenchRuntimeRecreate({ projectId: 'project-a', projectRoot: '/p', intentId: 'i', proposalHash: 'a'.repeat(64), confirmed: true, serviceImpactAcknowledged: true, actor, dependencies })).resolves.toMatchObject({ ok: true });
    expect(dependencies.recreate).toHaveBeenCalledWith(expect.objectContaining({ boxId: 10, projectId: 'project-a', expectedContainerId: 'container-old', activity: expect.anything(), lifecycle: expect.anything() }));
  });

  it('revalidates the exact snapshot under the activity lock before consuming the intent', async () => {
    const mutated = { ...inspection, dbRevision: 3 };
    const dependencies = deps({ snapshot: vi.fn()
      .mockResolvedValueOnce({ box, services: [service], inspection: mutated, targetManifest: { ...manifest, revision: 3 }, targetState: 'active' }) });
    await expect(applyWorkbenchRuntimeRecreate({ projectId: 'project-a', projectRoot: '/p', intentId: 'i', proposalHash: 'a'.repeat(64), confirmed: true, serviceImpactAcknowledged: true, actor, dependencies }))
      .rejects.toMatchObject({ code: 'STALE_INTENT' });
    expect(dependencies.recreate).not.toHaveBeenCalled();
    expect(queryOne).not.toHaveBeenCalledWith(expect.stringContaining('SET consumed_at=NOW()'), expect.anything());
  });

  it('does not hide audit failure while recording a command-level recreate failure', async () => {
    vi.mocked(queryOne).mockImplementation(async (sql: string) => {
      if (sql.includes('SELECT * FROM runtime_box_workbench_runtime_recreate_intents')) return intentRow() as any;
      if (sql.includes('SET consumed_at=NOW()')) return { id: 'i' } as any;
      if (sql.includes('SELECT status FROM runtime_box_workbench_runtime_recreate_intents')) return { status: 'applying' } as any;
      if (sql.includes('UPDATE runtime_box_workbench_runtime_recreate_intents SET status=')) throw new Error('audit write failed');
      return { id: 'intent-a', expires_at: '2026-08-01T00:00:00Z' } as any;
    });
    const dependencies = deps({ recreate: vi.fn().mockImplementation(async input => { input.onDestructiveStart(); throw new Error('create failed'); }) });
    await expect(applyWorkbenchRuntimeRecreate({ projectId: 'project-a', projectRoot: '/p', intentId: 'i', proposalHash: 'a'.repeat(64), confirmed: true, serviceImpactAcknowledged: true, actor, dependencies }))
      .rejects.toThrow('audit write failed');
  });

  it('rejects stale revision/container/service snapshot without consuming the one-time intent', async () => {
    const stale = { ...intentRow(), service_snapshot: [{ ...service, process_pid: 999 }] };
    vi.mocked(queryOne).mockImplementation(async (sql: string) => {
      if (sql.includes('SELECT * FROM runtime_box_workbench_runtime_recreate_intents')) return stale as any;
      if (sql.includes("SET consumed_at=NOW()")) return { id: 'i' } as any;
      return { id: 'intent-a', expires_at: '2026-08-01T00:00:00Z' } as any;
    });
    await expect(applyWorkbenchRuntimeRecreate({ projectId: 'project-a', projectRoot: '/p', intentId: 'i', proposalHash: 'a'.repeat(64), confirmed: true, serviceImpactAcknowledged: true, actor, dependencies: deps() }))
      .rejects.toMatchObject({ code: 'STALE_INTENT' });
    expect(queryOne).not.toHaveBeenCalledWith(expect.stringContaining('SET consumed_at=NOW()'), expect.anything());
  });
});

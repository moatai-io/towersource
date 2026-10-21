/**
 * runtime-box-api.ts — Project Runtime Box service control API.
 *
 * Owns: authenticated project-scoped service list/log/stop endpoints for UI panels.
 * Public API: runtimeBoxRouter mounted under /api/runtime-box.
 */

import { Router } from 'express';
import { isProjectMember } from '../services/pm/project-membership-manager.js';
import { isAdminOrOperator, isPrivilegedRole } from '../services/pm/project-access.js';
import { query, queryOne } from '../db/pg-repo.js';
import {
  listServices,
  readServiceLogs,
  stopService,
  formatServiceList,
} from '../services/runtime-box/service-registry.js';
import { destroyBox, getBoxByProject, stopBox } from '../services/runtime-box/runtime-box-manager.js';
import {
  inspectWorkbenchTools,
  listWorkbenchToolRevisions,
} from '../services/runtime-box/workbench-tools.js';
import { WorkbenchToolCommandError } from '../services/runtime-box/workbench-tool-commands.js';
import { assertExperimentalWorkbenchToolAccess, WorkbenchToolExperimentAccessError } from '../services/runtime-box/workbench-tool-experiment-policy.js';
import type { BoxRow, ServiceRow } from '../services/runtime-box/types.js';
import { getRuntimeBoxCapacity, updateRuntimeBoxCapacity } from '../services/runtime-box/runtime-box-capacity.js';
import { listPersistedWorkbenchWorkers } from '../services/execution/worker/worker-repository.js';
import { resolveProjectEnvironmentDeploymentId } from '../services/project-environment/project-environment-deployment.js';
import { listWorkbenchRollouts, resolveWorkbenchRollout, setWorkbenchRollout } from '../services/runtime-box/workbench-rollout-registry.js';

const router = Router();

function reqUser(req: any): { userId: number | undefined; role: string | undefined } {
  return {
    userId: req.user?.userId,
    role: req.user?.role,
  };
}

async function assertProjectAccess(req: any, projectId: string): Promise<{ ok: true } | { ok: false; status: number; error: string }> {
  const { userId, role } = reqUser(req);
  if (!userId) return { ok: false, status: 401, error: 'Auth required' };
  if (isPrivilegedRole(role)) return { ok: true };
  if (await isProjectMember(projectId, userId)) return { ok: true };
  return { ok: false, status: 403, error: 'Access denied: not a project member' };
}

function assertPrivileged(req: any): { ok: true } | { ok: false; status: number; error: string } {
  const { userId, role } = reqUser(req);
  if (!userId) return { ok: false, status: 401, error: 'Auth required' };
  if (!isAdminOrOperator(role)) return { ok: false, status: 403, error: 'Admin/operator required' };
  return { ok: true };
}

function workbenchError(res: any, err: any, fallback: string) {
  const code = err instanceof WorkbenchToolCommandError || err instanceof WorkbenchToolExperimentAccessError ? err.code : undefined;
  const status = code === 'MUTATION_ROLE_REQUIRED' || code === 'EXPERIMENT_DISABLED' || code === 'PROJECT_NOT_ALLOWLISTED' ? 403
    : code === 'STALE_REVISION' || code === 'INTENT_CONSUMED' || code === 'IDEMPOTENCY_CONFLICT' || code === 'RECOVERY_REQUIRED' ? 409
      : code === 'INTENT_EXPIRED' ? 410
        : code === 'INVALID_TOOL_SPEC' || code === 'INVALID_ROLLBACK_TARGET' || code === 'CONFIRMATION_REQUIRED' ? 400
          : 500;
  return res.status(status).json({ error: err?.message || fallback, ...(code ? { code } : {}) });
}

function serviceJson(s: ServiceRow) {
  return {
    id: s.id,
    box_id: s.box_id,
    project_id: s.project_id,
    name: s.name,
    display_name: s.display_name,
    command: s.command,
    cwd: s.cwd,
    internal_port: s.internal_port,
    external_url: s.external_url,
    status: s.status,
    visibility: s.visibility,
    process_pid: s.process_pid,
    log_path: s.log_path,
    pinned: s.pinned,
    purpose: s.purpose,
    owner_user_id: s.owner_user_id,
    ttl_hours: s.ttl_hours,
    review_after: s.review_after,
    started_at: s.started_at,
    stopped_at: s.stopped_at,
    expires_at: s.expires_at,
    last_active_at: s.last_active_at,
    created_at: s.created_at,
    created_by: s.created_by,
    last_error: s.last_error,
  };
}

function boxJson(b: BoxRow & { project_name?: string | null }) {
  return {
    id: b.id,
    project_id: b.project_id,
    project_name: b.project_name ?? null,
    status: b.status,
    runtime_profile: b.runtime_profile,
    project_root: b.project_root,
    memory_mb: b.memory_mb,
    cpu_limit: b.cpu_limit,
    pids_limit: b.pids_limit,
    disk_quota_mb: b.disk_quota_mb,
    idle_stop_minutes: b.idle_stop_minutes,
    last_active_at: b.last_active_at,
    started_at: b.started_at,
    stopped_at: b.stopped_at,
    last_error: b.last_error,
    error_at: b.error_at,
    created_at: b.created_at,
    created_by: b.created_by,
    updated_at: b.updated_at,
    secure_mode: b.secure_mode,
    network_policy: b.network_policy,
  };
}

// Read-only current execution inventory. Storage authority and Worker health are
// separate facts; a healthy Worker is not a promise that a Project can execute.
router.get('/environment-overview', async (req, res) => {
  try {
    const privileged = assertPrivileged(req);
    if (!privileged.ok) return res.status(privileged.status).json({ error: privileged.error });
    const deploymentId = resolveProjectEnvironmentDeploymentId();
    const [projects, workers] = await Promise.all([
      query<{ id: string; name: string; storage_kind: string | null; storage_state: string | null; storage_worker_id: string | null; legacy_worker_id: string | null; legacy_workstation_mode: boolean | null }>(`
        SELECT p.id, p.name, fs.storage_kind, fs.state AS storage_state,
          fs.worker_id AS storage_worker_id,
          COALESCE(cb.workstation_mode, CASE WHEN $1 = 'development' THEN cs.workstation_mode END) AS legacy_workstation_mode,
          COALESCE(cb.default_worker_id, CASE WHEN $1 = 'development' THEN cs.default_worker_id END) AS legacy_worker_id
        FROM projects p
        LEFT JOIN project_file_storage_bindings fs ON fs.project_id = p.id AND fs.deployment_id = $1
        LEFT JOIN project_compute_deployment_bindings cb ON cb.project_id = p.id AND cb.deployment_id = $1
        LEFT JOIN project_compute_settings cs ON cs.project_id = p.id AND $1 = 'development' AND cb.project_id IS NULL
        WHERE COALESCE(p.archived, 0) = 0 AND COALESCE(p.lifecycle_status, 'active') = 'active'
          AND p.system_key IS NULL
        ORDER BY p.name, p.id LIMIT 200`, [deploymentId]),
      listPersistedWorkbenchWorkers(),
    ]);
    res.json({ deploymentId,
      projects: projects.map(p => ({
        projectId: p.id, name: p.name,
        storageKind: p.storage_kind ?? 'unresolved', storageState: p.storage_state ?? 'unresolved',
        environmentMode: p.storage_kind === 'worker' || (!p.storage_kind && p.legacy_workstation_mode)
          ? 'legacy-worker-workspace' : p.storage_kind === 'host' ? 'canonical-project-workspace' : 'unresolved',
        preferredWorkerId: p.storage_kind === 'worker' ? (p.storage_worker_id ?? p.legacy_worker_id)
          : !p.storage_kind && p.legacy_workstation_mode ? p.legacy_worker_id : null,
      })),
      workers: workers.filter(worker => worker.deploymentId === deploymentId).map(worker => ({
        workerId: worker.workerId, status: worker.status, draining: worker.draining,
        activeRuns: worker.capacity.activeRuns, maxRuns: worker.capacity.maxRuns,
      })),
    });
  } catch (err: any) { res.status(500).json({ error: err?.message || 'Environment overview failed' }); }
});

router.get('/capacity', async (req, res) => {
  try {
    const privileged = assertPrivileged(req);
    if (!privileged.ok) return res.status(privileged.status).json({ error: privileged.error });
    res.json(await getRuntimeBoxCapacity());
  } catch (err: any) {
    res.status(500).json({ error: err?.message || 'Runtime Box capacity lookup failed' });
  }
});

router.put('/capacity', async (req, res) => {
  try {
    const { userId, role } = reqUser(req);
    if (!userId) return res.status(401).json({ error: 'Auth required' });
    if (role !== 'admin') return res.status(403).json({ error: 'Admin required' });
    res.json(await updateRuntimeBoxCapacity({
      maxRunning: req.body?.maxRunning,
      maxRunningPerUser: req.body?.maxRunningPerUser,
    }, userId));
  } catch (err: any) {
    const message = err?.message || 'Runtime Box capacity update failed';
    res.status(message.includes('positive integer') ? 400 : 500).json({ error: message });
  }
});

router.get('/workbench-rollouts', async (req, res) => {
  try {
    const privileged = assertPrivileged(req);
    if (!privileged.ok) return res.status(privileged.status).json({ error: privileged.error });
    res.json({ rollouts: await listWorkbenchRollouts() });
  } catch (err: any) {
    res.status(500).json({ error: err?.message || 'Workbench rollout lookup failed' });
  }
});

router.put('/projects/:projectId/workbench-rollout', async (req, res) => {
  try {
    const { userId, role } = reqUser(req);
    if (!userId) return res.status(401).json({ error: 'Auth required' });
    if (!isAdminOrOperator(role)) return res.status(403).json({ error: 'Admin/operator required' });
    const status = req.body?.status;
    if (!['enabled', 'disabled', 'observe'].includes(status)) {
      return res.status(400).json({ error: 'status must be enabled, disabled, or observe' });
    }
    const rollout = await setWorkbenchRollout({
      projectId: req.params.projectId,
      status,
      cohort: typeof req.body?.cohort === 'string' ? req.body.cohort : null,
      reason: typeof req.body?.reason === 'string' ? req.body.reason : null,
      config: req.body?.config && typeof req.body.config === 'object' ? req.body.config : {},
      actorUserId: userId,
    });
    res.json({ rollout, effective_on: 'next_turn_tool_assembly' });
  } catch (err: any) {
    const message = err?.message || 'Workbench rollout update failed';
    res.status(message === 'Active Project not found' ? 404 : 500).json({ error: message });
  }
});

router.get('/services', async (req, res) => {
  try {
    const privileged = assertPrivileged(req);
    if (!privileged.ok) return res.status(privileged.status).json({ error: privileged.error });

    const statusParam = typeof req.query.status === 'string' ? req.query.status : undefined;
    const statusFilter = statusParam
      ? statusParam.split(',').map(s => s.trim()).filter(Boolean)
      : ['running', 'pending', 'error', 'expired'];

    const services = await query<ServiceRow & { project_name: string | null; box_status: string | null; runtime_profile: string | null }>(`
      SELECT s.*, p.name AS project_name, b.status AS box_status, b.runtime_profile
      FROM runtime_box_services s
      LEFT JOIN projects p ON p.id = s.project_id
      LEFT JOIN project_runtime_boxes b ON b.id = s.box_id
      WHERE s.status = ANY($1::text[])
      ORDER BY s.created_at DESC
    `, [statusFilter]);

    const boxes = await query<BoxRow & { project_name: string | null }>(`
      SELECT b.*, p.name AS project_name
      FROM project_runtime_boxes b
      LEFT JOIN projects p ON p.id = b.project_id
      ORDER BY b.updated_at DESC NULLS LAST, b.created_at DESC
    `);

    res.json({
      boxes: boxes.map(boxJson),
      services: services.map(s => ({
        ...serviceJson(s),
        project_name: s.project_name,
        box_status: s.box_status,
        runtime_profile: s.runtime_profile,
      })),
      summary: formatServiceList(services),
    });
  } catch (err: any) {
    res.status(500).json({ error: err?.message || 'Runtime Box service list failed' });
  }
});

router.post('/boxes/:boxId/stop', async (req, res) => {
  try {
    const privileged = assertPrivileged(req);
    if (!privileged.ok) return res.status(privileged.status).json({ error: privileged.error });

    const boxId = Number(req.params.boxId);
    if (!Number.isInteger(boxId) || boxId <= 0) return res.status(400).json({ error: 'Invalid box id' });
    const box = await queryOne<BoxRow>('SELECT * FROM project_runtime_boxes WHERE id = $1', [boxId]);
    if (!box) return res.status(404).json({ error: 'Box not found' });

    await stopBox(boxId, 'stopped');
    res.json({ ok: true, box_id: boxId });
  } catch (err: any) {
    res.status(500).json({ error: err?.message || 'Runtime Box stop failed' });
  }
});

router.delete('/boxes/:boxId', async (req, res) => {
  try {
    const privileged = assertPrivileged(req);
    if (!privileged.ok) return res.status(privileged.status).json({ error: privileged.error });

    const boxId = Number(req.params.boxId);
    if (!Number.isInteger(boxId) || boxId <= 0) return res.status(400).json({ error: 'Invalid box id' });
    const box = await queryOne<BoxRow>('SELECT * FROM project_runtime_boxes WHERE id = $1', [boxId]);
    if (!box) return res.status(404).json({ error: 'Box not found' });

    await destroyBox(boxId);
    res.json({ ok: true, box_id: boxId });
  } catch (err: any) {
    res.status(500).json({ error: err?.message || 'Runtime Box destroy failed' });
  }
});

router.get('/projects/:projectId/workbench-tools', async (req, res) => {
  try {
    const projectId = req.params.projectId;
    const { role } = reqUser(req);
    const rollout = await resolveWorkbenchRollout(projectId);
    assertExperimentalWorkbenchToolAccess({ projectId, role, rolloutEnabled: rollout.enabled });
    const box = await getBoxByProject(projectId);
    if (!box) return res.status(404).json({ error: 'Project Runtime Box not found' });
    res.json(await inspectWorkbenchTools({ projectId, projectRoot: box.project_root }));
  } catch (err: any) {
    return workbenchError(res, err, 'Workbench tool inspection failed');
  }
});

router.get('/projects/:projectId/workbench-tools/revisions', async (req, res) => {
  try {
    const projectId = req.params.projectId;
    const { role } = reqUser(req);
    const rollout = await resolveWorkbenchRollout(projectId);
    assertExperimentalWorkbenchToolAccess({ projectId, role, rolloutEnabled: rollout.enabled });
    const limit = typeof req.query.limit === 'string' ? Number(req.query.limit) : 20;
    res.json({ projectId, revisions: await listWorkbenchToolRevisions(projectId, Number.isFinite(limit) ? limit : 20) });
  } catch (err: any) {
    return workbenchError(res, err, 'Workbench tool revision lookup failed');
  }
});

router.post('/projects/:projectId/workbench-tools/change-intents', (_req, res) => {
  res.status(403).json({ error: 'Workbench tool preview is closed on HTTP during the internal experimental PoC' });
});

router.post('/projects/:projectId/workbench-tools/change-intents/:intentId/apply', (_req, res) => {
  res.status(403).json({ error: 'Workbench tool apply is closed on HTTP during the internal experimental PoC' });
});

router.get('/projects/:projectId/services', async (req, res) => {
  try {
    const projectId = req.params.projectId;
    const access = await assertProjectAccess(req, projectId);
    if (!access.ok) return res.status(access.status).json({ error: access.error });

    const statusParam = typeof req.query.status === 'string' ? req.query.status : undefined;
    const statusFilter = statusParam
      ? statusParam.split(',').map(s => s.trim()).filter(Boolean)
      : ['running', 'pending', 'error', 'expired'];

    const [box, services] = await Promise.all([
      getBoxByProject(projectId),
      listServices(projectId, { statusFilter }),
    ]);

    res.json({
      box: box ? {
        id: box.id,
        project_id: box.project_id,
        status: box.status,
        runtime_profile: box.runtime_profile,
        memory_mb: box.memory_mb,
        cpu_limit: box.cpu_limit,
        idle_stop_minutes: box.idle_stop_minutes,
        last_active_at: box.last_active_at,
        started_at: box.started_at,
        stopped_at: box.stopped_at,
        updated_at: box.updated_at,
        last_error: box.last_error,
      } : null,
      services: services.map(serviceJson),
      summary: formatServiceList(services),
    });
  } catch (err: any) {
    res.status(500).json({ error: err?.message || 'Runtime Box service list failed' });
  }
});

router.get('/services/:serviceId/logs', async (req, res) => {
  try {
    const serviceId = Number(req.params.serviceId);
    if (!Number.isInteger(serviceId) || serviceId <= 0) return res.status(400).json({ error: 'Invalid service id' });

    const services = await listServicesForLookup(serviceId);
    const svc = services[0];
    if (!svc) return res.status(404).json({ error: 'Service not found' });

    const access = await assertProjectAccess(req, svc.project_id);
    if (!access.ok) return res.status(access.status).json({ error: access.error });

    const tailRaw = typeof req.query.tail === 'string' ? Number(req.query.tail) : 100;
    const tail = Number.isFinite(tailRaw) ? Math.max(1, Math.min(Math.floor(tailRaw), 5000)) : 100;
    const text = await readServiceLogs(serviceId, tail);
    res.json({ service: serviceJson(svc), tail, text });
  } catch (err: any) {
    res.status(500).json({ error: err?.message || 'Runtime Box service logs failed' });
  }
});

router.post('/services/:serviceId/stop', async (req, res) => {
  try {
    const serviceId = Number(req.params.serviceId);
    if (!Number.isInteger(serviceId) || serviceId <= 0) return res.status(400).json({ error: 'Invalid service id' });

    const services = await listServicesForLookup(serviceId);
    const svc = services[0];
    if (!svc) return res.status(404).json({ error: 'Service not found' });

    const access = await assertProjectAccess(req, svc.project_id);
    if (!access.ok) return res.status(access.status).json({ error: access.error });

    await stopService(serviceId);
    res.json({ ok: true, service_id: serviceId });
  } catch (err: any) {
    res.status(500).json({ error: err?.message || 'Runtime Box service stop failed' });
  }
});

async function listServicesForLookup(serviceId: number): Promise<ServiceRow[]> {
  // Reuse the registry module's row type through a narrow local query to avoid
  // widening listServices(project) just for UI lookup by id.
  return query<ServiceRow>('SELECT * FROM runtime_box_services WHERE id = $1', [serviceId]);
}

export default router;

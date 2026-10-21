import express from 'express';
import { createServer, type Server } from 'node:http';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { isProjectMember } from '../services/pm/project-membership-manager.js';
import { listPersistedWorkbenchWorkers } from '../services/execution/worker/worker-repository.js';
import { query } from '../db/pg-repo.js';
import { getBoxByProject } from '../services/runtime-box/runtime-box-manager.js';
import { inspectWorkbenchTools, listWorkbenchToolRevisions } from '../services/runtime-box/workbench-tools.js';
import { listWorkbenchRollouts, resolveWorkbenchRollout, setWorkbenchRollout } from '../services/runtime-box/workbench-rollout-registry.js';

vi.mock('../services/pm/project-membership-manager.js', () => ({ isProjectMember: vi.fn() }));
vi.mock('../db/pg-repo.js', () => ({ query: vi.fn(), queryOne: vi.fn() }));
vi.mock('../services/execution/worker/worker-repository.js', () => ({ listPersistedWorkbenchWorkers: vi.fn() }));
vi.mock('../services/runtime-box/service-registry.js', () => ({ listServices: vi.fn(), readServiceLogs: vi.fn(), stopService: vi.fn(), formatServiceList: vi.fn() }));
vi.mock('../services/runtime-box/runtime-box-capacity.js', () => ({ getRuntimeBoxCapacity: vi.fn(), updateRuntimeBoxCapacity: vi.fn() }));
vi.mock('../services/runtime-box/workbench-rollout-registry.js', () => ({
  listWorkbenchRollouts: vi.fn(), resolveWorkbenchRollout: vi.fn(), setWorkbenchRollout: vi.fn(),
}));
vi.mock('../services/runtime-box/runtime-box-manager.js', () => ({
  destroyBox: vi.fn(), execInBox: vi.fn(), getBoxByProject: vi.fn(), stopBox: vi.fn(),
}));
vi.mock('../services/runtime-box/workbench-tools.js', () => ({
  inspectWorkbenchTools: vi.fn(), installUvWorkbenchTool: vi.fn(), listWorkbenchToolRevisions: vi.fn(), rollbackWorkbenchTools: vi.fn(),
}));


let server: Server;
let baseUrl = '';

beforeAll(async () => {
  const router = (await import('./runtime-box-api.js')).default;
  const app = express();
  app.use(express.json());
  app.use((req: any, _res, next) => {
    const role = req.header('x-test-role');
    const userId = req.header('x-test-user');
    if (role && userId) req.user = { role, userId: Number(userId) };
    next();
  });
  app.use('/api/runtime-box', router);
  server = createServer(app);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('test server address unavailable');
  baseUrl = `http://127.0.0.1:${address.port}/api/runtime-box`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('TOWER_EXPERIMENTAL_WORKBENCH_TOOLS_ENABLED', 'true');
  vi.stubEnv('TOWER_EXPERIMENTAL_WORKBENCH_TOOL_PROJECT_IDS', JSON.stringify(['p']));
  vi.mocked(getBoxByProject).mockResolvedValue({ id: 10, project_id: 'p', project_root: '/tmp/p' } as any);
  vi.mocked(listPersistedWorkbenchWorkers).mockResolvedValue([]);
  vi.mocked(inspectWorkbenchTools).mockResolvedValue({ projectId: 'p', dbRevision: 1, filesystemRevision: 1, health: 'healthy', reason: 'agree' });
  vi.mocked(listWorkbenchToolRevisions).mockResolvedValue([]);
  vi.mocked(resolveWorkbenchRollout).mockResolvedValue({ enabled: true, status: 'enabled', source: 'database', cohort: 'test' });
  vi.mocked(listWorkbenchRollouts).mockResolvedValue([]);
  vi.mocked(setWorkbenchRollout).mockResolvedValue({ project_id: 'p', status: 'enabled' } as any);
});

afterEach(() => vi.unstubAllEnvs());

async function call(path: string, init: RequestInit = {}, role?: string) {
  return fetch(`${baseUrl}${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', ...(role ? { 'x-test-role': role, 'x-test-user': '7' } : {}), ...(init.headers || {}) },
  });
}

describe('read-only environment overview', () => {
  it('keeps missing storage unresolved and preserves legacy pinned execution facts', async () => {
    vi.stubEnv('TOWER_DEPLOYMENT_ID', 'production');
    vi.mocked(query).mockResolvedValue([
      { id: 'unknown', name: 'Unknown', storage_kind: null, storage_state: null, legacy_workstation_mode: false },
      { id: 'legacy', name: 'Legacy', storage_kind: null, storage_state: null, legacy_workstation_mode: true, legacy_worker_id: 'pinned' },
    ]);
    const response = await call('/environment-overview', {}, 'admin');
    expect(response.status).toBe(200);
    expect((await response.json()).projects).toMatchObject([
      { environmentMode: 'unresolved', storageState: 'unresolved', preferredWorkerId: null },
      { environmentMode: 'legacy-worker-workspace', storageState: 'unresolved', preferredWorkerId: 'pinned' },
    ]);
    expect(query).toHaveBeenCalledWith(expect.stringContaining("cb.project_id IS NULL"), ['production']);
  });

  it('requires admin/operator and separates storage authority from Worker status', async () => {
    vi.stubEnv('TOWER_DEPLOYMENT_ID', 'production');
    expect((await call('/environment-overview')).status).toBe(401);
    expect((await call('/environment-overview', {}, 'member')).status).toBe(403);
    expect(query).not.toHaveBeenCalled();
    vi.mocked(query).mockResolvedValue([{ id: 'intro', name: 'Introduction', storage_kind: 'host', state: 'ready', storage_state: 'ready', storage_worker_id: null }]);
    vi.mocked(listPersistedWorkbenchWorkers).mockResolvedValue([
      { workerId: 'worker-a', deploymentId: 'production', status: 'healthy', draining: false, capacity: { activeRuns: 1, maxRuns: 4 } },
      { workerId: 'worker-b', deploymentId: 'development', status: 'healthy', draining: false, capacity: { activeRuns: 0, maxRuns: 3 } },
    ] as any);
    const result = await call('/environment-overview', {}, 'operator');
    expect(result.status).toBe(200);
    expect(await result.json()).toMatchObject({ deploymentId: 'production', projects: [{ projectId: 'intro', environmentMode: 'canonical-project-workspace', storageKind: 'host', storageState: 'ready', preferredWorkerId: null }], workers: [{ workerId: 'worker-a', activeRuns: 1, maxRuns: 4 }] });
    expect(query).toHaveBeenCalledWith(expect.stringContaining('fs.deployment_id = $1'), ['production']);
  });
});

describe('Workbench tool Runtime Box HTTP API', () => {
  it('fails closed when the global experiment is disabled or DB rollout is disabled', async () => {
    vi.stubEnv('TOWER_EXPERIMENTAL_WORKBENCH_TOOLS_ENABLED', 'false');
    expect((await call('/projects/p/workbench-tools', {}, 'admin')).status).toBe(403);
    expect((await call('/projects/p/workbench-tools/revisions', {}, 'operator')).status).toBe(403);

    vi.stubEnv('TOWER_EXPERIMENTAL_WORKBENCH_TOOLS_ENABLED', 'true');
    vi.mocked(resolveWorkbenchRollout).mockResolvedValue({ enabled: false, status: 'disabled', source: 'database', cohort: 'rollback' });
    expect((await call('/projects/p/workbench-tools', {}, 'admin')).status).toBe(403);
    expect((await call('/projects/p/workbench-tools/revisions', {}, 'operator')).status).toBe(403);
  });

  it('rejects ordinary and removed legacy roles from reads', async () => {
    for (const role of ['member', 'customer_manager']) {
      expect((await call('/projects/p/workbench-tools', {}, role)).status).toBe(403);
      expect((await call('/projects/p/workbench-tools/revisions', {}, role)).status).toBe(403);
    }
  });

  it('allows admin/operator reads only for an enabled Project', async () => {
    for (const role of ['admin', 'operator']) {
      const inspection = await call('/projects/p/workbench-tools', {}, role);
      expect(inspection.status).toBe(200);
      expect(await inspection.json()).toMatchObject({ dbRevision: 1, health: 'healthy' });
      const revisions = await call('/projects/p/workbench-tools/revisions?limit=5', {}, role);
      expect(revisions.status).toBe(200);
    }
    expect(listWorkbenchToolRevisions).toHaveBeenCalledWith('p', 5);
    expect(resolveWorkbenchRollout).toHaveBeenCalledWith('p');
  });

  it('restricts rollout listing and updates to admin/operator and validates status', async () => {
    expect((await call('/workbench-rollouts')).status).toBe(401);
    expect((await call('/workbench-rollouts', {}, 'member')).status).toBe(403);
    expect((await call('/workbench-rollouts', {}, 'operator')).status).toBe(200);

    const invalid = await call('/projects/p/workbench-rollout', { method: 'PUT', body: JSON.stringify({ status: 'maybe' }) }, 'admin');
    expect(invalid.status).toBe(400);
    const updated = await call('/projects/p/workbench-rollout', {
      method: 'PUT', body: JSON.stringify({ status: 'enabled', cohort: 'cohort-a', reason: 'dogfood' }),
    }, 'operator');
    expect(updated.status).toBe(200);
    expect(setWorkbenchRollout).toHaveBeenCalledWith({
      projectId: 'p', status: 'enabled', cohort: 'cohort-a', reason: 'dogfood', config: {}, actorUserId: 7,
    });
    expect(await updated.json()).toMatchObject({ effective_on: 'next_turn_tool_assembly' });
  });

  it('closes HTTP preview and apply for every role during the PoC', async () => {
    const previewPath = '/projects/p/workbench-tools/change-intents';
    const applyPath = '/projects/p/workbench-tools/change-intents/intent-a/apply';
    for (const role of ['member', 'operator', 'admin']) {
      const preview = await call(previewPath, { method: 'POST', body: '{}' }, role);
      expect(preview.status).toBe(403);
      expect(await preview.json()).toMatchObject({ error: expect.stringContaining('closed on HTTP') });
      const apply = await call(applyPath, { method: 'POST', body: '{}' }, role);
      expect(apply.status).toBe(403);
      expect(await apply.json()).toMatchObject({ error: expect.stringContaining('closed on HTTP') });
    }
  });
});

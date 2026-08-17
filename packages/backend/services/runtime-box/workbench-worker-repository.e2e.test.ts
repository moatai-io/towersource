import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const runFile = promisify(execFile);
const run = process.env.WORKBENCH_WORKER_REGISTRY_E2E === '1' ? describe : describe.skip;
async function docker(...args: string[]) { return runFile('docker', args, { maxBuffer: 4_000_000 }); }

run('Remote Workbench Worker PostgreSQL registry E2E', () => {
  const pgName = `tower-worker-registry-pg-${process.pid}-${Date.now()}`;
  let modules: any;
  let databaseUrl = '';

  beforeAll(async () => {
    await docker('run', '-d', '--rm', '--name', pgName, '-e', 'POSTGRES_PASSWORD=test', '-e', 'POSTGRES_DB=tower_test', '-p', '127.0.0.1::5432', 'postgres:16-alpine');
    const mapped = await docker('port', pgName, '5432/tcp');
    const port = Number(mapped.stdout.trim().match(/:(\d+)$/)?.[1]);
    databaseUrl = `postgresql://postgres:test@127.0.0.1:${port}/tower_test`;
    for (let attempt = 0; attempt < 40; attempt += 1) {
      try { await runFile('psql', [databaseUrl, '-v', 'ON_ERROR_STOP=1', '-c', 'SELECT 1']); break; }
      catch { if (attempt === 39) throw new Error('Disposable PostgreSQL did not become ready'); await new Promise(resolve => setTimeout(resolve, 250)); }
    }
    process.env.DATABASE_URL = databaseUrl;
    modules = { workers: await import('./workbench-worker-repository.js'), pg: await import('../../db/pg.js') };
    await runFile('psql', [databaseUrl, '-v', 'ON_ERROR_STOP=1', '-f', path.resolve('packages/backend/db/migrations/170_runtime_box_workbench_workers.sql')]);
  }, 120_000);

  afterAll(async () => {
    await modules?.pg?.closePgPool?.().catch(() => undefined);
    await docker('rm', '-f', pgName).catch(() => undefined);
    delete process.env.DATABASE_URL;
  }, 120_000);

  it('persists registration, heartbeat, drain and deterministic scheduling across repository reads', async () => {
    const capacity = (activeRuns: number, maxRuns = 4) => ({ cpuTotal: 4, memoryMbTotal: 8192, activeRuns, maxRuns });
    await modules.workers.upsertWorkbenchWorker({ workerId: 'worker-b', baseUrl: 'https://b.internal/', capabilities: ['job'], projectIds: ['p1'], capacity: capacity(3) });
    await modules.workers.upsertWorkbenchWorker({ workerId: 'worker-a', baseUrl: 'https://a.internal', capabilities: ['shell', 'job'], projectIds: ['p1'], capacity: capacity(1) });
    expect(await modules.workers.selectPersistedWorkbenchWorker({ projectId: 'p1', requiredCapabilities: ['job'] })).toMatchObject({ workerId: 'worker-a', status: 'healthy' });

    await modules.workers.setPersistedWorkbenchWorkerDrain('worker-a', true);
    expect(await modules.workers.selectPersistedWorkbenchWorker({ projectId: 'p1', requiredCapabilities: ['job'] })).toMatchObject({ workerId: 'worker-b' });

    const heartbeat = await modules.workers.heartbeatPersistedWorkbenchWorker({ workerId: 'worker-b', capacity: capacity(4) });
    expect(heartbeat.capacity.activeRuns).toBe(4);
    await expect(modules.workers.selectPersistedWorkbenchWorker({ projectId: 'p1', requiredCapabilities: ['job'] })).rejects.toThrow('NO_ELIGIBLE_WORKER');
    expect(await modules.workers.listPersistedWorkbenchWorkers()).toHaveLength(2);
  }, 30_000);
});

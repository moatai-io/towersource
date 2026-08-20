import { beforeEach, describe, expect, it, vi } from 'vitest';
import { queryOne, transaction } from '../../db/pg-repo.js';
import { getPersistedWorkbenchWorker } from './workbench-worker-repository.js';
import { createRemoteWorkbenchHttpTransport } from './workbench-remote-http-transport.js';
import { getWorkbenchWorkerTransportCredentialBinding, resolveWorkbenchWorkerTransportToken } from './workbench-worker-transport-credentials.js';
import { applyProjectWorkstationChange, previewProjectWorkstationChange, verifyProjectWorkstationChangeSmoke } from './workbench-project-workstation-change.js';

vi.mock('../../db/pg-repo.js', () => ({ queryOne: vi.fn(), transaction: vi.fn() }));
vi.mock('./workbench-worker-repository.js', () => ({ getPersistedWorkbenchWorker: vi.fn() }));
vi.mock('./workbench-worker-transport-credentials.js', () => ({ getWorkbenchWorkerTransportCredentialBinding: vi.fn(), resolveWorkbenchWorkerTransportToken: vi.fn() }));
vi.mock('./workbench-remote-http-transport.js', () => ({ createRemoteWorkbenchHttpTransport: vi.fn() }));

const worker = {
  workerId: 'tower-project-local-01', deploymentId: 'production', baseUrl: 'http://127.0.0.1:43425',
  capabilities: ['job','service','shell'], projectIds: ['p1'],
  capacity: { cpuTotal: 4, memoryMbTotal: 8192, activeRuns: 0, maxRuns: 4 },
  draining: false, status: 'healthy', registeredAt: '2026-08-20T00:00:00.000Z', heartbeatAt: '2026-08-20T00:00:10.000Z',
} as const;
const bindingRow = {
  project_id: 'p1', deployment_id: 'production', default_worker_id: 'tower-prod-local-01',
  workstation_mode: true, authority_mode: 'project', updated_at: '2026-08-20T00:00:00.000Z',
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getPersistedWorkbenchWorker).mockResolvedValue(worker as any);
  vi.mocked(getWorkbenchWorkerTransportCredentialBinding).mockResolvedValue({ worker_id: worker.workerId } as any);
  vi.mocked(resolveWorkbenchWorkerTransportToken).mockResolvedValue('transport-token');
});

describe('Project Workstation change', () => {
  it('previews a healthy authorized target without exposing transport secret values', async () => {
    vi.mocked(queryOne)
      .mockResolvedValueOnce(bindingRow as any)
      .mockResolvedValueOnce({ id: '11111111-1111-4111-8111-111111111111', expires_at: '2026-08-20T00:15:00.000Z' } as any);
    const preview = await previewProjectWorkstationChange({
      projectId: 'p1', deploymentId: 'production', targetWorkerId: worker.workerId, reason: 'execution user separation',
      actor: { userId: 7, role: 'admin', sessionId: 's1' },
    });
    expect(preview).toMatchObject({
      current: { defaultWorkerId: 'tower-prod-local-01' }, target: { workerId: worker.workerId, transportConfigured: true },
      checks: { health: 'pass', projectScope: 'pass', transport: 'pass', executionSmoke: 'required-before-apply' },
      impact: { rollbackWorkerId: 'tower-prod-local-01', bindingOnly: true },
    });
    expect(JSON.stringify(preview)).not.toMatch(/token|secret/i);
  });

  it.each([
    [{ ...worker, status: 'stale' }, 'TARGET_WORKER_NOT_HEALTHY'],
    [{ ...worker, projectIds: [] }, 'TARGET_WORKER_PROJECT_SCOPE_MISSING'],
    [{ ...worker, capabilities: ['shell'] }, 'TARGET_WORKER_CAPABILITY_MISSING'],
    [{ ...worker, deploymentId: 'development' }, 'TARGET_WORKER_DEPLOYMENT_MISMATCH'],
    [{ ...worker, capacity: { ...worker.capacity, maxRuns: 2 } }, 'TARGET_WORKER_CAPACITY_INVALID'],
  ])('rejects an unsafe target during preview', async (target, code) => {
    vi.mocked(queryOne).mockResolvedValue(bindingRow as any);
    vi.mocked(getPersistedWorkbenchWorker).mockResolvedValue(target as any);
    await expect(previewProjectWorkstationChange({
      projectId: 'p1', deploymentId: 'production', targetWorkerId: worker.workerId, reason: 'move', actor: { userId: 7, role: 'admin' },
    })).rejects.toMatchObject({ code });
  });

  it('issues a bounded server smoke receipt after direct target execution', async () => {
    const execute = vi.fn(async ({ onStdout }: any) => {
      onStdout('user=tower-project-worker\nworkstation-smoke-ok\n');
      return { execResult: { exit_code: 0 }, artifacts: [], cancellation: { requested: false, processGroupExited: true } };
    });
    vi.mocked(createRemoteWorkbenchHttpTransport).mockReturnValue({ workerId: worker.workerId, execute } as any);
    vi.mocked(queryOne)
      .mockResolvedValueOnce({ id: 'intent', target_worker_id: worker.workerId, target_snapshot: {
        workerId: worker.workerId, deploymentId: 'production', authorityMode: 'project', status: 'healthy', heartbeatAt: worker.heartbeatAt,
        capabilities: [...worker.capabilities].sort(), projectAuthorized: true, transportConfigured: true, capacity: { activeRuns: 0, maxRuns: 4 },
      }, status: 'previewed', consumed_at: null } as any)
      .mockResolvedValueOnce({ smoke_verified_at: '2026-08-20T00:01:00.000Z' } as any);
    const receipt = await verifyProjectWorkstationChangeSmoke({
      projectId: 'p1', deploymentId: 'production', intentId: '11111111-1111-4111-8111-111111111111', proposalHash: 'a'.repeat(64), actor: { userId: 7, role: 'admin' },
    });
    expect(receipt).toMatchObject({ ok: true, workerId: worker.workerId, checks: { execution: 'pass', secretIsolation: 'pass' } });
    expect(receipt.receiptHash).toMatch(/^[0-9a-f]{64}$/);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(receipt)).not.toContain('transport-token');
  });

  it('requires a server-issued smoke receipt before apply', async () => {
    await expect(applyProjectWorkstationChange({
      projectId: 'p1', deploymentId: 'production', intentId: '11111111-1111-4111-8111-111111111111', proposalHash: 'a'.repeat(64),
      confirmed: true, smokeReceiptHash: 'invalid', actor: { userId: 7, role: 'admin' },
    })).rejects.toMatchObject({ code: 'CONFIRMATION_AND_SMOKE_RECEIPT_REQUIRED' });
  });

  it('atomically switches only the deployment binding after stale checks', async () => {
    const targetSnapshot = {
      workerId: worker.workerId, deploymentId: 'production', authorityMode: 'project', status: 'healthy', heartbeatAt: worker.heartbeatAt,
      capabilities: [...worker.capabilities].sort(), projectAuthorized: true, transportConfigured: true,
      capacity: { activeRuns: 0, maxRuns: 4 },
    };
    const client = { query: vi.fn() } as any;
    client.query
      .mockResolvedValueOnce({ rows: [{ id: 'intent', target_worker_id: worker.workerId, expected_binding: {
        projectId: 'p1', deploymentId: 'production', defaultWorkerId: 'tower-prod-local-01', workstationMode: true,
        authorityMode: 'project', updatedAt: '2026-08-20T00:00:00.000Z',
      }, target_snapshot: targetSnapshot, status: 'previewed', consumed_at: null, smoke_receipt_hash: 'b'.repeat(64), smoke_verified_at: '2026-08-20T00:01:00.000Z' }] })
      .mockResolvedValueOnce({ rows: [bindingRow] })
      .mockResolvedValueOnce({ rowCount: 1, rows: [] })
      .mockResolvedValueOnce({ rowCount: 1, rows: [] });
    vi.mocked(transaction).mockImplementation(async fn => fn(client));
    await expect(applyProjectWorkstationChange({
      projectId: 'p1', deploymentId: 'production', intentId: '11111111-1111-4111-8111-111111111111', proposalHash: 'a'.repeat(64),
      confirmed: true, smokeReceiptHash: 'b'.repeat(64), actor: { userId: 7, role: 'admin' },
    })).resolves.toMatchObject({ previousWorkerId: 'tower-prod-local-01', workerId: worker.workerId });
    expect(client.query.mock.calls[2][0]).toContain('project_compute_deployment_bindings');
    expect(client.query.mock.calls[2][0]).not.toContain('project_compute_settings');
  });
});

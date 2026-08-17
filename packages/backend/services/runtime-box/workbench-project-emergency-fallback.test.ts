import { beforeEach, describe, expect, it, vi } from 'vitest';
import { queryOne, transaction } from '../../db/pg-repo.js';
import { applyProjectWorkerEmergencyFallback, previewProjectWorkerEmergencyFallback } from './workbench-project-emergency-fallback.js';

vi.mock('../../db/pg-repo.js', () => ({ queryOne: vi.fn(), transaction: vi.fn() }));

const bindingRow = {
  project_id: 'p1', deployment_id: 'production', default_worker_id: 'tower-prod-local-01',
  workstation_mode: true, authority_mode: 'project', updated_at: '2026-08-14T00:00:00.000Z',
};
const binding = {
  projectId: 'p1', deploymentId: 'production', defaultWorkerId: 'tower-prod-local-01',
  workstationMode: true, authorityMode: 'project', updatedAt: '2026-08-14T00:00:00.000Z',
};

beforeEach(() => vi.clearAllMocks());

describe('Project Worker emergency fallback', () => {
  it('previews exact Project+deployment impact without contacting a Worker', async () => {
    vi.mocked(queryOne).mockResolvedValueOnce(bindingRow).mockResolvedValueOnce({ id: '11111111-1111-4111-8111-111111111111', expires_at: '2099-01-01' });
    const preview = await previewProjectWorkerEmergencyFallback({
      projectId: 'p1', deploymentId: 'production', reason: 'Worker crash drill',
      actor: { userId: 7, role: 'admin', sessionId: 's1' },
    });
    expect(preview).toMatchObject({
      binding, impact: { nextDefaultRuntime: 'project-runtime-box', workerProcessChanged: false, runningWorkerRunsInterrupted: false },
    });
    expect(preview.proposalHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('refuses preview when no active workstation binding exists', async () => {
    vi.mocked(queryOne).mockResolvedValue({ ...bindingRow, workstation_mode: false });
    await expect(previewProjectWorkerEmergencyFallback({
      projectId: 'p1', deploymentId: 'production', reason: 'x', actor: { userId: 7, role: 'admin' },
    })).rejects.toMatchObject({ code: 'WORKSTATION_BINDING_NOT_ACTIVE' });
  });

  it('atomically disables only the exact binding and consumes the intent', async () => {
    const client = { query: vi.fn() };
    vi.mocked(transaction).mockImplementation(async fn => fn(client as any));
    client.query
      .mockResolvedValueOnce({ rows: [{
        id: '11111111-1111-4111-8111-111111111111', project_id: 'p1', deployment_id: 'production', actor_user_id: 7,
        expected_binding: binding, proposal_hash: 'a'.repeat(64), status: 'previewed', expires_at: '2099-01-01', consumed_at: null,
      }] })
      .mockResolvedValueOnce({ rows: [bindingRow] })
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ updated_at: new Date() }] })
      .mockResolvedValueOnce({ rowCount: 1, rows: [] });
    await expect(applyProjectWorkerEmergencyFallback({
      projectId: 'p1', deploymentId: 'production', intentId: '11111111-1111-4111-8111-111111111111',
      proposalHash: 'a'.repeat(64), confirmed: true, actor: { userId: 7, role: 'admin' },
    })).resolves.toMatchObject({ workstationMode: false, nextDefaultRuntime: 'project-runtime-box', workerProcessChanged: false });
    expect(client.query.mock.calls[2][0]).toContain('default_worker_id=NULL,workstation_mode=FALSE');
    expect(client.query.mock.calls[3][0]).toContain("status='succeeded'");
  });

  it('accepts JSONB snapshots whose object keys were reordered by PostgreSQL', async () => {
    const client = { query: vi.fn() };
    vi.mocked(transaction).mockImplementation(async fn => fn(client as any));
    const reordered = {
      updatedAt: binding.updatedAt, workstationMode: true, defaultWorkerId: binding.defaultWorkerId,
      authorityMode: 'project', deploymentId: 'production', projectId: 'p1',
    };
    client.query
      .mockResolvedValueOnce({ rows: [{
        id: '11111111-1111-4111-8111-111111111111', project_id: 'p1', deployment_id: 'production', actor_user_id: 7,
        expected_binding: reordered, proposal_hash: 'a'.repeat(64), status: 'previewed', expires_at: '2099-01-01', consumed_at: null,
      }] })
      .mockResolvedValueOnce({ rows: [bindingRow] })
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ updated_at: new Date() }] })
      .mockResolvedValueOnce({ rowCount: 1, rows: [] });
    await expect(applyProjectWorkerEmergencyFallback({
      projectId: 'p1', deploymentId: 'production', intentId: '11111111-1111-4111-8111-111111111111',
      proposalHash: 'a'.repeat(64), confirmed: true, actor: { userId: 7, role: 'admin' },
    })).resolves.toMatchObject({ workstationMode: false });
  });

  it('rejects stale intent before changing the binding', async () => {
    const client = { query: vi.fn() };
    vi.mocked(transaction).mockImplementation(async fn => fn(client as any));
    client.query
      .mockResolvedValueOnce({ rows: [{
        id: '11111111-1111-4111-8111-111111111111', project_id: 'p1', deployment_id: 'production', actor_user_id: 7,
        expected_binding: binding, proposal_hash: 'a'.repeat(64), status: 'previewed', expires_at: '2099-01-01', consumed_at: null,
      }] })
      .mockResolvedValueOnce({ rows: [{ ...bindingRow, default_worker_id: 'different-worker' }] });
    await expect(applyProjectWorkerEmergencyFallback({
      projectId: 'p1', deploymentId: 'production', intentId: '11111111-1111-4111-8111-111111111111',
      proposalHash: 'a'.repeat(64), confirmed: true, actor: { userId: 7, role: 'admin' },
    })).rejects.toMatchObject({ code: 'STALE_INTENT' });
    expect(client.query).toHaveBeenCalledTimes(2);
  });
});

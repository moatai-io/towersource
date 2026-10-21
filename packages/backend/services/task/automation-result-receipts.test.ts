import { beforeEach, describe, expect, it, vi } from 'vitest';
const m = vi.hoisted(() => ({ query: vi.fn(), automation: vi.fn(), access: vi.fn() }));
vi.mock('../../db/pg-repo.js', () => ({ queryOne: m.query }));
vi.mock('./automation-manager.js', () => ({ getAutomation: m.automation }));
vi.mock('./schedule-permissions.js', () => ({ canAccessAutomationJob: m.access }));
import { acknowledgeAutomationResult } from './automation-result-receipts.js';
const input = { userId: 7, role: 'member', projectId: 'p1', runId: 'r1', action: 'read' as const };
beforeEach(() => {
  vi.clearAllMocks();
  m.automation.mockResolvedValue({ id: 'a1', projectId: 'p1' });
  m.access.mockResolvedValue({ allowed: true });
});
describe('personal run receipts', () => {
  it('writes only this authenticated user and preserves first acknowledgement timestamps', async () => {
    m.query.mockResolvedValueOnce({ automation_id: 'a1' }).mockResolvedValueOnce({ ready: true }).mockResolvedValueOnce({ readAt: 'date', actionedAt: 'date' });
    expect(await acknowledgeAutomationResult({ ...input, action: 'actioned' })).toEqual({ readAt: 'date', actionedAt: 'date' });
    const [sql, params] = m.query.mock.calls[2];
    expect(params).toEqual(['r1', 7, 'p1', 'actioned']);
    expect(sql).toContain('ON CONFLICT (run_id, user_id)');
    expect(sql).toContain('COALESCE(automation_result_receipts.actioned_at');
    expect(sql).toContain('a.project_id = $3');
    expect(sql).not.toContain('UPDATE automation_runs');
  });
  it('does not create receipts for results from another project', async () => {
    m.query.mockResolvedValueOnce({ automation_id: 'a1' }); m.automation.mockResolvedValueOnce({ projectId: 'p2' });
    await expect(acknowledgeAutomationResult(input)).rejects.toMatchObject({ status: 404 });
    expect(m.query).toHaveBeenCalledTimes(1);
  });
  it('rejects current result access denial before inspecting or writing receipts', async () => {
    m.query.mockResolvedValueOnce({ automation_id: 'a1' }); m.access.mockResolvedValueOnce({ allowed: false });
    await expect(acknowledgeAutomationResult(input)).rejects.toMatchObject({ status: 403 });
    expect(m.query).toHaveBeenCalledTimes(1);
  });
  it('rejects invalid internal actor or action before any database access', async () => {
    await expect(acknowledgeAutomationResult({ ...input, userId: 0 })).rejects.toMatchObject({ status: 403 });
    await expect(acknowledgeAutomationResult({ ...input, action: 'success' as any })).rejects.toMatchObject({ status: 403 });
    expect(m.query).not.toHaveBeenCalled();
  });
  it('does not write when the additive receipt table is unavailable', async () => {
    m.query.mockResolvedValueOnce({ automation_id: 'a1' }).mockResolvedValueOnce({ ready: false });
    await expect(acknowledgeAutomationResult(input)).rejects.toMatchObject({ status: 409 });
    expect(m.query).toHaveBeenCalledTimes(2);
  });
});

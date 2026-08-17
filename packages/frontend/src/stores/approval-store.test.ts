// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';

function token() { return 'x.y.z'; }

describe('approval-store', () => {
  beforeEach(() => {
    vi.resetModules();
    localStorage.clear();
    vi.unstubAllGlobals();
  });

  it('counts assigned pending cards and stores the projection', async () => {
    localStorage.setItem('token', token());
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ cards: [{ id: 'a' }, { id: 'b' }] }) })));
    const { refreshPendingApprovals, useApprovalStore } = await import('./approval-store');
    await expect(refreshPendingApprovals()).resolves.toBe(2);
    expect(useApprovalStore.getState().pendingAssignedCount).toBe(2);
    expect(fetch).toHaveBeenCalledWith('/api/approval-cards?box=assigned&status=pending&limit=100', expect.any(Object));
  });

  it('keeps the last known count when a transient refresh fails', async () => {
    localStorage.setItem('token', token());
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline'); }));
    const { refreshPendingApprovals, useApprovalStore } = await import('./approval-store');
    useApprovalStore.getState().setPendingAssignedCount(3);
    await expect(refreshPendingApprovals()).resolves.toBe(3);
    expect(useApprovalStore.getState().loading).toBe(false);
  });

  it('clears the count when there is no authenticated user', async () => {
    const { refreshPendingApprovals, useApprovalStore } = await import('./approval-store');
    useApprovalStore.getState().setPendingAssignedCount(4);
    await expect(refreshPendingApprovals()).resolves.toBe(0);
    expect(useApprovalStore.getState().pendingAssignedCount).toBe(0);
  });
});

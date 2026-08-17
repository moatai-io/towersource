/**
 * customer-scope.test.ts — Owns: tests for customer-scope.ts.
 *
 * Mocks pg-repo (no real DB) — verifies role-based branching + scope query.
 *
 * 결정: workspace/decisions/2026-05-27-operator-host-privileged-roles-and-cross-project-relaxation.md §3-E
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mocks (must be hoisted before module under test imports) ──
const queryOneMock = vi.fn();
const queryMock = vi.fn();
vi.mock('../../db/pg-repo.js', () => ({
  query: (...args: any[]) => queryMock(...args),
  queryOne: (...args: any[]) => queryOneMock(...args),
  execute: vi.fn(),
}));

const sut = await import('./customer-scope.js');

beforeEach(() => {
  queryOneMock.mockReset();
  queryMock.mockReset();
});

describe('userCanAccessCustomer', () => {
  it('admin → true without DB query', async () => {
    const ok = await sut.userCanAccessCustomer(42, 'admin', 'demo-org');
    expect(ok).toBe(true);
    expect(queryOneMock).not.toHaveBeenCalled();
  });

  it('operator → true without DB query', async () => {
    const ok = await sut.userCanAccessCustomer(42, 'operator', 'demo-org');
    expect(ok).toBe(true);
    expect(queryOneMock).not.toHaveBeenCalled();
  });

  it('customer_manager with matching row → true', async () => {
    queryOneMock.mockResolvedValueOnce({ ok: 1 });
    const ok = await sut.userCanAccessCustomer(8, 'customer_manager', 'demo-org');
    expect(ok).toBe(true);
    expect(queryOneMock).toHaveBeenCalledTimes(1);
    expect(queryOneMock.mock.calls[0][1]).toEqual([8, 'demo-org']);
  });

  it('customer_manager without matching row → false', async () => {
    queryOneMock.mockResolvedValueOnce(undefined);
    const ok = await sut.userCanAccessCustomer(8, 'customer_manager', 'hantoo');
    expect(ok).toBe(false);
  });

  it('member → false without DB query', async () => {
    const ok = await sut.userCanAccessCustomer(8, 'member', 'demo-org');
    expect(ok).toBe(false);
    expect(queryOneMock).not.toHaveBeenCalled();
  });

  it('viewer / guest / unknown role → false', async () => {
    expect(await sut.userCanAccessCustomer(8, 'viewer', 'demo-org')).toBe(false);
    expect(await sut.userCanAccessCustomer(8, 'guest', 'demo-org')).toBe(false);
    expect(await sut.userCanAccessCustomer(8, 'something', 'demo-org')).toBe(false);
    expect(await sut.userCanAccessCustomer(8, null, 'demo-org')).toBe(false);
    expect(queryOneMock).not.toHaveBeenCalled();
  });

  it('customer_manager with empty userId/customerId → false', async () => {
    expect(await sut.userCanAccessCustomer(0, 'customer_manager', 'demo-org')).toBe(false);
    expect(await sut.userCanAccessCustomer(8, 'customer_manager', '')).toBe(false);
    expect(queryOneMock).not.toHaveBeenCalled();
  });
});

describe('listAccessibleCustomers', () => {
  it('admin → null (unrestricted)', async () => {
    const r = await sut.listAccessibleCustomers(42, 'admin');
    expect(r).toBeNull();
    expect(queryMock).not.toHaveBeenCalled();
  });

  it('operator → null (unrestricted)', async () => {
    const r = await sut.listAccessibleCustomers(42, 'operator');
    expect(r).toBeNull();
  });

  it('customer_manager → returns mapped customer_id array', async () => {
    queryMock.mockResolvedValueOnce([
      { customer_id: 'uuid-oku' },
      { customer_id: 'uuid-hantoo' },
    ]);
    const r = await sut.listAccessibleCustomers(8, 'customer_manager');
    expect(r).toEqual(['uuid-oku', 'uuid-hantoo']);
    expect(queryMock).toHaveBeenCalledTimes(1);
    expect(queryMock.mock.calls[0][1]).toEqual([8]);
  });

  it('customer_manager with no mappings → empty array', async () => {
    queryMock.mockResolvedValueOnce([]);
    const r = await sut.listAccessibleCustomers(8, 'customer_manager');
    expect(r).toEqual([]);
  });

  it('member / viewer / guest → empty array, no DB query', async () => {
    expect(await sut.listAccessibleCustomers(8, 'member')).toEqual([]);
    expect(await sut.listAccessibleCustomers(8, 'viewer')).toEqual([]);
    expect(await sut.listAccessibleCustomers(8, 'guest')).toEqual([]);
    expect(await sut.listAccessibleCustomers(8, null)).toEqual([]);
    expect(queryMock).not.toHaveBeenCalled();
  });

  it('customer_manager with empty userId → empty array', async () => {
    expect(await sut.listAccessibleCustomers(0, 'customer_manager')).toEqual([]);
    expect(queryMock).not.toHaveBeenCalled();
  });
});

// fleet-manager 는 customer slug/name 을 쓰므로, 별도 join helper 로 UUID 매핑을 해석한다.
describe('userCanAccessCustomerName', () => {
  it('admin/operator → true without DB query', async () => {
    expect(await sut.userCanAccessCustomerName(1, 'admin', 'demo-org')).toBe(true);
    expect(await sut.userCanAccessCustomerName(1, 'operator', 'demo-org')).toBe(true);
    expect(queryOneMock).not.toHaveBeenCalled();
  });

  it('customer_manager with matching customer name → true', async () => {
    queryOneMock.mockResolvedValueOnce({ ok: 1 });
    expect(await sut.userCanAccessCustomerName(8, 'customer_manager', 'demo-org')).toBe(true);
    expect(queryOneMock.mock.calls[0][1]).toEqual([8, 'demo-org']);
  });

  it('customer_manager without mapping → false', async () => {
    queryOneMock.mockResolvedValueOnce(undefined);
    expect(await sut.userCanAccessCustomerName(8, 'customer_manager', 'hantoo')).toBe(false);
  });
});

describe('listAccessibleCustomerNames', () => {
  it('admin/operator → null (unrestricted)', async () => {
    expect(await sut.listAccessibleCustomerNames(1, 'admin')).toBeNull();
    expect(await sut.listAccessibleCustomerNames(1, 'operator')).toBeNull();
    expect(queryMock).not.toHaveBeenCalled();
  });

  it('customer_manager → mapped customer names', async () => {
    queryMock.mockResolvedValueOnce([{ customer_name: 'demo-org' }]);
    expect(await sut.listAccessibleCustomerNames(8, 'customer_manager')).toEqual(['demo-org']);
    expect(queryMock.mock.calls[0][1]).toEqual([8]);
  });

  it('non-manager roles → empty array', async () => {
    expect(await sut.listAccessibleCustomerNames(8, 'member')).toEqual([]);
    expect(await sut.listAccessibleCustomerNames(8, 'viewer')).toEqual([]);
  });
});

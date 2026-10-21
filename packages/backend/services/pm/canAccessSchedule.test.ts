import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the DB layer used by canAccessSchedule (queryOne against schedules table).
const queryOneMock = vi.fn();
vi.mock('../../db/pg-repo.js', () => ({
  query: vi.fn(),
  queryOne: (...args: any[]) => queryOneMock(...args),
  execute: vi.fn(),
}));

// Mock isProjectMember used for the project-member branch.
const isProjectMemberMock = vi.fn();
vi.mock('./project-membership-manager.js', () => ({
  getAccessibleProjectIds: vi.fn(),
  isProjectMember: (...args: any[]) => isProjectMemberMock(...args),
}));

// Imported after mocks so the module picks up the mocked deps.
const { canAccessSchedule } = await import('./project-access.js');

describe('canAccessSchedule', () => {
  beforeEach(() => {
    queryOneMock.mockReset();
    isProjectMemberMock.mockReset();
  });

  it('admin → denied without owner or invitation', async () => {
    const result = await canAccessSchedule('s1', 99, 'admin');
    expect(result.allowed).toBe(false);
    expect(queryOneMock).toHaveBeenCalled();
  });

  it('operator → denied without owner or invitation', async () => {
    const result = await canAccessSchedule('s1', 99, 'operator');
    expect(result.allowed).toBe(false);
    expect(queryOneMock).toHaveBeenCalled();
  });

  it('owner (user_id matches) → allowed', async () => {
    queryOneMock.mockResolvedValueOnce({ user_id: 42, project_id: null });
    const result = await canAccessSchedule('s1', 42, 'member');
    expect(result.allowed).toBe(true);
    expect(isProjectMemberMock).not.toHaveBeenCalled();
  });

  it('project member of schedule.project_id → allowed', async () => {
    queryOneMock.mockResolvedValueOnce({ user_id: 1, project_id: 'p-abc' });
    isProjectMemberMock.mockResolvedValueOnce(true);
    const result = await canAccessSchedule('s1', 42, 'member');
    expect(result.allowed).toBe(true);
    expect(isProjectMemberMock).toHaveBeenCalledWith('p-abc', 42);
  });

  it('unrelated user (not owner, not project member) → 403', async () => {
    queryOneMock.mockResolvedValueOnce({ user_id: 1, project_id: 'p-abc' });
    isProjectMemberMock.mockResolvedValueOnce(false);
    const result = await canAccessSchedule('s1', 42, 'member');
    expect(result.allowed).toBe(false);
    if (!result.allowed) {
      expect(result.status).toBe(403);
      expect(result.message).toMatch(/Access denied/i);
    }
  });

  it('schedule not found → 404', async () => {
    queryOneMock.mockResolvedValueOnce(undefined);
    const result = await canAccessSchedule('missing', 42, 'member');
    expect(result.allowed).toBe(false);
    if (!result.allowed) {
      expect(result.status).toBe(404);
      expect(result.message).toMatch(/not found/i);
    }
  });

  it('non-project schedule owned by someone else → 403', async () => {
    // project_id null and user_id != caller → no membership branch, deny.
    queryOneMock.mockResolvedValueOnce({ user_id: 1, project_id: null });
    const result = await canAccessSchedule('s1', 42, 'member');
    expect(result.allowed).toBe(false);
    if (!result.allowed) expect(result.status).toBe(403);
    expect(isProjectMemberMock).not.toHaveBeenCalled();
  });
});

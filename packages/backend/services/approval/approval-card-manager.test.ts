import { beforeEach, describe, expect, it, vi } from 'vitest';

const query = vi.fn();
const queryOne = vi.fn();
const clientQuery = vi.fn();
const execute = vi.fn();
const isPathAccessible = vi.fn(async () => true);
const canAccessSession = vi.fn(async () => ({ allowed: true as const }));
const isProjectMember = vi.fn(async () => true);

vi.mock('../../db/pg-repo.js', () => ({
  query,
  queryOne,
  execute,
  transaction: async (fn: any) => fn({ query: clientQuery }),
  withClient: () => ({ query, queryOne, execute }),
}));
vi.mock('../pm/project-access.js', () => ({
  canAccessSession,
  isPathAccessible,
  isPrivilegedRole: (role: string) => role === 'admin' || role === 'operator',
}));
vi.mock('../pm/project-membership-manager.js', () => ({ isProjectMember }));

const cardRow = {
  id: 'card-1', project_id: 'project-1', submitter_user_id: 10, approver_user_id: 20,
  source_session_id: 'session-1', source_agent_run_id: null, source_automation_run_id: null,
  request_type: 'artifact_review', title: '검토 요청', status: 'pending', current_revision_no: 1,
  resolved_by_user_id: null, resolved_at: null, due_at: null,
  created_at: '2026-07-10T00:00:00Z', updated_at: '2026-07-10T00:00:00Z',
};

function primeGet() {
  queryOne.mockImplementation(async (sql: string) => {
    if (sql.includes('FROM approval_cards')) return cardRow;
    if (sql.includes('FROM approval_card_revisions')) return { id: 'rev-1', card_id: 'card-1', revision_no: 1, summary_md: '요약', recommendation_md: null, consequence_md: '외부 실행 없음', options: [], submitted_by_user_id: 10, created_at: '2026-07-10T00:00:00Z' };
    return undefined;
  });
  query.mockImplementation(async (sql: string) => {
    if (sql.includes('approval_card_attachments')) return [];
    if (sql.includes('approval_card_events')) return [];
    return [];
  });
}

describe('approval-card-manager', () => {
  beforeEach(() => { vi.clearAllMocks(); primeGet(); });

  it('lets only the assigned approver resolve a pending card', async () => {
    const { resolveApprovalCard } = await import('./approval-card-manager.js');
    await expect(resolveApprovalCard({ id: 'card-1', userId: 30, role: 'member', resolution: 'approved' }))
      .rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('uses optimistic pending-state update and appends an event', async () => {
    clientQuery.mockResolvedValue({ rowCount: 1, rows: [{ id: 'card-1' }] });
    const { resolveApprovalCard } = await import('./approval-card-manager.js');
    const result = await resolveApprovalCard({ id: 'card-1', userId: 20, role: 'member', resolution: 'approved' });
    expect(clientQuery).toHaveBeenCalledWith(expect.stringContaining("status = 'pending'"), ['approved', 20, 'card-1']);
    expect(execute).toHaveBeenCalledWith(expect.stringContaining('approval_card_events'), expect.arrayContaining(['card-1', 20, 'approved']));
    expect(result.id).toBe('card-1');
  });

  it('rejects an approver who cannot access the Agent Workspace at submission', async () => {
    isProjectMember.mockImplementation(async (projectId: string, userId: number) => userId === 10);
    queryOne.mockImplementation(async (sql: string, params?: any[]) => {
      if (sql.includes('FROM users')) return sql.includes('SELECT role') ? { role: 'member' } : { '?column?': 1 };
      if (sql.includes('FROM projects') && params?.[1] === 20) return undefined;
      return undefined;
    });
    const { createApprovalCard } = await import('./approval-card-manager.js');
    await expect(createApprovalCard({ userId: 10, role: 'member', projectId: 'project-1', approverUserId: 20, title: '검토', summaryMd: '완료', consequenceMd: '외부 실행 없음' }))
      .rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
});

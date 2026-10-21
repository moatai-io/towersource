import { beforeEach, describe, it, expect, vi } from 'vitest';
const m = vi.hoisted(() => ({ queryOne: vi.fn(), manager: vi.fn(), operator: vi.fn() }));
vi.mock('../../db/pg-repo.js', () => ({ queryOne: m.queryOne }));
vi.mock('../credential-vault/credential-management-access.js', () => ({ assertCredentialManagementAccess: m.manager }));
vi.mock('../pm/project-access.js', () => ({ isOperatorAccessProjectPath: m.operator }));
import { assertProjectMcpAccess, assertProjectMcpManager, assertProjectMcpExecution } from './project-mcp-access.js';
beforeEach(() => { vi.clearAllMocks(); m.operator.mockResolvedValue(false); m.manager.mockResolvedValue(undefined); });
describe('Agent MCP permissions', () => {
  it('allows member read but independently requires Credential manager authority', async () => {
    m.queryOne.mockResolvedValue({ role: 'member', membership_role: 'member', root_path: '/synthetic', user_id: 5 });
    await expect(assertProjectMcpAccess('agent', 5)).resolves.toMatchObject({ role: 'member' });
    m.manager.mockRejectedValue(new Error('denied')); await expect(assertProjectMcpManager('agent', 5)).rejects.toThrow('denied');
  });
  it('does not preserve owner access after project membership revocation', async () => {
    m.queryOne.mockResolvedValue({ role: 'member', membership_role: null, root_path: '/synthetic', user_id: 5 });
    await expect(assertProjectMcpAccess('agent', 5)).rejects.toThrow('denied');
  });
  it('denies stale/disabled user and archived project via fresh query', async () => {
    m.queryOne.mockResolvedValue(undefined); await expect(assertProjectMcpAccess('agent', 5)).rejects.toThrow();
    expect(m.queryOne.mock.calls[0][0]).toContain('u.disabled = 0'); expect(m.queryOne.mock.calls[0][0]).toContain("lifecycle_status, 'active'");
  });
  it('requires scoped operator access', async () => {
    m.queryOne.mockResolvedValue({ role: 'operator', membership_role: null, root_path: '/synthetic' });
    await expect(assertProjectMcpAccess('agent', 5)).rejects.toThrow();
    m.operator.mockResolvedValue(true); await expect(assertProjectMcpAccess('agent', 5)).resolves.toBeDefined();
  });
  it('rejects read-only execution and root spoofing', async () => {
    m.queryOne.mockResolvedValue({ role: 'viewer', membership_role: 'member', root_path: '/synthetic' });
    await expect(assertProjectMcpExecution('agent', 5)).rejects.toThrow();
    m.queryOne.mockResolvedValue({ role: 'member', membership_role: 'member', root_path: '/synthetic' });
    await expect(assertProjectMcpExecution('agent', 5, '/different')).rejects.toThrow();
  });
});

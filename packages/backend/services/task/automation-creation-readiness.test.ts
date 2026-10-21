import { beforeEach, describe, expect, it, vi } from 'vitest';
const m = vi.hoisted(() => ({ access: vi.fn(), stat: vi.fn(), fsAccess: vi.fn() }));
vi.mock('../authority/agent-execution-access.js', () => ({ requireCurrentAgentExecutionAccess: m.access }));
vi.mock('node:fs/promises', () => ({ default: { stat: m.stat, access: m.fsAccess, constants: { R_OK: 4, X_OK: 1 } } }));
import { inspectAutomationCreationReadiness } from './automation-creation-readiness.js';
const input = { projectId: 'p1', userId: 7, rootPath: '/synthetic/project' };
beforeEach(() => {
  vi.clearAllMocks();
  m.access.mockResolvedValue({ userRole: 'member' });
  m.stat.mockResolvedValue({ isDirectory: () => true });
  m.fsAccess.mockResolvedValue(undefined);
});
describe('read-only automation creation preflight', () => {
  it('checks current execution authority then readable directory access', async () => {
    expect(await inspectAutomationCreationReadiness(input)).toEqual({ agentExecutionAccess: 'allowed', workspacePath: 'accessible' });
    expect(m.access).toHaveBeenCalledWith({ projectId: 'p1', userId: 7 });
    expect(m.fsAccess).toHaveBeenCalledWith(input.rootPath, 5);
  });
  it('does not inspect filesystem when current authority denies execution', async () => {
    m.access.mockRejectedValueOnce(new Error('denied'));
    await expect(inspectAutomationCreationReadiness(input)).rejects.toThrow('denied');
    expect(m.stat).not.toHaveBeenCalled();
  });
  it('rejects a non-directory workspace', async () => {
    m.stat.mockResolvedValueOnce({ isDirectory: () => false });
    await expect(inspectAutomationCreationReadiness(input)).rejects.toThrow('WORKSPACE_ROOT_NOT_DIRECTORY');
    expect(m.fsAccess).not.toHaveBeenCalled();
  });
  it('rejects an unreadable workspace', async () => {
    m.fsAccess.mockRejectedValueOnce(new Error('EACCES'));
    await expect(inspectAutomationCreationReadiness(input)).rejects.toThrow('EACCES');
  });
});

import { describe, expect, it, vi, beforeEach } from 'vitest';

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  tool: (name: string, _description: string, _schema: unknown, handler: unknown) => ({ name, handler }),
  createSdkMcpServer: (config: unknown) => config,
}));
vi.mock('../services/task/automation-manager.js', () => ({
  getAutomation: vi.fn(async () => ({ id: 'automation-1', userId: 99, projectId: 'other-project' })),
  getAutomationRuns: vi.fn(async () => []), createAutomation: vi.fn(),
  logRun: vi.fn(), recordAutomationRuntimeResult: vi.fn(), updateAutomation: vi.fn(), deleteAutomation: vi.fn(),
}));
vi.mock('../services/pm/project-membership-manager.js', () => ({ isProjectMember: vi.fn(async () => false) }));
vi.mock('../services/runtime-box/policy.js', () => ({ isRuntimeBoxEnabled: vi.fn(() => true) }));
vi.mock('../services/task/automation-runners.js', () => ({ runAutomationJob: vi.fn() }));
vi.mock('../services/process/process-map-manager.js', () => ({ appendProcessEvent: vi.fn() }));
vi.mock('../services/notification-hub.js', () => ({ notifyExecutionReport: vi.fn() }));
vi.mock('../services/task/automation-change-intent.js', () => ({ createAutomationChangeIntent: vi.fn(), applyAutomationChangeIntent: vi.fn() }));
vi.mock('../services/task/schedule-inventory.js', () => ({ listScheduleInventory: vi.fn(), setLegacyScheduledTaskEnabled: vi.fn() }));

import { createScheduleMcpServer } from './schedule-server.js';
import { isProjectMember } from '../services/pm/project-membership-manager.js';
import { getAutomationRuns } from '../services/task/automation-manager.js';
import { runAutomationJob } from '../services/task/automation-runners.js';

function server(role?: string, userId = 1) {
  return createScheduleMcpServer({ sessionId: 'session-1', userId, userRole: role }) as unknown as {
    tools: Array<{ name: string; handler: (args: Record<string, unknown>) => Promise<any> }>;
  };
}
async function call(name: string, role?: string, userId = 1) {
  // Forged tool arguments must never replace the closure-bound role.
  return server(role, userId).tools.find(t => t.name === name)!.handler({ automationId: 'automation-1', role: 'admin', userRole: 'admin' });
}

beforeEach(() => { vi.clearAllMocks(); vi.mocked(isProjectMember).mockResolvedValue(false); });
describe('schedule MCP trusted actor authorization', () => {
  it.each(['admin', 'operator'])('preserves %s for cross-project read and history through the real access gate', async role => {
    expect((await call('get_automation', role)).isError).not.toBe(true);
    expect((await call('get_automation_runs', role)).isError).not.toBe(true);
    expect(getAutomationRuns).toHaveBeenCalledWith('automation-1', 10);
    expect(isProjectMember).not.toHaveBeenCalled();
  });
  it.each(['member', undefined])('rejects unrelated %s actors even with forged role arguments', async role => {
    for (const name of ['get_automation', 'get_automation_runs', 'propose_automation_change', 'set_automation_enabled', 'run_automation_now', 'archive_automation']) {
      expect((await call(name, role)).isError).toBe(true);
    }
    expect(getAutomationRuns).not.toHaveBeenCalled();
    expect(runAutomationJob).not.toHaveBeenCalled();
  });
  it('preserves owner reads without requiring an operator role', async () => {
    expect((await call('get_automation', 'member', 99)).isError).not.toBe(true);
  });
  it('allows project-member reads but not execution control', async () => {
    vi.mocked(isProjectMember).mockResolvedValue(true);
    expect((await call('get_automation', 'member')).isError).not.toBe(true);
    expect((await call('run_automation_now', 'member')).isError).toBe(true);
    expect(runAutomationJob).not.toHaveBeenCalled();
  });
});

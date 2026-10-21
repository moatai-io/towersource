import { describe, expect, it, vi } from 'vitest';
import { executeWorkbenchRequest, type WorkbenchExecutionProvider } from '../../execution/execution-broker.js';
import { authorizeTowerAction, type TowerRole } from '../authorization-policy.js';

const result = { exit_code: 0, stdout: 'executed', stderr: '', duration_ms: 1, timed_out: false, oom_killed: false, runtime_context: {} } as any;
function provider(): WorkbenchExecutionProvider {
  return {
    kind: 'local-runtime',
    executeForeground: vi.fn().mockResolvedValue(result),
    enqueueJob: vi.fn(),
    startService: vi.fn(),
    releaseReservation: vi.fn().mockResolvedValue(undefined),
  };
}

const cases = [
  ['admin', true],
  ['operator', true],
  ['member', true],
  ['viewer', false],
  ['guest', false],
] as const satisfies ReadonlyArray<readonly [TowerRole, boolean]>;

describe('Workbench authority acceptance contract', () => {
  it.each(cases)('keeps policy and broker execution aligned for %s', async (role, allowed) => {
    const executionProvider = provider();
    const policy = authorizeTowerAction({ role, resource: 'worker', action: 'execute', facts: { projectMember: true } });
    expect(policy.allowed).toBe(allowed);

    const execution = executeWorkbenchRequest({
      request: { command: 'pwd', lifecycle: 'foreground' },
      context: { projectId: 'project-a', userId: 7, sessionId: 'session-a', userRole: role, projectMember: true },
      provider: executionProvider,
    });
    if (allowed) {
      await expect(execution).resolves.toMatchObject({ execution: { outcome: { ok: true }, result } });
      expect(executionProvider.executeForeground).toHaveBeenCalledOnce();
      expect(executionProvider.releaseReservation).not.toHaveBeenCalled();
    } else {
      await expect(execution).rejects.toThrow('WORKBENCH_EXECUTION_DENIED');
      expect(executionProvider.executeForeground).not.toHaveBeenCalled();
      expect(executionProvider.releaseReservation).toHaveBeenCalledOnce();
    }
  });

  it('keeps the legacy role-less internal caller path explicit until its compatibility window closes', async () => {
    const executionProvider = provider();
    await expect(executeWorkbenchRequest({
      request: { command: 'pwd', lifecycle: 'foreground' },
      context: { projectId: 'project-a', userId: 7, sessionId: 'session-a', projectMember: true },
      provider: executionProvider,
    })).resolves.toMatchObject({ execution: { outcome: { ok: true } } });
    // User-facing Pi callers are separately required by source-contract tests to pass userRole.
  });
});

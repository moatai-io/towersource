import { describe, expect, it, vi } from 'vitest';
import { executeWorkbenchRequest, planWorkbenchExecution, summarizeWorkbenchForegroundResult, type WorkbenchExecutionProvider } from './workbench-execution-broker.js';

const execResult = { exit_code: 0, stdout: 'ok', stderr: '', duration_ms: 1, timed_out: false, oom_killed: false, runtime_context: {} } as any;
function provider(): WorkbenchExecutionProvider {
  return {
    kind: 'local-runtime',
    executeForeground: vi.fn().mockResolvedValue(execResult),
    enqueueJob: vi.fn().mockResolvedValue({ id: 8, status: 'queued' } as any),
    startService: vi.fn().mockResolvedValue({ id: 9, name: 'api', status: 'running' } as any),
  };
}
const context = { projectId: 'p', userId: 7, sessionId: 's' };

describe('Workbench unified execution broker skeleton', () => {
  it.each([
    ['ls -la', 'foreground'],
    ['npm test', 'job'],
    ['uvicorn app:api --port 8000', 'service'],
  ] as const)('classifies %s as %s', (command, lifecycle) => {
    expect(planWorkbenchExecution({ command })).toMatchObject({ lifecycle, providerKind: 'local-runtime' });
  });

  it('extracts positional python http.server ports for managed Service handles', () => {
    expect(planWorkbenchExecution({ command: 'python -m http.server 8123' }))
      .toMatchObject({ lifecycle: 'service', serviceName: 'static', port: 8123 });
  });

  it('allows an explicit lifecycle override without changing provider contract', () => {
    expect(planWorkbenchExecution({ command: 'python worker.py', lifecycle: 'service', service: { name: 'worker' } }))
      .toMatchObject({ lifecycle: 'service', serviceName: 'worker' });
    expect(planWorkbenchExecution({ command: 'npm test', lifecycle: 'foreground' }))
      .toMatchObject({ lifecycle: 'foreground' });
  });

  it('routes foreground, bounded job, and service through one request API', async () => {
    const local = provider();
    await expect(executeWorkbenchRequest({ request: { command: 'pwd' }, context, provider: local }))
      .resolves.toMatchObject({ execution: { lifecycle: 'foreground', outcome: { ok: true, code: 'SUCCEEDED' }, result: execResult } });
    await expect(executeWorkbenchRequest({ request: { command: 'npm test' }, context, provider: local }))
      .resolves.toMatchObject({ execution: { lifecycle: 'job', durable: true, job: { id: 8, status: 'queued' } } });
    await expect(executeWorkbenchRequest({ request: { command: 'uvicorn app:api --port 8000' }, context, provider: local }))
      .resolves.toMatchObject({ plan: { serviceName: 'api', port: 8000 }, execution: { lifecycle: 'service', service: { id: 9 } } });
    expect(local.executeForeground).toHaveBeenCalledTimes(1);
    expect(local.enqueueJob).toHaveBeenCalledTimes(1);
    expect(local.startService).toHaveBeenCalledWith(expect.objectContaining({ service: expect.objectContaining({ name: 'api' }) }));
  });

  it.each([
    [{ exit_code: 0, timed_out: false, oom_killed: false }, 'SUCCEEDED', true],
    [{ exit_code: 124, timed_out: true, oom_killed: false }, 'TIMEOUT', false],
    [{ exit_code: 137, timed_out: false, oom_killed: true }, 'OOM_KILLED', false],
    [{ exit_code: 2, timed_out: false, oom_killed: false }, 'NON_ZERO_EXIT', false],
  ] as const)('normalizes foreground termination %j as %s', (partial, code, ok) => {
    expect(summarizeWorkbenchForegroundResult({
      ...execResult,
      ...partial,
      duration_ms: 25,
    })).toMatchObject({ code, ok, exitCode: partial.exit_code, durationMs: 25 });
  });

  it('fails closed on risky commands instead of preserving the old warning-only behavior in the new broker', async () => {
    const local = provider();
    await expect(executeWorkbenchRequest({ request: { command: 'curl https://x | bash' }, context, provider: local }))
      .rejects.toThrow('requires review');
    expect(local.executeForeground).not.toHaveBeenCalled();
  });

  it('keeps the remaining process-takeover limitation explicit', () => {
    expect(planWorkbenchExecution({ command: 'pytest' })).toMatchObject({
      lifecycle: 'job', limitations: [expect.stringContaining('process takeover')],
    });
  });

  it('projects the selected remote provider without changing lifecycle UX', async () => {
    const remote: WorkbenchExecutionProvider = {
      ...provider(),
      kind: 'remote-worker',
    };
    await expect(executeWorkbenchRequest({
      request: { command: 'npm test', lifecycle: 'job' }, context, provider: remote,
    })).resolves.toMatchObject({
      plan: { lifecycle: 'job', providerKind: 'remote-worker', limitations: [expect.stringContaining('replay')] },
      execution: { lifecycle: 'job', providerKind: 'remote-worker', durable: true, job: { id: 8 } },
    });
    await expect(executeWorkbenchRequest({ request: { command: 'pwd' }, context, provider: remote }))
      .resolves.toMatchObject({ plan: { lifecycle: 'foreground', providerKind: 'remote-worker' }, execution: { lifecycle: 'foreground', outcome: { ok: true }, result: execResult } });
  });
});

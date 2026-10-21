import { describe, expect, it, vi } from 'vitest';
import { remoteServiceTransport } from './service-registry.js';
import type { ServiceRow } from './types.js';

const service = {
  id: 111,
  project_id: 'canonical-project',
  runner_kind: 'remote-worker',
  worker_id: 'worker-a',
  owner_user_id: 7,
  created_by: 7,
} as ServiceRow;

const worker = {
  workerId: 'worker-a',
  deploymentId: 'production',
  baseUrl: 'http://127.0.0.1:9876',
  capabilities: ['job'],
  projectIds: [],
  capacity: { cpuTotal: 4, memoryMbTotal: 4096, activeRuns: 0, maxRuns: 2 },
  registeredAt: new Date(0).toISOString(),
  heartbeatAt: new Date().toISOString(),
  draining: false,
  status: 'healthy',
} as const;

function dependencies(authority: { storage_kind: 'host' | 'worker'; worker_id: string | null; state: 'ready' | 'blocked' }) {
  return {
    getWorker: vi.fn().mockResolvedValue(worker),
    listAuthorities: vi.fn().mockResolvedValue([{
      project_id: service.project_id,
      deployment_id: 'production',
      version: 1,
      ...authority,
    }]),
    deploymentId: 'production',
    resolveToken: vi.fn().mockResolvedValue('transport-token'),
    readProjectRoot: vi.fn().mockResolvedValue('/srv/projects/canonical-project'),
    createTransport: vi.fn().mockReturnValue({ workerId: 'worker-a', execute: vi.fn() }),
  };
}

describe('Worker-lite remote Service control', () => {
  it('allows a persisted unscoped Worker to control a canonical host/ready Project Service', async () => {
    const deps = dependencies({ storage_kind: 'host', worker_id: null, state: 'ready' });
    await expect(remoteServiceTransport(service, 7, deps)).resolves.toBeDefined();
    expect(deps.resolveToken).toHaveBeenCalledWith('worker-a', 7);
    expect(deps.readProjectRoot).toHaveBeenCalledWith('canonical-project');
    expect(deps.createTransport).toHaveBeenCalledWith(expect.objectContaining({
      workerId: 'worker-a', projectRoot: '/srv/projects/canonical-project',
    }));
  });

  it.each([
    ['legacy Worker storage', { storage_kind: 'worker' as const, worker_id: 'worker-a', state: 'ready' as const }],
    ['blocked canonical storage', { storage_kind: 'host' as const, worker_id: null, state: 'blocked' as const }],
  ])('keeps static Worker scope required for %s', async (_label, authority) => {
    const deps = dependencies(authority);
    await expect(remoteServiceTransport(service, 7, deps)).rejects.toThrow('worker worker-a is unavailable for service 111');
    expect(deps.resolveToken).not.toHaveBeenCalled();
    expect(deps.readProjectRoot).not.toHaveBeenCalled();
  });

  it('fails closed when canonical storage has no registered Project root', async () => {
    const deps = dependencies({ storage_kind: 'host', worker_id: null, state: 'ready' });
    deps.readProjectRoot.mockResolvedValue(undefined);
    await expect(remoteServiceTransport(service, 7, deps)).rejects.toThrow('canonical Project root is unavailable');
    expect(deps.createTransport).not.toHaveBeenCalled();
  });
});

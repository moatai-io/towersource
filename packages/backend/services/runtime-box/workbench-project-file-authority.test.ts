import { beforeEach, describe, expect, it, vi } from 'vitest';
import { query } from '../../db/pg-repo.js';
import { getPersistedWorkbenchWorker } from './workbench-worker-repository.js';
import { resolveWorkerFileAuthorityForHostPath } from './workbench-project-file-authority.js';

vi.mock('../../db/pg-repo.js', () => ({ query: vi.fn() }));
vi.mock('./workbench-worker-repository.js', () => ({ getPersistedWorkbenchWorker: vi.fn() }));
vi.mock('./workbench-worker-transport-credentials.js', () => ({ resolveWorkbenchWorkerTransportToken: vi.fn() }));
vi.mock('./workbench-remote-http-transport.js', () => ({ createRemoteWorkbenchHttpTransport: vi.fn() }));

beforeEach(() => vi.clearAllMocks());

describe('Worker Project file authority', () => {
  it('maps a host Project path to the Worker-local relative path for workstation Projects', async () => {
    vi.mocked(query).mockResolvedValue([
      { project_id: 'project-a', root_path: '/workspace/projects/project-a', default_worker_id: 'worker-a' },
    ]);
    vi.mocked(getPersistedWorkbenchWorker).mockResolvedValue({
      workerId: 'worker-a', baseUrl: 'http://worker-a', capabilities: ['job'], projectIds: ['project-a'],
      capacity: { cpuTotal: 2, memoryMbTotal: 2048, activeRuns: 0, maxRuns: 1 },
      draining: false, registeredAt: new Date(0).toISOString(), heartbeatAt: new Date(0).toISOString(), status: 'healthy',
    });

    await expect(resolveWorkerFileAuthorityForHostPath('/workspace/projects/project-a/docs/readme.md')).resolves.toEqual({
      projectId: 'project-a',
      projectRoot: '/workspace/projects/project-a',
      relativePath: 'docs/readme.md',
      workerId: 'worker-a',
      workerBaseUrl: 'http://worker-a',
    });
  });

  it('does not claim paths outside workstation Projects or unhealthy Workers', async () => {
    vi.mocked(query).mockResolvedValue([
      { project_id: 'project-a', root_path: '/workspace/projects/project-a', default_worker_id: 'worker-a' },
    ]);
    await expect(resolveWorkerFileAuthorityForHostPath('/workspace/projects/other/file.md')).resolves.toBeUndefined();
    vi.mocked(getPersistedWorkbenchWorker).mockResolvedValueOnce({
      workerId: 'worker-a', baseUrl: 'http://worker-a', capabilities: ['job'], projectIds: ['project-a'],
      capacity: { cpuTotal: 2, memoryMbTotal: 2048, activeRuns: 0, maxRuns: 1 },
      draining: false, registeredAt: new Date(0).toISOString(), heartbeatAt: new Date(0).toISOString(), status: 'stale',
    });
    await expect(resolveWorkerFileAuthorityForHostPath('/workspace/projects/project-a/file.md')).resolves.toBeUndefined();
  });

  it('uses the longest matching root when Projects are nested by path', async () => {
    vi.mocked(query).mockResolvedValue([
      { project_id: 'nested', root_path: '/workspace/projects/project-a/sub', default_worker_id: 'worker-b' },
      { project_id: 'parent', root_path: '/workspace/projects/project-a', default_worker_id: 'worker-a' },
    ]);
    vi.mocked(getPersistedWorkbenchWorker).mockResolvedValue({
      workerId: 'worker-b', baseUrl: 'http://worker-b', capabilities: ['job'], projectIds: ['nested'],
      capacity: { cpuTotal: 2, memoryMbTotal: 2048, activeRuns: 0, maxRuns: 1 },
      draining: false, registeredAt: new Date(0).toISOString(), heartbeatAt: new Date(0).toISOString(), status: 'healthy',
    });
    await expect(resolveWorkerFileAuthorityForHostPath('/workspace/projects/project-a/sub/a.txt')).resolves.toMatchObject({
      projectId: 'nested', relativePath: 'a.txt', workerId: 'worker-b',
    });
  });
});

vi.mock('../project-environment/project-environment-deployment.js', () => ({ resolveProjectEnvironmentDeploymentId: () => 'test-deployment' }));
import { readLegacyProjectComputePlacement } from '../project-environment/adapters/legacy-project-compute-adapter.js';
vi.mock('../project-environment/adapters/legacy-project-compute-adapter.js', () => ({ readLegacyProjectComputePlacement: vi.fn() }));
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { query } from '../../db/pg-repo.js';
import { getPersistedWorkbenchWorker } from '../execution/worker/worker-repository.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { assertProjectSharedMutationForHostPath, resolveWorkerFileAuthorityForHostPath } from './workbench-project-file-authority.js';

vi.mock('../../db/pg-repo.js', () => ({ query: vi.fn() }));
vi.mock('../execution/worker/worker-repository.js', () => ({ getPersistedWorkbenchWorker: vi.fn() }));
vi.mock('../execution/worker/worker-transport-credentials.js', () => ({ resolveWorkbenchWorkerTransportToken: vi.fn() }));
vi.mock('../execution/worker/worker-http-transport.js', () => ({ createRemoteWorkbenchHttpTransport: vi.fn() }));

const roots: string[] = [];

it('selects the requested live Project when a retired same-root alias is outside Worker scope', async () => {
  vi.mocked(query).mockResolvedValue([
    { project_id: 'retired-project', root_path: '/workspace/general', archived: 1, lifecycle_status: 'retired' },
    { project_id: 'live-project', root_path: '/workspace/general', archived: 0, lifecycle_status: 'active' },
  ]);
  vi.mocked(readLegacyProjectComputePlacement).mockResolvedValue({ defaultWorkerId: 'shared-worker', workstationMode: true, source: 'binding' });
  vi.mocked(getPersistedWorkbenchWorker).mockResolvedValue({ workerId: 'shared-worker', deploymentId: 'test-deployment', status: 'healthy', baseUrl: 'http://worker', projectIds: ['live-project'] } as any);
  const expected = { projectId: 'live-project', projectRoot: '/workspace/general' };
  expect(await resolveWorkerFileAuthorityForHostPath('/workspace/general/uploads/a.txt', expected)).toMatchObject({ projectId: 'live-project', relativePath: 'uploads/a.txt' });
  expect(readLegacyProjectComputePlacement).toHaveBeenCalledWith('live-project', 'test-deployment');
  expect(readLegacyProjectComputePlacement).not.toHaveBeenCalledWith('retired-project', expect.anything());
  const actualRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tower-same-root-')); roots.push(actualRoot);
  vi.mocked(query).mockResolvedValue([
    { project_id: 'retired-project', root_path: actualRoot, archived: 1, lifecycle_status: 'retired' },
    { project_id: 'live-project', root_path: actualRoot, archived: 0, lifecycle_status: 'active' },
  ]);
  expect(await assertProjectSharedMutationForHostPath(path.join(actualRoot, 'uploads/a.txt'))).toMatchObject({ projectId: 'live-project' });
});

it('rejects duplicate active path-only roots before reading Worker bindings', async () => {
  vi.mocked(query).mockResolvedValue([
    { project_id: 'a', root_path: '/workspace/general', archived: 0, lifecycle_status: 'active' },
    { project_id: 'b', root_path: '/workspace/general', archived: 0, lifecycle_status: 'active' },
  ]);
  await expect(resolveWorkerFileAuthorityForHostPath('/workspace/general/a')).rejects.toThrow('AUTHORITY_AMBIGUOUS');
  await expect(assertProjectSharedMutationForHostPath('/workspace/general/a')).rejects.toThrow('AUTHORITY_AMBIGUOUS');
  expect(getPersistedWorkbenchWorker).not.toHaveBeenCalled();
});
beforeEach(() => { vi.clearAllMocks(); vi.mocked(readLegacyProjectComputePlacement).mockResolvedValue({ workstationMode: true, defaultWorkerId: 'worker-a' } as any); });
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

describe('Project storage mutation boundary', () => {
  it('allows shared Project paths but denies managed and private namespaces for every role path', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tower-project-authority-')); roots.push(root);
    vi.mocked(query).mockResolvedValue([{ project_id: 'p', root_path: root }]);
    await expect(assertProjectSharedMutationForHostPath(path.join(root, 'uploads/a.txt'))).resolves.toMatchObject({ projectId: 'p', relativePath: 'uploads/a.txt' });
    for (const relative of ['.tower/x', '.git/config', '.tower-run-credentials/run/x', '.env']) {
      await expect(assertProjectSharedMutationForHostPath(path.join(root, relative))).rejects.toThrow('PROJECT_STORAGE_NAMESPACE_DENIED');
    }
  });

  it('rejects a symlink ancestor and leaves non-Project paths unchanged', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tower-project-authority-')); roots.push(root);
    fs.symlinkSync('/tmp', path.join(root, 'link'));
    vi.mocked(query).mockResolvedValue([{ project_id: 'p', root_path: root }]);
    await expect(assertProjectSharedMutationForHostPath(path.join(root, 'link/a'))).rejects.toThrow('PROJECT_STORAGE_ANCESTOR_UNTRUSTED');
    await expect(assertProjectSharedMutationForHostPath('/unrelated/a')).resolves.toBeUndefined();
  });
});

describe('Worker Project file authority', () => {
  it('maps a host Project path to the Worker-local relative path for workstation Projects', async () => {
    vi.mocked(query).mockResolvedValue([
      { project_id: 'project-a', root_path: '/workspace/projects/project-a', default_worker_id: 'worker-a' },
    ]);
    vi.mocked(getPersistedWorkbenchWorker).mockResolvedValue({
      workerId: 'worker-a', deploymentId: 'test-deployment', baseUrl: 'http://worker-a', capabilities: ['job'], projectIds: ['project-a'],
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

  it('leaves unrelated paths alone but rejects unavailable bound storage', async () => {
    vi.mocked(query).mockResolvedValue([
      { project_id: 'project-a', root_path: '/workspace/projects/project-a', default_worker_id: 'worker-a' },
    ]);
    await expect(resolveWorkerFileAuthorityForHostPath('/workspace/projects/other/file.md')).resolves.toBeUndefined();
    vi.mocked(getPersistedWorkbenchWorker).mockResolvedValueOnce({
      workerId: 'worker-a', deploymentId: 'test-deployment', baseUrl: 'http://worker-a', capabilities: ['job'], projectIds: ['project-a'],
      capacity: { cpuTotal: 2, memoryMbTotal: 2048, activeRuns: 0, maxRuns: 1 },
      draining: false, registeredAt: new Date(0).toISOString(), heartbeatAt: new Date(0).toISOString(), status: 'stale',
    });
    await expect(resolveWorkerFileAuthorityForHostPath('/workspace/projects/project-a/file.md')).rejects.toThrow('WORKER_FILE_AUTHORITY_UNAVAILABLE');
  });

  it('rejects a bound Worker that lacks Project scope rather than selecting host storage', async () => {
    vi.mocked(query).mockResolvedValue([
      { project_id: 'project-a', root_path: '/workspace/projects/project-a', default_worker_id: 'worker-a' },
    ]);
    vi.mocked(getPersistedWorkbenchWorker).mockResolvedValue({
      workerId: 'worker-a', deploymentId: 'test-deployment', baseUrl: 'http://worker-a', capabilities: ['job'], projectIds: ['other-project'],
      capacity: { cpuTotal: 2, memoryMbTotal: 2048, activeRuns: 0, maxRuns: 1 },
      draining: false, registeredAt: new Date(0).toISOString(), heartbeatAt: new Date(0).toISOString(), status: 'healthy',
    });

    await expect(resolveWorkerFileAuthorityForHostPath('/workspace/projects/project-a/file.md')).rejects.toThrow('WORKER_FILE_AUTHORITY_SCOPE_MISMATCH');
  });

  it('uses the longest matching root when Projects are nested by path', async () => {
    vi.mocked(readLegacyProjectComputePlacement).mockResolvedValue({ workstationMode: true, defaultWorkerId: 'worker-b' } as any);
    vi.mocked(query).mockResolvedValue([
      { project_id: 'nested', root_path: '/workspace/projects/project-a/sub', default_worker_id: 'worker-b' },
      { project_id: 'parent', root_path: '/workspace/projects/project-a', default_worker_id: 'worker-a' },
    ]);
    vi.mocked(getPersistedWorkbenchWorker).mockResolvedValue({
      workerId: 'worker-b', deploymentId: 'test-deployment', baseUrl: 'http://worker-b', capabilities: ['job'], projectIds: ['nested'],
      capacity: { cpuTotal: 2, memoryMbTotal: 2048, activeRuns: 0, maxRuns: 1 },
      draining: false, registeredAt: new Date(0).toISOString(), heartbeatAt: new Date(0).toISOString(), status: 'healthy',
    });
    await expect(resolveWorkerFileAuthorityForHostPath('/workspace/projects/project-a/sub/a.txt')).resolves.toMatchObject({
      projectId: 'nested', relativePath: 'a.txt', workerId: 'worker-b',
    });
  });
});

 it('fails closed when a bound Worker lookup throws', async () => {
  vi.mocked(query).mockResolvedValue([{ project_id: 'p', root_path: '/workspace/projects/p', default_worker_id: 'w' }]);
  vi.mocked(getPersistedWorkbenchWorker).mockRejectedValueOnce(new Error('private backend details'));
  await expect(resolveWorkerFileAuthorityForHostPath('/workspace/projects/p/a.txt')).rejects.toThrow('WORKER_FILE_AUTHORITY_LOOKUP_FAILED');
 });

it('uses shared binding resolution rather than a separate SQL preference policy', async () => {
  vi.mocked(query).mockResolvedValue([{ project_id: 'p', root_path: '/workspace/projects/p' }]);
  vi.mocked(readLegacyProjectComputePlacement).mockResolvedValue({ workstationMode: false } as any);
  expect(await resolveWorkerFileAuthorityForHostPath('/workspace/projects/p/a')).toBeUndefined();
  expect(readLegacyProjectComputePlacement).toHaveBeenCalledWith('p', expect.any(String));
  expect(getPersistedWorkbenchWorker).not.toHaveBeenCalled();
});

it('rejects a healthy Worker belonging to a different deployment', async () => {
 vi.mocked(query).mockResolvedValue([{ project_id: 'p', root_path: '/workspace/projects/p' }]);
 vi.mocked(getPersistedWorkbenchWorker).mockResolvedValue({ workerId: 'worker-a', deploymentId: 'other', status: 'healthy', projectIds: ['p'] } as any);
 await expect(resolveWorkerFileAuthorityForHostPath('/workspace/projects/p/a')).rejects.toThrow('DEPLOYMENT_MISMATCH');
});
it('does not inherit parent storage for a disabled nested Project', async () => {
 vi.mocked(query).mockResolvedValue([{ project_id: 'child', root_path: '/workspace/projects/p/child' }, { project_id: 'p', root_path: '/workspace/projects/p' }]);
 vi.mocked(readLegacyProjectComputePlacement).mockResolvedValue({ workstationMode: false } as any);
 expect(await resolveWorkerFileAuthorityForHostPath('/workspace/projects/p/child/a')).toBeUndefined();
 expect(readLegacyProjectComputePlacement).toHaveBeenCalledTimes(1);
 expect(readLegacyProjectComputePlacement).toHaveBeenCalledWith('child', 'test-deployment');
 expect(getPersistedWorkbenchWorker).not.toHaveBeenCalled();
});
it('rejects enabled Workstation binding without a Worker instead of host fallback', async () => {
 vi.mocked(query).mockResolvedValue([{ project_id: 'p', root_path: '/workspace/projects/p' }]);
 vi.mocked(readLegacyProjectComputePlacement).mockResolvedValue({ workstationMode: true, defaultWorkerId: null } as any);
 await expect(resolveWorkerFileAuthorityForHostPath('/workspace/projects/p/a')).rejects.toThrow('BINDING_INCOMPLETE');
 expect(getPersistedWorkbenchWorker).not.toHaveBeenCalled();
});

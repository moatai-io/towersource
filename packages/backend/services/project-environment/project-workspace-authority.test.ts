import { beforeEach, expect, it, vi } from 'vitest';
import { query, queryOne } from '../../db/pg-repo.js';
import { readLegacyProjectComputePlacement } from './adapters/legacy-project-compute-adapter.js';
import { provisionCanonicalProjectWorkspace, resolveProjectWorkspaceTarget, type ProjectWorkspaceAuthority } from './project-workspace-authority.js';
import { resolveWorkerFileAuthorityForHostPath } from '../runtime-box/workbench-project-file-authority.js';
import { getPersistedWorkbenchWorker } from '../execution/worker/worker-repository.js';
import { classifyProjectWorkerAuthorityRow } from '../runtime-box/workbench-project-worker-authority-audit.js';
vi.mock('../../db/pg-repo.js', () => ({ query: vi.fn(), queryOne: vi.fn() }));
vi.mock('./adapters/legacy-project-compute-adapter.js', () => ({ readLegacyProjectComputePlacement: vi.fn() }));
vi.mock('./project-environment-deployment.js', () => ({ resolveProjectEnvironmentDeploymentId: () => 'production' }));
vi.mock('../execution/worker/worker-repository.js', () => ({ getPersistedWorkbenchWorker: vi.fn() }));
vi.mock('../execution/worker/worker-transport-credentials.js', () => ({ resolveWorkbenchWorkerTransportToken: vi.fn() }));
vi.mock('../execution/worker/worker-http-transport.js', () => ({ createRemoteWorkbenchHttpTransport: vi.fn() }));
const host: ProjectWorkspaceAuthority = { project_id: 'p', deployment_id: 'production', storage_kind: 'host', worker_id: null, state: 'ready', version: 1 };
function rows(binding: ProjectWorkspaceAuthority) {
  vi.mocked(query).mockImplementation(async sql => sql.includes('FROM projects ') ? [{ project_id: 'p', root_path: '/workspace/p' }] : [binding]);
}
beforeEach(() => vi.resetAllMocks());
it('provisions a new canonical host workspace without a Worker binding', async () => {
  vi.mocked(queryOne).mockResolvedValue(host);
  await expect(provisionCanonicalProjectWorkspace({ projectId: 'p', deploymentId: 'production' })).resolves.toEqual(host);
  const [sql, params] = vi.mocked(queryOne).mock.calls[0];
  expect(sql).toContain("VALUES($1,$2,'host',NULL,'ready',1)");
  expect(sql).toContain('ON CONFLICT(project_id,deployment_id) DO NOTHING');
  expect(params).toEqual(['p', 'production']);
});
it('keeps idempotent canonical provisioning but rejects an existing legacy binding', async () => {
  vi.mocked(queryOne).mockResolvedValue(undefined);
  vi.mocked(query).mockResolvedValue([host]);
  await expect(provisionCanonicalProjectWorkspace({ projectId: 'p', deploymentId: 'production' })).resolves.toEqual(host);
  vi.mocked(query).mockResolvedValue([{ ...host, storage_kind: 'worker', worker_id: 'legacy-w' }]);
  await expect(provisionCanonicalProjectWorkspace({ projectId: 'p', deploymentId: 'production' })).rejects.toThrow('ALREADY_BOUND_DIFFERENTLY');
});
it('uses verified explicit host storage without consulting compute or Worker health', async () => {
  rows(host);
  expect(await resolveWorkerFileAuthorityForHostPath('/workspace/p/file.html')).toBeUndefined();
  expect(readLegacyProjectComputePlacement).not.toHaveBeenCalled();
  expect(getPersistedWorkbenchWorker).not.toHaveBeenCalled();
});
it('uses a dedicated storage Worker independent of the execution Worker', async () => {
  rows({ ...host, storage_kind: 'worker', worker_id: 'storage-w' });
  vi.mocked(getPersistedWorkbenchWorker).mockResolvedValue({ workerId: 'storage-w', deploymentId: 'production', status: 'healthy', projectIds: ['p'], baseUrl: 'http://worker.example.com' } as any);
  expect(await resolveWorkerFileAuthorityForHostPath('/workspace/p/file.html')).toMatchObject({ workerId: 'storage-w', relativePath: 'file.html' });
  expect(readLegacyProjectComputePlacement).not.toHaveBeenCalled();
});
it.each(['pending', 'blocked'] as const)('never falls back for explicit %s storage', async state => {
  rows({ ...host, state });
  await expect(resolveWorkerFileAuthorityForHostPath('/workspace/p/a')).rejects.toThrow('WORKSPACE_STORAGE_NOT_READY');
  expect(readLegacyProjectComputePlacement).not.toHaveBeenCalled();
});
it('retains scope protection for explicit Worker storage', async () => {
  rows({ ...host, storage_kind: 'worker', worker_id: 'w' });
  vi.mocked(getPersistedWorkbenchWorker).mockResolvedValue({ workerId: 'w', deploymentId: 'production', status: 'healthy', projectIds: [] } as any);
  await expect(resolveWorkerFileAuthorityForHostPath('/workspace/p/a')).rejects.toThrow('SCOPE_MISMATCH');
});
it('preserves legacy routing only for absent records or the specific missing table', async () => {
  vi.mocked(query).mockResolvedValue([]);
  await resolveProjectWorkspaceTarget('p', 'production');
  expect(readLegacyProjectComputePlacement).toHaveBeenCalledWith('p', 'production');
  vi.mocked(query).mockRejectedValue(Object.assign(new Error('relation "project_file_storage_bindings" does not exist'), { code: '42P01' }));
  await resolveProjectWorkspaceTarget('p', 'production');
  expect(readLegacyProjectComputePlacement).toHaveBeenCalledTimes(2);
});
it('does not downgrade DB failures or malformed records into host reads', async () => {
  vi.mocked(query).mockRejectedValue(new Error('database unavailable'));
  await expect(resolveProjectWorkspaceTarget('p', 'production')).rejects.toThrow('database unavailable');
  rows({ ...host, worker_id: 'unexpected' });
  await expect(resolveProjectWorkspaceTarget('p', 'production')).rejects.toThrow('CONFIGURATION_CONFLICT');
  expect(readLegacyProjectComputePlacement).not.toHaveBeenCalled();
});
it('audit agrees with explicit host even when legacy execution has no static scope', () => {
  const row = { project_id: 'p', project_name: 'P', root_path: '/workspace/p', settings_worker_id: 'w', settings_workstation_mode: false, binding_worker_id: 'w', binding_workstation_mode: true, settings_worker_exists: true, settings_worker_project_ids: [], binding_worker_exists: true, binding_worker_project_ids: [], rollout_status: 'enabled', desire_worker_id: 'w', desire_status: 'active', explicit_storage: host };
  expect(classifyProjectWorkerAuthorityRow(row)).toBeUndefined();
  expect(classifyProjectWorkerAuthorityRow({ ...row, explicit_storage: { ...host, state: 'pending' } })).toMatchObject({ severity: 'critical', problems: ['file_authority_storage_not_ready'] });
});

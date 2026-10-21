import { beforeEach, expect, it, vi } from 'vitest';
import { activateProjectWorkerFirstWithClient } from './workbench-project-worker-first-activation.js';
import { resolveWorkerFileAuthorityForHostPath } from './workbench-project-file-authority.js';
import { classifyProjectWorkerAuthorityRow } from './workbench-project-worker-authority-audit.js';
import { queryOne } from '../../db/pg-repo.js';

vi.mock('../../db/pg-repo.js', () => ({ query: vi.fn(async () => [{ project_id: 'p', root_path: '/workspace/p' }]), queryOne: vi.fn(), transaction: vi.fn() }));
vi.mock('../project-environment/project-environment-deployment.js', () => ({ resolveProjectEnvironmentDeploymentId: () => 'production' }));
vi.mock('../execution/worker/worker-repository.js', () => ({ getPersistedWorkbenchWorker: vi.fn(async () => ({ workerId: 'w', deploymentId: 'production', status: 'healthy', projectIds: [] })) }));
vi.mock('../execution/worker/worker-transport-credentials.js', () => ({ resolveWorkbenchWorkerTransportToken: vi.fn() }));
vi.mock('../execution/worker/worker-http-transport.js', () => ({ createRemoteWorkbenchHttpTransport: vi.fn() }));

beforeEach(() => vi.clearAllMocks());

it('carries actual activation records through effective binding and reports the same scope failure in audit', async () => {
  let settings: any;
  let binding: any;
  const client = { query: vi.fn(async (sql: string, values: any[]) => {
    const metadata = { created_at: '2026-01-01', updated_at: '2026-01-01', updated_by_user_id: 1 };
    if (sql.includes('INSERT INTO project_compute_settings')) settings = { ...metadata, project_id: values[0], default_worker_id: values[1], workstation_mode: values[4] };
    if (sql.includes('INSERT INTO project_compute_deployment_bindings')) binding = { ...metadata, project_id: values[0], deployment_id: values[1], default_worker_id: values[2], workstation_mode: true };
    return { rows: [] };
  }) };
  await activateProjectWorkerFirstWithClient(client as any, { projectId: 'p', deploymentId: 'production', workerId: 'w', actorUserId: 1, reason: 'synthetic regression', fileAuthorityReady: false, verificationEvidence: 'worker-file-roundtrip' });
  vi.mocked(queryOne).mockImplementation(async (sql: string) => sql.includes('project_compute_deployment_bindings') ? binding : settings);
  expect(settings.workstation_mode).toBe(false);
  expect(binding.workstation_mode).toBe(true);
  // Characterization: do not hide this by silently reading a host mirror.
  await expect(resolveWorkerFileAuthorityForHostPath('/workspace/p/final/index.html')).rejects.toThrow('WORKER_FILE_AUTHORITY_SCOPE_MISMATCH');
  expect(classifyProjectWorkerAuthorityRow({
    project_id: 'p', project_name: 'Project', root_path: '/workspace/p',
    settings_worker_id: settings.default_worker_id, settings_workstation_mode: settings.workstation_mode,
    binding_worker_id: binding.default_worker_id, binding_workstation_mode: binding.workstation_mode,
    settings_worker_exists: true, settings_worker_project_ids: [], binding_worker_exists: true, binding_worker_project_ids: [],
    rollout_status: 'enabled', desire_worker_id: 'w', desire_status: 'active',
  })).toMatchObject({ severity: 'critical', problems: ['file_authority_scope_missing'] });
});

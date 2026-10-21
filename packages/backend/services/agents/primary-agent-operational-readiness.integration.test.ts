import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../db/pg-repo.js', () => ({ query: vi.fn() }));
vi.mock('../credential-vault/credential-vault-service.js', () => ({
  resolveProjectCredentialSecretValue: vi.fn(),
  resolveRuntimeBoxApiKeyEnv: vi.fn(),
  resolveRuntimeBoxCredentialFileMaterialization: vi.fn(),
  diagnoseUnresolvedCredentialRequirements: vi.fn().mockResolvedValue([]),
}));
vi.mock('../runtime-box/runtime-box-manager.js', async importOriginal => ({
  ...(await importOriginal<typeof import('../runtime-box/runtime-box-manager.js')>()),
  selectProjectGwsConnection: vi.fn(),
}));

import { query } from '../../db/pg-repo.js';
import {
  resolveProjectCredentialSecretValue,
  resolveRuntimeBoxApiKeyEnv,
  resolveRuntimeBoxCredentialFileMaterialization,
} from '../credential-vault/credential-vault-service.js';
import { selectPersistedWorkbenchExecutionProvider } from '../runtime-box/workbench-execution-provider-selector.js';
import { resolveRemoteWorkbenchCredentialEnv } from '../runtime-box/workbench-remote-credential-resolution.js';
import { readNewProjectStoragePolicy } from '../pm/new-project-storage-policy.js';
import { resolveProjectExecutionContext } from '../project-environment/project-execution-context.js';
import { resolveGatewayApiClient } from '../gateway-profile/gateway-profile-client.js';
import type { WorkbenchExecutionProvider } from '../execution/execution-broker.js';
import type { WorkbenchWorkerView } from '../execution/worker/worker-registry.js';

const roots: string[] = [];
const projectId = 'new-primary-agent-project';
const projectRoot = '/srv/workspace/projects/new-primary-agent-project';
const deploymentId = 'production';
const local = { kind: 'local-runtime' } as WorkbenchExecutionProvider;
const worker = {
  workerId: 'shared-worker-01', deploymentId, baseUrl: 'https://worker.internal', capabilities: ['job'], projectIds: [],
  capacity: { cpuTotal: 8, memoryMbTotal: 16_384, activeRuns: 0, maxRuns: 4 },
  registeredAt: new Date(0).toISOString(), heartbeatAt: new Date(0).toISOString(), draining: false, status: 'healthy',
} satisfies WorkbenchWorkerView;

function policyFixture() {
  const policy = { version: 1, mode: 'shared-local', backendUid: process.getuid(), workerUid: process.getuid() === 65534 ? 65533 : 65534, projectParents: ['/srv/workspace/projects'] };
  return { policy, env: { NODE_ENV: 'production', TOWER_NEW_PROJECT_STORAGE_POLICY: JSON.stringify(policy) } };
}

async function executionContext() {
  return resolveProjectExecutionContext({
    projectId, actorUserId: 7, sessionId: 'session-a', deploymentId,
    requiredCapabilities: ['job'], expectedProjectRoot: projectRoot,
  }, {
    requireAccess: vi.fn().mockResolvedValue({ userRole: 'owner', projectMember: true, projectOwner: true, projectWritable: true }),
    readProject: vi.fn().mockResolvedValue({ rootPath: projectRoot, lifecycleStatus: 'active', archived: false }),
    readLegacyPlacement: vi.fn().mockResolvedValue(undefined),
    readWorkspaceAuthorities: vi.fn().mockResolvedValue([{ project_id: projectId, deployment_id: deploymentId, storage_kind: 'host', worker_id: null, state: 'ready', version: 1 }]),
    realpath: vi.fn(async value => value),
  });
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(resolveRuntimeBoxCredentialFileMaterialization).mockResolvedValue({ materialize: [], skipped: [] } as any);
});
afterEach(() => roots.splice(0).forEach(root => fs.rmSync(root, { recursive: true, force: true })));

describe('new Primary Agent operational readiness integration', () => {
  it('connects storage policy, canonical Worker selection, Project Vault materialization and Gateway access', async () => {
    const { env, policy } = policyFixture();
    expect(readNewProjectStoragePolicy(env)).toEqual(policy);

    const context = await executionContext();
    const selected = await selectPersistedWorkbenchExecutionProvider({
      projectId, actorUserId: 7, sessionId: 'session-a', projectRoot, deploymentId,
      executionContext: context, request: { command: 'python work/use_gateway.py', lifecycle: 'job', credentialRequirements: ['PROJECT_TOOL_TOKEN'] },
      env: { NODE_ENV: 'production' }, localProvider: local, runtimeBoxCompatibilityEnabled: false,
      selectPersistedWorker: async input => {
        expect(input).toMatchObject({ projectId, deploymentId, allowCanonicalProject: true });
        return worker;
      },
      resolvePersistedWorkerToken: async () => 'transport-token',
    });
    expect(selected.kind).toBe('remote-worker');

    vi.mocked(resolveRuntimeBoxApiKeyEnv).mockResolvedValue({
      env: { PROJECT_TOOL_TOKEN: 'synthetic-project-secret' },
      injected: [{ credentialId: 'project-tool', envName: 'PROJECT_TOOL_TOKEN' }], skippedExisting: [], skipped: [],
    } as any);
    const credentials = await resolveRemoteWorkbenchCredentialEnv({
      projectId, userId: 7,
      request: { command: 'python work/use_gateway.py', credentialRequirements: ['PROJECT_TOOL_TOKEN'] },
    });
    expect(credentials.environmentKeys).toEqual(['PROJECT_TOOL_TOKEN']);
    expect(resolveRuntimeBoxApiKeyEnv).toHaveBeenCalledWith(expect.objectContaining({ projectId, userId: 7 }));

    vi.mocked(query).mockResolvedValue([{
      id: 'tower-shared-api-v1', gateway_base_url: 'https://gateway.example.com/', credential_id: 'tower-key', status: 'ready',
      api_id: 'openai-image', route_prefix: '/openai/images', readiness: 'ready', enabled: true,
    }]);
    vi.mocked(resolveProjectCredentialSecretValue).mockResolvedValue({
      credentialId: 'tower-key', provider: 'zuplo', kind: 'api_key', secretName: 'ZUPLO_KEY', value: 'synthetic-gateway-key',
    });
    await expect(resolveGatewayApiClient({ actorUserId: 7, projectId, apiId: 'openai-image' })).resolves.toMatchObject({
      apiId: 'openai-image', baseUrl: 'https://gateway.example.com/openai/images', credentialId: 'tower-key', readiness: 'ready',
    });
    expect(resolveProjectCredentialSecretValue).toHaveBeenCalledWith(expect.objectContaining({
      projectId, userId: 7, credentialId: 'tower-key', targetType: 'gateway:openai-image',
    }));
  });

  it('detects each serious break at its owning boundary instead of reporting generic Agent creation failure', async () => {
    expect(() => readNewProjectStoragePolicy({ NODE_ENV: 'production' }))
      .toThrow('NEW_PROJECT_STORAGE_WORKER_IDENTITY_REQUIRED');

    const context = await executionContext();
    await expect(selectPersistedWorkbenchExecutionProvider({
      projectId, actorUserId: 7, sessionId: 'session-a', projectRoot, deploymentId,
      executionContext: context, request: { command: 'true' }, env: { NODE_ENV: 'production' }, localProvider: local,
      runtimeBoxCompatibilityEnabled: false, selectPersistedWorker: async () => { throw new Error('NO_ELIGIBLE_WORKER'); },
    })).rejects.toThrow('PROJECT_EXECUTION_PLANE_UNAVAILABLE');

    vi.mocked(resolveRuntimeBoxApiKeyEnv).mockResolvedValue({ env: {}, injected: [], skippedExisting: [], skipped: [] } as any);
    const missingCredential = await resolveRemoteWorkbenchCredentialEnv({
      projectId, userId: 7, request: { command: 'python work/use_gateway.py', credentialRequirements: ['PROJECT_TOOL_TOKEN'] },
    });
    expect(missingCredential.environmentKeys).toEqual([]);

    vi.mocked(query).mockResolvedValue([{
      id: 'tower-shared-api-v1', gateway_base_url: 'https://gateway.example.com/', credential_id: 'tower-key', status: 'ready',
      api_id: 'openai-image', route_prefix: '/openai/images', readiness: 'ready', enabled: true,
    }]);
    vi.mocked(resolveProjectCredentialSecretValue).mockResolvedValue(null);
    await expect(resolveGatewayApiClient({ actorUserId: 7, projectId, apiId: 'openai-image' }))
      .rejects.toMatchObject({ code: 'GATEWAY_CREDENTIAL_NOT_AVAILABLE' });
  });
});

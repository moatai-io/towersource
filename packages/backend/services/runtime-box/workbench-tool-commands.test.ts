import fs from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getPgPool } from '../../db/pg.js';
import { queryOne, transaction, withClient } from '../../db/pg-repo.js';
import {
  applyWorkbenchToolChange,
  createCredentialFreeWorkbenchToolRunner,
  previewWorkbenchToolAcquisition,
  previewWorkbenchToolChange,
  workbenchToolProposalHash,
  type WorkbenchToolCommandDependencies,
} from './workbench-tool-commands.js';

vi.mock('../../db/pg.js', () => ({ getPgPool: vi.fn() }));
vi.mock('../../db/pg-repo.js', () => ({ queryOne: vi.fn(), transaction: vi.fn(), withClient: vi.fn() }));

const action = { kind: 'install' as const, manager: 'uv-tool' as const, tool: { name: 'cowsay', version: '6.1', entrypoints: ['cowsay'] } };
const actor = { userId: 7, role: 'operator', sessionId: 'session-a' };

function deps(overrides: Partial<WorkbenchToolCommandDependencies> = {}): WorkbenchToolCommandDependencies {
  return {
    inspect: vi.fn()
      .mockResolvedValueOnce({ dbRevision: 1, filesystemRevision: 1, storageMode: 'tower-managed-v1', runtimeStatus: 'running', mountedRevision: 1, recreateStatus: 'not_required', recreateRequired: false, health: 'healthy', reason: 'agree' })
      .mockResolvedValue({ dbRevision: 2, filesystemRevision: 1, storageMode: 'tower-managed-v1', runtimeStatus: 'running', mountedRevision: 1, recreateStatus: 'required', recreateRequired: true, health: 'healthy', reason: 'recreate required' }),
    install: vi.fn().mockResolvedValue({ revision: 2 }),
    importProjectPrefix: vi.fn().mockResolvedValue({ revision: 2 }),
    rollback: vi.fn().mockResolvedValue(3),
    ...overrides,
  } as WorkbenchToolCommandDependencies;
}

function mockLock() {
  const client = { query: vi.fn(), release: vi.fn() };
  vi.mocked(getPgPool).mockReturnValue({ connect: vi.fn().mockResolvedValue(client) } as any);
  return client;
}

function mockTransactionDb(sequence: unknown[]) {
  const db = { queryOne: vi.fn() };
  sequence.forEach(value => db.queryOne.mockResolvedValueOnce(value));
  vi.mocked(withClient).mockReturnValue(db as any);
  vi.mocked(transaction).mockImplementation(async callback => callback({} as any));
  return db;
}

beforeEach(() => {
  vi.stubEnv('TOWER_EXPERIMENTAL_WORKBENCH_TOOLS_ENABLED', 'true');
  vi.stubEnv('TOWER_EXPERIMENTAL_WORKBENCH_TOOL_PROJECT_IDS', JSON.stringify(['p']));
});
afterEach(() => { vi.clearAllMocks(); vi.unstubAllEnvs(); });

describe('Workbench tool command service', () => {
  it('hashes previews deterministically and includes actor/revision/action', () => {
    const input = { projectId: 'project-a', actorUserId: 7, expectedRevision: 1, action, reason: 'needed' };
    expect(workbenchToolProposalHash(input)).toBe(workbenchToolProposalHash({ ...input }));
    expect(workbenchToolProposalHash(input)).not.toBe(workbenchToolProposalHash({ ...input, expectedRevision: 2 }));
  });

  it('rejects member mutation and stale previews before creating an intent', async () => {
    await expect(previewWorkbenchToolChange({ projectId: 'p', projectRoot: '/p', expectedRevision: 1, action, reason: 'x', actor: { ...actor, role: 'member' } }))
      .rejects.toMatchObject({ code: 'MUTATION_ROLE_REQUIRED' });
    await expect(previewWorkbenchToolChange({
      projectId: 'p', projectRoot: '/p', expectedRevision: 2, action, reason: 'x', actor,
      inspect: vi.fn().mockResolvedValue({ dbRevision: 1, filesystemRevision: 1, health: 'healthy', reason: 'agree' }),
    })).rejects.toMatchObject({ code: 'STALE_REVISION' });
    expect(queryOne).not.toHaveBeenCalled();
  });

  it('translates an AI capability choice into the existing approval-bound install preview', async () => {
    vi.mocked(queryOne).mockResolvedValueOnce({ id: 'intent-ai', expires_at: '2026-08-01T00:00:00Z' });
    const result = await previewWorkbenchToolAcquisition({
      projectId: 'p', projectRoot: '/p', expectedRevision: 1, actor,
      request: {
        capability: 'document-processing', purpose: 'PDF metadata inspection',
        candidate: { manager: 'uv-tool', registry: 'pypi', tool: { name: 'PyMuPDF', version: '1.26.3', entrypoints: ['pymupdf'] } },
        access: { credentials: 'none', externalNetworkAtRuntime: false, paidService: false },
      },
      inspect: vi.fn().mockResolvedValue({ dbRevision: 1, filesystemRevision: 1, storageMode: 'tower-managed-v1', runtimeStatus: 'stopped', mountedRevision: 1, health: 'healthy', reason: 'agree' }),
    });
    expect(result).toMatchObject({
      acquisition: { disposition: 'approval_required', normalizedTool: { name: 'pymupdf', version: '1.26.3' } },
      change: { intentId: 'intent-ai', action: { kind: 'install', tool: { name: 'pymupdf', version: '1.26.3' } } },
    });
  });

  it('does not create a mutation intent when acquisition bundles credential authority', async () => {
    await expect(previewWorkbenchToolAcquisition({
      projectId: 'p', projectRoot: '/p', expectedRevision: 1, actor,
      request: {
        capability: 'data-analysis', purpose: 'query a private account',
        candidate: { manager: 'uv-tool', registry: 'pypi', tool: { name: 'example-cli', version: '1.0.0', entrypoints: ['example'] } },
        access: { credentials: 'required', externalNetworkAtRuntime: true, paidService: false },
      },
    })).rejects.toMatchObject({ code: 'ACQUISITION_AUTHORITY_REQUIRED' });
    expect(queryOne).not.toHaveBeenCalled();
  });

  it('creates a DB-backed preview without mutating the prefix', async () => {
    vi.mocked(queryOne).mockResolvedValueOnce({ id: 'intent-a', expires_at: '2026-08-01T00:00:00Z' });
    const preview = await previewWorkbenchToolChange({
      projectId: 'p', projectRoot: '/p', expectedRevision: 1, action, reason: 'needed', actor,
      inspect: vi.fn().mockResolvedValue({ dbRevision: 1, filesystemRevision: 1, health: 'healthy', reason: 'agree' }),
    });
    expect(preview).toMatchObject({ intentId: 'intent-a', currentRevision: 1, impact: { credentialsSuppressed: true } });
    expect(queryOne).toHaveBeenCalledTimes(1);
  });

  it('requires explicit legacy import and preserves unknown recreate state', async () => {
    const inspect = vi.fn().mockResolvedValue({
      dbRevision: 1, filesystemRevision: 1, storageMode: 'project-prefix', runtimeStatus: 'unknown', mountedRevision: 1,
      recreateStatus: 'unknown', recreateRequired: null, health: 'healthy', reason: 'legacy',
    });
    await expect(previewWorkbenchToolChange({ projectId: 'p', projectRoot: '/p', expectedRevision: 1, action, reason: 'upgrade', actor, inspect }))
      .rejects.toMatchObject({ code: 'LEGACY_IMPORT_REQUIRED' });
    vi.mocked(queryOne).mockResolvedValueOnce({ id: 'intent-import', expires_at: '2026-08-01T00:00:00Z' });
    const preview = await previewWorkbenchToolChange({
      projectId: 'p', projectRoot: '/p', expectedRevision: 1, action: { kind: 'import-project-prefix' }, reason: 'explicit import', actor, inspect,
    });
    expect(preview.runtime).toMatchObject({ status: 'unknown', mountedRevision: 1, recreateRequiredAfterApply: 'unknown' });
  });

  it('adapts primitive commands to an explicit credentialMode none exec', async () => {
    const exec = vi.fn().mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' });
    const runner = createCredentialFreeWorkbenchToolRunner(exec);
    await runner({
      command: 'uv --version', cwd: '/workspace', credentialFree: true,
      candidateHostPath: '/store/staging/cmd', candidateContainerPath: '/workspace/.runtime-box/workbench-tools/active', candidateMountMode: 'rw',
    });
    expect(exec).toHaveBeenCalledWith({
      command: 'uv --version', cwd: '/workspace', credentialMode: 'none',
      candidateHostPath: '/store/staging/cmd', candidateContainerPath: '/workspace/.runtime-box/workbench-tools/active', candidateMountMode: 'rw',
    });
    await expect(runner({
      command: 'x', cwd: '/tmp', credentialFree: true,
      candidateHostPath: '/store/staging/cmd', candidateContainerPath: '/workspace/.runtime-box/workbench-tools/active', candidateMountMode: 'rw',
    })).rejects.toMatchObject({ code: 'RUNNER_POLICY_VIOLATION' });
  });

  it('keeps mutation execution on the dedicated credential-free Docker path', async () => {
    const managerSource = fs.readFileSync(new URL('./runtime-box-manager.ts', import.meta.url), 'utf8');
    const start = managerSource.indexOf('export async function execWorkbenchToolMutation');
    const end = managerSource.indexOf('// ── 경계 검증', start);
    const body = managerSource.slice(start, end);
    expect(body).toContain("'-e', 'UV_CACHE_DIR=/tmp/uv-cache'");
    expect(body).toContain('dst=/tower-project-source,readonly=true');
    expect(body).toContain("'--tmpfs', '/workspace:rw,nosuid,nodev,mode=0777'");
    expect(body).toContain("'cp -R /tower-project-source/. /workspace/'");
    expect(body).not.toContain('dst=/workspace,readonly=false');
    expect(body).toContain("'--cap-drop', 'ALL'");
    expect(body).toContain('readonly=${mountMode === \'ro\'}');
    expect(body).not.toContain('resolveRuntimeBoxApiKeyEnv');
    expect(body).not.toContain('resolveRuntimeBoxCredentialFileMaterialization');
    expect(body).not.toContain('resolveRuntimeBoxCredentialProfileEnv');
    expect(body).not.toContain('envArgs');
    expect(body).not.toContain('GITHUB_TOKEN');
  });

  it('consumes one intent, invokes install, and records success', async () => {
    mockLock();
    const requestHash = expect.any(String);
    const intent = { id: 'intent-a', project_id: 'p', actor_user_id: 7, actor_session_id: 'session-a', expected_revision: 1, action, reason: 'needed', proposal_hash: 'a'.repeat(64) };
    const command = { id: 'command-a', status: 'reserved', request_hash: '', result: null };
    const db = mockTransactionDb([intent, command, { id: 'intent-a' }]);
    // Capture the generated request hash from INSERT params and return it in the inserted command.
    db.queryOne.mockReset();
    db.queryOne.mockResolvedValueOnce(intent);
    db.queryOne.mockImplementationOnce(async (_sql: string, params: any[]) => ({ ...command, request_hash: params[5] }));
    db.queryOne.mockResolvedValueOnce({ id: 'intent-a' });
    vi.mocked(queryOne).mockResolvedValue({ id: 'command-a' } as any);
    const dependencies = deps();
    const result = await applyWorkbenchToolChange({
      projectId: 'p', projectRoot: '/p', intentId: 'intent-a', proposalHash: 'a'.repeat(64), expectedRevision: 1,
      idempotencyKey: 'command-key-a', confirmed: true, actor, dependencies,
    });
    expect(result).toMatchObject({
      revision: 2,
      activation: 'pointer_updated',
      runtime: { changed: false, currentRevision: 2, mountedRevision: 1, recreateRequired: true },
      nextAction: 'preview_runtime_recreate',
    });
    expect(dependencies.install).toHaveBeenCalledWith(expect.objectContaining({ spec: action.tool, expectedRevision: 1, actor: expect.objectContaining({ jobId: 'command-a' }) }));
    expect(queryOne).toHaveBeenCalledWith(expect.stringContaining("status='succeeded'"), expect.any(Array));
    expect(requestHash).toEqual(expect.any(String));
  });

  it('fails closed when revision changes after preview', async () => {
    mockLock();
    const intent = { id: 'intent-a', project_id: 'p', actor_user_id: 7, actor_session_id: null, expected_revision: 1, action, reason: 'needed', proposal_hash: 'a'.repeat(64) };
    const db = mockTransactionDb([]);
    db.queryOne.mockResolvedValueOnce(intent);
    db.queryOne.mockImplementationOnce(async (_sql: string, params: any[]) => ({ id: 'command-a', status: 'reserved', request_hash: params[5], result: null }));
    db.queryOne.mockResolvedValueOnce({ id: 'intent-a' });
    const dependencies = deps({ inspect: vi.fn().mockResolvedValue({ dbRevision: 2, filesystemRevision: 2, health: 'healthy', reason: 'agree' }) });
    await expect(applyWorkbenchToolChange({
      projectId: 'p', projectRoot: '/p', intentId: 'intent-a', proposalHash: 'a'.repeat(64), expectedRevision: 1,
      idempotencyKey: 'command-key-a', confirmed: true, actor, dependencies,
    })).rejects.toMatchObject({ code: 'STALE_REVISION' });
    expect(dependencies.install).not.toHaveBeenCalled();
    expect(queryOne).toHaveBeenCalledWith(expect.stringContaining("error_code='STALE_REVISION'"), expect.any(Array));
  });

  it('returns the stored result without invoking a completed mutation again', async () => {
    mockLock();
    const intent = { id: 'intent-a', project_id: 'p', actor_user_id: 7, actor_session_id: null, expected_revision: 1, action, reason: 'needed', proposal_hash: 'a'.repeat(64) };
    const db = mockTransactionDb([]);
    db.queryOne.mockResolvedValueOnce(intent);
    db.queryOne.mockResolvedValueOnce(undefined);
    db.queryOne.mockResolvedValueOnce({ id: 'command-a', status: 'succeeded', request_hash: 'placeholder', result: { revision: 2 } });
    // Match the generated request hash on idempotent lookup.
    db.queryOne.mockImplementationOnce(async (_sql: string, params: any[]) => ({ id: 'intent-a' }));
    const originalQueryOne = db.queryOne;
    let insertParams: any[] | undefined;
    originalQueryOne.mockReset();
    originalQueryOne.mockResolvedValueOnce(intent);
    originalQueryOne.mockImplementationOnce(async (_sql: string, params: any[]) => { insertParams = params; return undefined; });
    originalQueryOne.mockImplementationOnce(async () => ({ id: 'command-a', status: 'succeeded', request_hash: insertParams?.[5], result: { revision: 2 } }));
    originalQueryOne.mockResolvedValueOnce({ id: 'intent-a' });
    const dependencies = deps();
    await expect(applyWorkbenchToolChange({
      projectId: 'p', projectRoot: '/p', intentId: 'intent-a', proposalHash: 'a'.repeat(64), expectedRevision: 1,
      idempotencyKey: 'command-key-a', confirmed: true, actor, dependencies,
    })).resolves.toEqual({ revision: 2 });
    expect(dependencies.install).not.toHaveBeenCalled();
  });
});

import { createMarkdownArtifactTool } from '../pi-markdown-artifact-tool.js';
/**
 * Current-behaviour characterization, NOT a passing workspace-consistency contract.
 * Runs buildPiToolAssembly().allCustomTools, real Pi file operations/read probe,
 * real guards/shadow/ledger wrapper, real Workbench bash/broker/provider/HTTP Worker.
 * Control-plane discovery, unrelated tool factories, Vault and persistent records
 * are bounded mocks. No LLM, SDK AgentSession, browser, OS identity or deployment E2E.
 * Vitest's default file isolation keeps these module mocks out of other suites.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import type http from 'node:http';
import type { ResolvedHarness } from '../../services/harness/harness-types.js';

// Keep the real admin-only source guard, but model its root outside our synthetic
// member Project. Otherwise an in-checkout fixture is correctly treated as Tower code.
vi.hoisted(() => {
  // `${import.meta.dirname}` keeps TOWER_REPO_ROOT deterministic in a clean
  // commit snapshot; /workspace/work/goals/ only exists on this dev VM.
  vi.stubEnv('TOWER_REPO_ROOT', `${import.meta.dirname}/.synthetic-admin-source-not-used`);
});
afterAll(() => vi.unstubAllEnvs());

const fixture = vi.hoisted(() => ({
  operatorAccess: false,
  runtimeEnabled: true,
  currentRole: 'member',
  disabled: 0,
  workerBaseUrl: '',
  membershipRole: 'member' as string | null,
  selectProvider: vi.fn(),
  binding: vi.fn(async () => ({ defaultWorkerId: 'synthetic-worker', workstationMode: true })),
  db: vi.fn(() => { throw new Error('Unexpected DB access in storage characterization'); }),
  unused: vi.fn(() => { throw new Error('Out-of-scope tool invoked'); }),
}));

// Do not import real config: it loads the checkout .env. All config is synthetic.
vi.mock('../../config.js', () => ({
  config: {
    runtimeBox: { get enabled() { return fixture.runtimeEnabled; }, materializeSkills: false, compatibilityEnabled: false, excludedProjects: [] },
    sandbox: { enabled: false },
    experimentalWorkbenchTools: { enabled: false, projectIds: [] },
  },
  DEFAULT_RUNTIME_BOX_MATERIALIZED_SKILLS: [],
}));
vi.mock('../../db/pg-repo.js', () => ({ query: fixture.db, queryOne: fixture.db, execute: fixture.db, transaction: fixture.db, withClient: fixture.db }));
vi.mock('../../services/pm/project-agent-profile.js', () => ({ PROJECT_AGENT_PROFILE_SELECT: 'id', getProjectAgentRuntimeProfile: async () => ({ status: 'active', authorityPolicy: { superuser: fixture.operatorAccess } }) }));
vi.mock('../../services/auth/auth.js', () => ({
  getUserAuthState: async () => ({ disabled: fixture.disabled !== 0, approvalStatus: 'active', role: fixture.currentRole }),
}));
vi.mock('../../services/pm/project-manager.js', () => ({ getProject: async () => ({ id: 'synthetic-project', rootPath: host, userId: null }) }));
vi.mock('../../services/pm/project-membership-manager.js', () => ({
  getAccessibleProjectIds: fixture.db,
  isProjectMember: async () => fixture.membershipRole !== null,
}));
vi.mock('../../services/session/session-share-manager.js', () => ({ hasInternalShareAccess: fixture.db }));
vi.mock('../../services/agent-turn/side-effect-ledger.js', () => ({ beginSideEffectExecution: fixture.db, buildSideEffectSemanticHash: fixture.db, failSideEffectExecution: fixture.db, finishSideEffectExecution: fixture.db }));
vi.mock('../../services/workspace/file-edit-log.js', () => ({ recordFileEdit: async () => {} }));
vi.mock('../../services/skill/project-skill-materializer.js', () => ({ materializeProjectRegistrySkills: fixture.unused }));
vi.mock('../../services/skill/teamskills-source.js', () => ({ readTeamskillsSkillset: () => [], getTeamskillsProjectRoot: fixture.unused, getTeamskillsSkillRoot: fixture.unused, isSafeSkillName: fixture.unused }));
vi.mock('../../services/runtime-box/workbench-rollout-registry.js', () => ({ resolveWorkbenchRollout: async () => ({ enabled: true }) }));
vi.mock('../../services/execution/worker/worker-transport-credentials.js', () => ({ resolveWorkbenchWorkerTransportToken: async () => 'synthetic-test-token' }));
vi.mock('../../services/execution/worker/worker-repository.js', async importOriginal => ({
  ...(await importOriginal<any>()),
  getPersistedWorkbenchWorker: async () => ({ workerId: 'synthetic-worker', baseUrl: fixture.workerBaseUrl, deploymentId: 'synthetic-deployment', projectIds: ['synthetic-project'], status: 'healthy', draining: false }),
}));
vi.mock('../../services/runtime-box/workbench-project-compute-settings.js', () => ({ getProjectComputeDeploymentBinding: fixture.binding, getProjectComputeSettings: fixture.db }));
vi.mock('../../services/project-environment/project-environment-deployment.js', () => ({ resolveProjectEnvironmentDeploymentId: () => 'synthetic-deployment' }));
vi.mock('../../services/project-environment/project-execution-context.js', () => ({ resolveProjectExecutionContext: async () => ({ projectRoot: '/synthetic-worker-project', preferredExecutorId: 'synthetic-worker', environmentMode: 'legacy-worker-workspace' }) }));
vi.mock('../../services/runtime-box/workbench-execution-provider-selector.js', () => ({ resolveWorkbenchDeploymentId: () => 'synthetic-deployment', requiredWorkbenchWorkerCapabilities: () => [], selectPersistedWorkbenchExecutionProvider: fixture.selectProvider }));
vi.mock('../../services/runtime-box/workbench-remote-credential-resolution.js', () => ({ resolveRemoteWorkbenchCredentialEnv: async (input: any) => ({ request: input.request, injected: [], materializedFiles: [], skipped: [], suppressed: false }) }));
// Operator exception still uses real createLocalBashOperations; only Vault decoration is bypassed.
vi.mock('../../services/runtime-box/workbench-host-credential-operations.js', () => ({ createHostCredentialBashOperations: ({ base }: any) => base }));
vi.mock('../../services/session-attachments/session-attachment-store.js', () => ({ resolveSessionAttachment: fixture.unused }));

vi.mock('../pi-ask-user-tool.js', () => ({ createAskUserQuestionTool: () => ({ name: 'stub_createAskUserQuestionTool', execute: fixture.unused }) }));
vi.mock('../pi-credential-vault-tool.js', () => ({ createCredentialVaultInputTool: () => ({ name: 'stub_createCredentialVaultInputTool', execute: fixture.unused }) }));
vi.mock('../pi-credential-vault-access-tool.js', () => ({ createCredentialVaultAccessTool: () => ({ name: 'stub_createCredentialVaultAccessTool', execute: fixture.unused }) }));
vi.mock('../pi-credential-vault-store-tool.js', () => ({ createCredentialVaultStoreTool: () => ({ name: 'stub_createCredentialVaultStoreTool', execute: fixture.unused }) }));
vi.mock('../pi-web-tools.js', () => ({ createWebFetchTool: () => ({ name: 'stub_createWebFetchTool', execute: fixture.unused }), createWebSearchTool: () => ({ name: 'stub_createWebSearchTool', execute: fixture.unused }) }));
vi.mock('../pi-memory-search-tool.js', () => ({ createMemorySearchTool: () => ({ name: 'stub_createMemorySearchTool', execute: fixture.unused }) }));
vi.mock('../pi-conversation-search-tool.js', () => ({ createConversationSearchTool: () => ({ name: 'stub_createConversationSearchTool', execute: fixture.unused }) }));
vi.mock('../pi-session-transcript-tool.js', () => ({ createSessionTranscriptReadTool: () => ({ name: 'stub_createSessionTranscriptReadTool', execute: fixture.unused }) }));
vi.mock('../pi-finance-tools.js', () => ({ createExcelReadTool: () => ({ name: 'stub_createExcelReadTool', execute: fixture.unused }), createExcelQueryTool: () => ({ name: 'stub_createExcelQueryTool', execute: fixture.unused }) }));
vi.mock('../pi-finance-tools-extra.js', () => ({ createPdfReadTool: () => ({ name: 'stub_createPdfReadTool', execute: fixture.unused }), createExcelWriteTool: () => ({ name: 'stub_createExcelWriteTool', execute: fixture.unused }), createExcelDiffTool: () => ({ name: 'stub_createExcelDiffTool', execute: fixture.unused }) }));
vi.mock('../pi-todo-tool.js', () => ({ createTodoWriteTool: () => ({ name: 'stub_createTodoWriteTool', execute: fixture.unused }) }));
vi.mock('../pi-shared-task-tool.js', () => ({ sharedTaskCreateTool: { name: 'sharedTaskCreateTool', execute: fixture.unused }, sharedTaskUpdateTool: { name: 'sharedTaskUpdateTool', execute: fixture.unused }, sharedTaskListTool: { name: 'sharedTaskListTool', execute: fixture.unused } }));
vi.mock('../pi-pdf-export-tool.js', () => ({ createPdfExportTool: () => ({ name: 'stub_createPdfExportTool', execute: fixture.unused }) }));
vi.mock('../pi-cad-view-tool.js', () => ({ createCadViewTool: () => ({ name: 'stub_createCadViewTool', execute: fixture.unused }) }));
vi.mock('../pi-publish-tool.js', () => ({ createPublishSiteTool: () => ({ name: 'stub_createPublishSiteTool', execute: fixture.unused }) }));
vi.mock('../pi-present-file-tool.js', () => ({ createPresentFileTool: () => ({ name: 'stub_createPresentFileTool', execute: fixture.unused }) }));
vi.mock('../pi-personal-note-tool.js', () => ({ createPersonalNoteAppendTool: () => ({ name: 'stub_createPersonalNoteAppendTool', execute: fixture.unused }) }));
vi.mock('../pi-session-attachment-tool.js', () => ({ createSessionAttachmentPromoteTool: () => ({ name: 'stub_createSessionAttachmentPromoteTool', execute: fixture.unused }), createSessionAttachmentResolveTool: () => ({ name: 'stub_createSessionAttachmentResolveTool', execute: fixture.unused }), readCurrentSessionAttachmentImage: fixture.unused }));
vi.mock('../pi-file-exchange-tool.js', () => ({ createDeliverDirectoryTool: () => ({ name: 'stub_createDeliverDirectoryTool', execute: fixture.unused }), createDeliverFileTool: () => ({ name: 'stub_createDeliverFileTool', execute: fixture.unused }), createImportPersonalFileToProjectTool: () => ({ name: 'stub_createImportPersonalFileToProjectTool', execute: fixture.unused }) }));
vi.mock('../pi-skill-tools.js', () => ({ createSkillsListTool: () => ({ name: 'stub_createSkillsListTool', execute: fixture.unused }), createSkillsReadTool: () => ({ name: 'stub_createSkillsReadTool', execute: fixture.unused }) }));
vi.mock('../pi-guide-tools.js', () => ({ createRuntimeGuideListTool: () => ({ name: 'stub_createRuntimeGuideListTool', execute: fixture.unused }), createRuntimeGuideReadTool: () => ({ name: 'stub_createRuntimeGuideReadTool', execute: fixture.unused }) }));
vi.mock('../pi-primary-agent-tools.js', () => ({ createPrimaryAgentProfileTools: () => [], createPrimaryAgentProjectTool: () => ({ name: 'stub_createPrimaryAgentProjectTool', execute: fixture.unused }), createPrimaryAgentStaffingTools: () => [] }));
vi.mock('../pi-mcp-adapter.js', () => ({ mcpServerToPiTools: () => [] }));
vi.mock('../../services/project-mcp/project-mcp-loader.js', () => ({ createProjectMcpGatewayTools: () => [] }));
vi.mock('../pi-harness-capability-tools.js', () => ({ createPiHarnessCapabilityTools: fixture.unused }));
vi.mock('../pi-connection-status-tool.js', () => ({ createConnectionStatusTool: () => ({ name: 'stub_createConnectionStatusTool', execute: fixture.unused }) }));
vi.mock('../pi-ai-service-knowledge-tools.js', () => ({ createAIServiceKnowledgeTools: () => [] }));
vi.mock('../../mcp/session-control-server.js', () => ({ createSessionControlMcpServer: () => ({}) }));
vi.mock('../../mcp/schedule-server.js', () => ({ createScheduleMcpServer: () => ({}) }));
vi.mock('../../mcp/issue-server.js', () => ({ createIssueMcpServer: () => ({}) }));
vi.mock('../../mcp/spawn-server.js', () => ({ createSpawnMcpServer: () => ({}) }));
vi.mock('../../mcp/agent-worker-server.js', () => ({ createAgentWorkerMcpServer: () => ({}) }));
vi.mock('../../services/security/connector-guard.js', () => ({ preToolUseConnectorGuard: fixture.unused }));
vi.mock('../../services/security/sandbox-public-gate.js', () => ({ preToolUseSandboxPublicGate: fixture.unused }));
vi.mock('../../services/workspace-guard/hook.js', () => ({ makePreToolUseWorkspaceGuard: () => fixture.unused }));
vi.mock('../../services/audit/hook.js', () => ({ makePostToolUseProvenance: () => fixture.unused }));
vi.mock('../../services/runtime-box/runtime-box-manager.js', () => ({ getOrCreateBox: fixture.unused, ensureRunning: fixture.unused, execInBox: fixture.unused, execWorkbenchToolMutation: fixture.unused, RuntimeBoxError: class extends Error {} }));
vi.mock('../../services/runtime-box/service-registry.js', () => ({ listServices: fixture.unused, registerService: fixture.unused, startServiceProcess: fixture.unused, stopService: fixture.unused, readServiceLogs: fixture.unused, formatServiceList: fixture.unused }));
vi.mock('../../services/runtime-box/workbench-tools.js', () => ({ importProjectPrefixWorkbenchTools: fixture.unused, inspectWorkbenchTools: fixture.unused, installUvWorkbenchTool: fixture.unused, listWorkbenchToolRevisions: fixture.unused, rollbackWorkbenchTools: fixture.unused }));
vi.mock('../../services/runtime-box/workbench-tool-commands.js', () => ({ applyWorkbenchToolChange: fixture.unused, createCredentialFreeWorkbenchToolRunner: fixture.unused, previewWorkbenchToolAcquisition: fixture.unused, previewWorkbenchToolChange: fixture.unused, WorkbenchToolCommandError: class extends Error {} }));
vi.mock('../../services/runtime-box/workbench-runtime-recreate.js', () => ({ applyWorkbenchRuntimeRecreate: fixture.unused, previewWorkbenchRuntimeRecreate: fixture.unused }));
vi.mock('../../services/runtime-box/workbench-tool-inventory.js', () => ({ projectWorkbenchToolInventory: fixture.unused }));
vi.mock('../../services/execution/jobs/job-registry.js', () => ({ cancelWorkbenchJob: fixture.unused, getWorkbenchJob: fixture.unused, listWorkbenchJobs: fixture.unused }));
vi.mock('../../services/runtime-box/workbench-job-runner.js', () => ({ requestLocalWorkbenchJobCancel: fixture.unused }));
vi.mock('../../services/runtime-box/workbench-process-control.js', () => ({ inspectWorkbenchProcess: fixture.unused, listWorkbenchProcesses: fixture.unused, readWorkbenchProcessLogs: fixture.unused, stopWorkbenchProcess: fixture.unused }));
vi.mock('../../services/execution/remote-job-runner.js', () => ({ enqueueRemoteWorkbenchJob: fixture.unused }));
vi.mock('../../services/runtime-box/workbench-remote-service-registry.js', () => ({ registerAndStartRemoteWorkerService: fixture.unused }));

import { buildPiToolAssembly } from './tool-assembly.js';
import { createRemoteWorkbenchWorkerServer } from '../../services/execution/worker/worker-server.js';
import { createRemoteWorkbenchHttpTransport } from '../../services/execution/worker/worker-http-transport.js';
import { createRemoteWorkbenchExecutionProvider } from '../../services/runtime-box/workbench-remote-execution-provider.js';

const harness: ResolvedHarness = {
  id: 'synthetic-legacy', version: 1, runtimeProfileId: 'synthetic', runtimeProfileVersion: 1,
  engine: 'pi', defaultModel: null, allowedModels: null, source: 'legacy-default', capabilityIds: [],
  prompt: { includePlatformKernel: true, includeAgentIdentity: false, includeProjectInstructions: false, includeMemory: false, includeSkills: false, fragments: [] },
};
let root: string;
let host: string;
let worker: string;
let server: http.Server | undefined;
let requests: number;
let sequence = 0;

beforeEach(async () => {
  vi.clearAllMocks();
  fixture.operatorAccess = false;
  fixture.runtimeEnabled = true;
  fixture.currentRole = 'member';
  fixture.disabled = 0;
  fixture.membershipRole = 'member';
  vi.stubEnv('TOWER_PLATFORM_AGENT_PROJECT_IDS', '');
  fixture.db.mockImplementation((sql: string) => {
    if (sql.includes('SELECT p.root_path, p.archived, pap.status')) return Promise.resolve(
      fixture.currentRole === 'operator' && fixture.disabled === 0
        ? [{ root_path: host, enabled: fixture.operatorAccess, status: 'active', archived: 0, membership_role: fixture.membershipRole }] : []);
    if (sql.includes('SELECT u.role, u.disabled, p.archived')) return Promise.resolve({
      role: fixture.currentRole, disabled: fixture.disabled, archived: 0,
      membership_role: fixture.membershipRole, agent_status: 'active',
    });
    if (sql.includes('SELECT id AS project_id, root_path, archived, lifecycle_status FROM projects')) return Promise.resolve([{ project_id: 'synthetic-project', root_path: host }]);
    if (sql.includes('FROM project_file_storage_bindings')) return Promise.resolve([]);
    if (sql.includes('SELECT * FROM runtime_box_workbench_workers')) return Promise.resolve([{ worker_id: 'synthetic-worker', base_url: 'http://synthetic', status: 'online', draining: false, last_heartbeat_at: new Date(), capabilities: [] }]);
    if (sql.includes('SELECT p.root_path, pm.role FROM projects')) return Promise.resolve([{ root_path: host, role: fixture.membershipRole }]);
    if (sql.includes('SELECT visibility FROM sessions')) return Promise.resolve({ visibility: 'project' });
    throw new Error('Unexpected DB access in storage characterization');
  });
  requests = 0;
  // Test-only mkdtemp stays inside the registered checkout. No operational paths.
  // path.dirname resolves from this file, so a fresh snapshot without
  // workspace/work/goals/ still materializes the fixture root.
  root = await fs.mkdtemp(path.join(path.dirname(new URL(import.meta.url).pathname), '.pi-storage-fixture-'));
  host = path.join(root, 'host');
  worker = path.join(root, 'worker');
  await Promise.all([fs.mkdir(host), fs.mkdir(worker)]);
  for (const [dir, marker] of [[host, 'HOST'], [worker, 'WORKER']]) {
    await fs.writeFile(path.join(dir, 'shared.txt'), `${marker}-ORIGINAL\n`);
    await fs.writeFile(path.join(dir, `${marker.toLowerCase()}-only.txt`), `${marker}-ONLY\n`);
  }
  // Same OS process/user, different authoritative directories; no bwrap/systemd.
  server = createRemoteWorkbenchWorkerServer({ workerId: 'synthetic-worker', token: 'synthetic-test-token', projects: { 'synthetic-project': worker } });
  server.on('request', () => { requests += 1; });
  await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Local fixture failed to listen');
  fixture.workerBaseUrl = `http://127.0.0.1:${address.port}`;
  const transport = createRemoteWorkbenchHttpTransport({ workerId: 'synthetic-worker', token: 'synthetic-test-token', baseUrl: fixture.workerBaseUrl });
  fixture.selectProvider.mockResolvedValue(createRemoteWorkbenchExecutionProvider(transport));
});

afterEach(async () => {
  if (server) {
    server.closeIdleConnections();
    await new Promise<void>((resolve, reject) => server!.close(error => error ? reject(error) : resolve()));
    server = undefined;
  }
  // Only this run's exact synthetic fixture is removed, never existing files.
  if (root) await fs.rm(root, { recursive: true, force: true });
});

async function assemble(userRole = 'member') {
  return buildPiToolAssembly({
    sessionId: '00000000-0000-4000-8000-000000000001',
    opts: { cwd: host, sessionProjectRoot: host, userId: 7, userRole, projectId: 'synthetic-project', accessiblePaths: [host], allowedPath: host },
    registry: {}, parentSessionFile: undefined, projectName: 'synthetic-project', towerPrompt: '', memoryContext: null, harness,
  });
}
function text(result: any): string {
  return result.content.filter((block: any) => block.type === 'text').map((block: any) => block.text).join('\n');
}
async function invoke(assembly: Awaited<ReturnType<typeof assemble>>, name: string, args: object) {
  const tools = assembly.allCustomTools.filter(tool => tool.name === name);
  expect(tools, `Final assembly must expose exactly one ${name}`).toHaveLength(1);
  const result = await tools[0].execute(`synthetic-call-${++sequence}`, args, new AbortController().signal);
  expect(result.isError, text(result)).not.toBe(true);
  expect(text(result)).not.toContain('[Access Denied]');
  return result;
}
async function shell(assembly: Awaited<ReturnType<typeof assemble>>, command: string) {
  const result = await invoke(assembly, 'bash', { command, lifecycle: 'foreground', timeoutSec: 5 });
  const parsed = JSON.parse(text(result));
  expect(parsed.execution.outcome.ok, text(result)).toBe(true);
  expect(parsed.plan.providerKind).toBe('remote-worker');
  return parsed.execution.stdout as string;
}

describe('final Pi assembly: Project file tools use the same Worker storage authority as bash', () => {
  it('creates a Markdown document in missing nested folders through real Worker storage', async () => {
    const tool = createMarkdownArtifactTool({ cwd: host, projectRoot: host, projectId: 'synthetic-project', userId: 7, userRole: 'member' });
    const result = await tool.execute('markdown-create', { path: 'new-research/nested/review.md', title: 'Review', body: '# Research' });
    expect(JSON.parse(text(result))).toMatchObject({ ok: true, status: 'saved' });
    expect(await fs.readFile(path.join(worker, 'new-research/nested/review.md'), 'utf8')).toBe('# Research\n');
    await expect(fs.stat(path.join(host, 'new-research/nested/review.md'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it.each(['relative', 'workspace', 'absolute'])('normalizes %s paths through real Worker write/read/edit', async variant => {
    const assembly = await assemble();
    const target = variant === 'relative' ? 'parity.txt' : variant === 'workspace' ? '/workspace/parity.txt' : path.join(host, 'parity.txt');
    await invoke(assembly, 'write', { path: target, content: 'BEFORE' });
    await invoke(assembly, 'edit', { path: target, edits: [{ oldText: 'BEFORE', newText: 'AFTER' }] });
    expect(text(await invoke(assembly, 'read', { path: target }))).toContain('AFTER');
    expect(await shell(assembly, 'cat parity.txt')).toBe('AFTER');
    await expect(fs.stat(path.join(host, 'parity.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('returns normal matches while reporting a real inaccessible Worker directory', async () => {
    const assembly = await assemble();
    const blocked = path.join(worker, 'blocked-search');
    await fs.mkdir(blocked);
    await fs.writeFile(path.join(worker, 'quote-R3.pdf'), 'synthetic');
    await fs.chmod(blocked, 0);
    try {
      const result = await invoke(assembly, 'find', { path: '/workspace', pattern: '**/*.pdf' });
      expect(text(result)).toContain('quote-R3.pdf');
      expect((result as any).details).toMatchObject({ partial: true, skippedPaths: [{ path: 'blocked-search', code: 'EACCES' }] });
    } finally { await fs.chmod(blocked, 0o700); }
  });

  it('writes through Worker authority so real Worker HTTP bash sees the AI-created file', async () => {
    const assembly = await assemble();
    expect(assembly.operatorHostAccess).toBe(false);
    await invoke(assembly, 'write', { path: path.join(host, 'created.txt'), content: 'AI-WRITE\n' });
    await expect(fs.stat(path.join(host, 'created.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await fs.readFile(path.join(worker, 'created.txt'), 'utf8')).toBe('AI-WRITE\n');
    expect(await shell(assembly, 'set -eu; cat created.txt; test ! -e host-only.txt; cat worker-only.txt; cat shared.txt'))
      .toBe('AI-WRITE\nWORKER-ONLY\nWORKER-ORIGINAL\n');
    expect(requests).toBeGreaterThanOrEqual(3);
    expect(fixture.binding).toHaveBeenCalledWith('synthetic-project', 'synthetic-deployment');
    expect(fixture.selectProvider).toHaveBeenCalledWith(expect.objectContaining({ projectRoot: '/synthetic-worker-project', defaultWorkerId: 'synthetic-worker', workstationMode: true, actorRole: 'member' }));
    expect(fixture.db).toHaveBeenCalled();
    expect(fixture.unused).not.toHaveBeenCalled();
  });

  it('reads and edits Worker version and reads a Worker-created result through the same authority', async () => {
    const assembly = await assemble();
    expect(text(await invoke(assembly, 'read', { path: path.join(host, 'shared.txt') }))).toBe('WORKER-ORIGINAL\n');
    await invoke(assembly, 'edit', { path: path.join(host, 'shared.txt'), edits: [{ oldText: 'WORKER-ORIGINAL', newText: 'WORKER-EDITED' }] });
    expect(text(await invoke(assembly, 'read', { path: path.join(host, 'shared.txt') }))).toBe('WORKER-EDITED\n');
    expect(await fs.readFile(path.join(worker, 'shared.txt'), 'utf8')).toBe('WORKER-EDITED\n');
    expect(await fs.readFile(path.join(host, 'shared.txt'), 'utf8')).toBe('HOST-ORIGINAL\n');
    expect(await shell(assembly, 'set -eu; cat shared.txt; printf WORKER-CREATED > worker-created.txt')).toBe('WORKER-EDITED\n');
    await expect(fs.stat(path.join(host, 'worker-created.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(text(await invoke(assembly, 'read', { path: path.join(host, 'worker-created.txt') }))).toBe('WORKER-CREATED');
    expect(await fs.readFile(path.join(worker, 'worker-created.txt'), 'utf8')).toBe('WORKER-CREATED');
    expect(requests).toBeGreaterThanOrEqual(3);
    expect(fixture.db).toHaveBeenCalled();
    expect(fixture.unused).not.toHaveBeenCalled();
  });

  it('forwards an already-aborted foreground signal before making a Worker HTTP request', async () => {
    const assembly = await assemble();
    const controller = new AbortController();
    controller.abort(new Error('synthetic-abort-before-http'));
    const bash = assembly.allCustomTools.find(tool => tool.name === 'bash');
    const result = await bash.execute('pre-aborted', { command: 'cat worker-only.txt', lifecycle: 'foreground', timeoutSec: 5 }, controller.signal);
    expect(result.isError).toBe(true);
    expect(text(result)).toContain('synthetic-abort-before-http');
    expect(fixture.selectProvider).toHaveBeenCalledOnce();
    expect(requests).toBe(0);
    expect(fixture.db).toHaveBeenCalled();
  });

  it('characterizes explicit current Operator access as host bash, not Worker bash', async () => {
    fixture.operatorAccess = true;
    fixture.currentRole = 'admin';
    vi.stubEnv('TOWER_PLATFORM_AGENT_PROJECT_IDS', 'synthetic-project');
    const assembly = await assemble('admin');
    expect(assembly.operatorHostAccess).toBe(true);
    await invoke(assembly, 'write', { path: path.join(host, 'operator.txt'), content: 'HOST-OPERATOR\n' });
    const output = await invoke(assembly, 'bash', { command: 'set -eu; test ! -e worker-only.txt; cat host-only.txt; cat operator.txt', timeout: 5 });
    expect(text(output)).toBe('HOST-ONLY\nHOST-OPERATOR\n');
    expect(requests).toBe(0);
    expect(fixture.selectProvider).not.toHaveBeenCalled();
    await expect(fs.stat(path.join(worker, 'operator.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(fixture.db).toHaveBeenCalled();
    expect(fixture.unused).not.toHaveBeenCalled();
  });
});


describe('actual Pi bash execution entrance boundaries', () => {
  it.each(['member', 'operator', 'admin'])('does not expose host fallback to %s when Runtime is disabled', async role => {
    fixture.runtimeEnabled = false;
    fixture.currentRole = role;
    const assembly = await assemble(role);
    expect(assembly.operatorHostAccess).toBe(false);
    const bash = assembly.allCustomTools.find(tool => tool.name === 'bash');
    await expect(bash.execute('no-fallback', { command: 'printf UNEXPECTED' }, new AbortController().signal))
      .rejects.toThrow('AGENT_EXECUTION_PLANE_UNAVAILABLE');
    expect(requests).toBe(0);
    expect(fixture.selectProvider).not.toHaveBeenCalled();
  });

  it.each(['admin', 'operator'])('executes an enabled Agent for %s without a server allowlist or Project Runtime', async role => {
    fixture.operatorAccess = true;
    fixture.currentRole = role;
    fixture.runtimeEnabled = false;
    const assembly = await assemble(role);
    expect(assembly.operatorHostAccess).toBe(true);
    expect(text(await invoke(assembly, 'bash', { command: 'printf HOST-OK' }))).toBe('HOST-OK');
    expect(fixture.selectProvider).not.toHaveBeenCalled();
  });

  it('does not expose host access to a member even when the Agent switch is on', async () => {
    fixture.operatorAccess = true;
    const assembly = await assemble('member');
    expect(assembly.operatorHostAccess).toBe(false);
    expect(await shell(assembly, 'cat worker-only.txt')).toBe('WORKER-ONLY\n');
  });

  it.each(['disabled', 'readonly', 'membership-revoked'])('rejects %s after assembly before provider selection or secret resolution', async mode => {
    const assembly = await assemble('admin'); // intentionally stale elevated opts
    if (mode === 'disabled') fixture.disabled = 1;
    if (mode === 'readonly') fixture.currentRole = 'viewer';
    if (mode === 'membership-revoked') fixture.membershipRole = null;
    const bash = assembly.allCustomTools.find(tool => tool.name === 'bash');
    const result = await bash.execute('revoked', { command: 'cat worker-only.txt' }, new AbortController().signal);
    expect(result.isError).toBe(true);
    expect(text(result)).toMatch(/AGENT_EXECUTION_(INACTIVE|ACCESS_DENIED)/);
    expect(fixture.selectProvider).not.toHaveBeenCalled();
    expect(requests).toBe(0);
  });

  it.each(['member', 'guest'])('does not let current %s enter a platform host Agent with stale admin opts', async role => {
    fixture.operatorAccess = true;
    fixture.currentRole = role;
    vi.stubEnv('TOWER_PLATFORM_AGENT_PROJECT_IDS', 'synthetic-project');
    const assembly = await assemble('admin');
    const bash = assembly.allCustomTools.find(tool => tool.name === 'bash');
    await expect(bash.execute('platform-denied', { command: 'printf UNEXPECTED' }, new AbortController().signal))
      .rejects.toThrow(/AGENT_PLATFORM_EXECUTION_DENIED|AGENT_EXECUTION_ACCESS_DENIED/);
    expect(requests).toBe(0);
  });

  it('keeps an approved admin host Agent out of the retired operator-plane Worker route', async () => {
    fixture.operatorAccess = true;
    fixture.currentRole = 'admin';
    vi.stubEnv('TOWER_PLATFORM_AGENT_PROJECT_IDS', 'synthetic-project');
    // A legacy compute binding must not be consulted for an approved native host.
    fixture.binding.mockRejectedValueOnce(new Error('OPERATOR_WORKER_RETIRED'));
    try {
      const assembly = await assemble('admin');
      expect(assembly.operatorHostAccess).toBe(true);
      expect(text(await invoke(assembly, 'bash', { command: 'printf APPROVED-HOST' }))).toBe('APPROVED-HOST');
      expect(fixture.binding).not.toHaveBeenCalled();
      expect(fixture.selectProvider).not.toHaveBeenCalled();
      expect(requests).toBe(0);
    } finally {
      fixture.binding.mockReset();
      fixture.binding.mockResolvedValue({ defaultWorkerId: 'synthetic-worker', workstationMode: true });
    }
  });

  it('recognizes platform approval added between tool assemblies without changing the requester', async () => {
    fixture.operatorAccess = false;
    fixture.currentRole = 'admin';
    expect((await assemble('admin')).operatorHostAccess).toBe(false);
    fixture.operatorAccess = true;
    const approved = await assemble('admin');
    expect(approved.operatorHostAccess).toBe(true);
    expect(text(await invoke(approved, 'bash', { command: 'printf APPROVED-AFTER-CHANGE' }))).toBe('APPROVED-AFTER-CHANGE');
  });

  it('rechecks platform binding revocation on an already assembled host tool', async () => {
    fixture.operatorAccess = true;
    fixture.currentRole = 'admin';
    vi.stubEnv('TOWER_PLATFORM_AGENT_PROJECT_IDS', 'synthetic-project');
    const assembly = await assemble('admin');
    fixture.operatorAccess = false;
    const bash = assembly.allCustomTools.find(tool => tool.name === 'bash');
    await expect(bash.execute('platform-revoked', { command: 'printf UNEXPECTED' }, new AbortController().signal))
      .rejects.toThrow(/AGENT_PLATFORM_EXECUTION_DENIED|AGENT_EXECUTION_ACCESS_DENIED/);
    expect(requests).toBe(0);
  });
});


describe('current requester execution revocation', () => {
  it.each(['viewer', 'guest'])('blocks bash after current role changes to %s even with owner membership', async role => {
    const assembly = await assemble();
    fixture.currentRole = role;
    fixture.membershipRole = 'owner';
    const before = requests;
    await expect(shell(assembly, 'printf UNEXPECTED')).rejects.toThrow('AGENT_EXECUTION_ACCESS_DENIED');
    expect(requests).toBe(before);
  });
});

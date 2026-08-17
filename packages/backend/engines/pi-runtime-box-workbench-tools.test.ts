import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createRuntimeBoxPiTools } from './pi-runtime-box-tools.js';
import { getOrCreateBox, execWorkbenchToolMutation } from '../services/runtime-box/runtime-box-manager.js';
import { inspectWorkbenchTools, listWorkbenchToolRevisions } from '../services/runtime-box/workbench-tools.js';
import { applyWorkbenchToolChange, previewWorkbenchToolChange } from '../services/runtime-box/workbench-tool-commands.js';
import { applyWorkbenchRuntimeRecreate, previewWorkbenchRuntimeRecreate } from '../services/runtime-box/workbench-runtime-recreate.js';

vi.mock('../services/runtime-box/runtime-box-manager.js', () => ({
  getOrCreateBox: vi.fn(), ensureRunning: vi.fn(), execInBox: vi.fn(), execWorkbenchToolMutation: vi.fn(),
  probeRuntimeBoxActivity: vi.fn(), recreateRuntimeBoxOnCurrentWorkbenchRevision: vi.fn(),
  runWithRuntimeBoxActivityLock: vi.fn(), execInBoxWithActivityLockHeld: vi.fn(), RuntimeBoxError: class extends Error {},
}));
vi.mock('../services/runtime-box/service-registry.js', () => ({
  listServices: vi.fn(), registerService: vi.fn(), startServiceProcess: vi.fn(), stopService: vi.fn(), readServiceLogs: vi.fn(), formatServiceList: vi.fn(),
}));
vi.mock('../services/runtime-box/workbench-tools.js', () => ({
  inspectWorkbenchTools: vi.fn(), listWorkbenchToolRevisions: vi.fn(), installUvWorkbenchTool: vi.fn(), importProjectPrefixWorkbenchTools: vi.fn(), rollbackWorkbenchTools: vi.fn(),
}));
vi.mock('../services/runtime-box/workbench-tool-commands.js', async importOriginal => {
  const actual = await importOriginal<any>();
  return { ...actual, previewWorkbenchToolChange: vi.fn(), applyWorkbenchToolChange: vi.fn() };
});
vi.mock('../services/runtime-box/workbench-runtime-recreate.js', () => ({
  previewWorkbenchRuntimeRecreate: vi.fn(), applyWorkbenchRuntimeRecreate: vi.fn(),
}));
vi.mock('../services/runtime-box/workbench-process-control.js', () => ({
  listWorkbenchProcesses: vi.fn(), inspectWorkbenchProcess: vi.fn(), readWorkbenchProcessLogs: vi.fn(), stopWorkbenchProcess: vi.fn(),
}));
vi.mock('../services/workspace/file-edit-log.js', () => ({ recordFileEdit: vi.fn() }));
vi.mock('../services/session/session-file-filter.js', () => ({ isUserFacingSessionFile: vi.fn().mockReturnValue(false) }));

const context = { userId: 7, userRole: 'operator', sessionId: 'session-a', projectId: 'project-a', projectName: 'A', projectRoot: '/tmp/project-a' };
const readText = (result: any) => result.content[0].text;

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('TOWER_EXPERIMENTAL_WORKBENCH_TOOLS_ENABLED', 'true');
  vi.stubEnv('TOWER_EXPERIMENTAL_WORKBENCH_TOOL_PROJECT_IDS', JSON.stringify(['project-a']));
  vi.mocked(getOrCreateBox).mockResolvedValue({ id: 10 } as any);
  vi.mocked(inspectWorkbenchTools).mockResolvedValue({ projectId: 'project-a', dbRevision: 1, filesystemRevision: 1, health: 'healthy', reason: 'agree' });
  vi.mocked(listWorkbenchToolRevisions).mockResolvedValue([]);
});

describe('Pi managed Workbench tool surface', () => {
  it('returns a capability inventory with inspection instead of making AI infer from package names', async () => {
    vi.mocked(listWorkbenchToolRevisions).mockResolvedValue([{ revision: 1, manifest: {
      schemaVersion: 1, workbenchId: 'project-a', revision: 1, createdAt: '2026-08-04T00:00:00Z',
      createdBy: { userId: 7, sessionId: null, jobId: null }, manager: 'uv-tool',
      tools: [{ name: 'ruff', version: '0.12.0', entrypoints: ['ruff'], installSpec: 'ruff==0.12.0' }],
      paths: { prefix: '.runtime-box/workbench-tools/revisions/000001', bin: '.runtime-box/workbench-tools/revisions/000001/bin' },
      validation: { status: 'passed', commands: [] }, previousRevision: null, rollbackRef: null,
    } } as any]);
    const tool: any = createRuntimeBoxPiTools(context).find(tool => tool.name === 'workbench_tool_inspect');
    const output = JSON.parse(readText(await tool.execute('inspect', {})));
    expect(output.inventory).toMatchObject({ status: 'ready', capabilityIds: ['python-format', 'python-lint'] });
  });

  it('registers one authority-routed bash plus managed diagnostic surfaces for internal dogfood', () => {
    const names = createRuntimeBoxPiTools({ ...context, workbenchRolloutEnabled: true }).map(tool => tool.name);
    expect(names).toContain('bash');
    expect(names).not.toContain('project_shell');
    expect(names).not.toContain('project_runtime_box_shell');
    expect(names).toContain('project_process');
    expect(names).toContain('project_shell_legacy');
    expect(names).not.toContain('workbench_execute');
    expect(names).toContain('workbench_job_list');
    expect(names).toContain('workbench_job_get');
    expect(names).toContain('workbench_job_cancel');
    expect(names).toContain('workbench_tool_inspect');
    expect(names).toContain('workbench_tool_preview_acquisition');
    expect(names).toContain('workbench_tool_preview_change');
    expect(names).toContain('workbench_tool_apply_change');
    expect(names).toContain('workbench_runtime_preview_recreate');
    expect(names).toContain('workbench_runtime_apply_recreate');
    expect(names).not.toContain('workbench_tool_install');
    expect(names).not.toContain('workbench_tool_rollback');
  });

  it('opens one bash to DB-enabled members without exposing Workbench management controls', () => {
    const names = createRuntimeBoxPiTools({ ...context, userRole: 'member', workbenchRolloutEnabled: true }).map(tool => tool.name);
    expect(names).toEqual(expect.arrayContaining(['bash', 'project_process', 'pdf_render']));
    expect(names).not.toContain('project_shell');
    expect(names).not.toContain('project_runtime_box_shell');
    expect(names).not.toContain('project_shell_legacy');
    expect(names).not.toContain('workbench_job_list');
    expect(names).not.toContain('service_start');
    expect(names).not.toContain('workbench_tool_inspect');
    expect(names).not.toContain('workbench_tool_preview_acquisition');
    expect(names).not.toContain('workbench_tool_preview_change');
    expect(names).not.toContain('workbench_tool_apply_change');
    expect(names).not.toContain('workbench_runtime_preview_recreate');
    expect(names).not.toContain('workbench_runtime_apply_recreate');
  });

  it('presents compatibility Projects with the same bash name', () => {
    const customerManagerNames = createRuntimeBoxPiTools({ ...context, userRole: 'customer_manager' }).map(tool => tool.name);
    expect(customerManagerNames).toContain('bash');
    expect(customerManagerNames).not.toContain('project_shell');
    expect(customerManagerNames).not.toContain('project_shell_legacy');
    expect(customerManagerNames).not.toContain('project_process');
    expect(customerManagerNames).not.toContain('workbench_job_list');
    expect(customerManagerNames).not.toContain('service_start');
    expect(customerManagerNames).not.toContain('workbench_tool_inspect');
    expect(customerManagerNames).not.toContain('workbench_tool_preview_acquisition');
    expect(customerManagerNames).not.toContain('workbench_tool_preview_change');
    expect(customerManagerNames).not.toContain('workbench_tool_apply_change');
    expect(customerManagerNames).not.toContain('workbench_runtime_preview_recreate');
    expect(customerManagerNames).not.toContain('workbench_runtime_apply_recreate');

    const otherProjectNames = createRuntimeBoxPiTools({ ...context, projectId: 'project-b', userRole: 'member', workbenchRolloutEnabled: false }).map(tool => tool.name);
    expect(otherProjectNames).toContain('bash');
    expect(otherProjectNames).not.toContain('project_shell');
    expect(otherProjectNames).not.toContain('project_shell_legacy');
    expect(otherProjectNames).not.toContain('project_process');
  });

  it('lets an explicit DB disable use compatibility bash without Workbench surfaces', () => {
    const names = createRuntimeBoxPiTools({ ...context, workbenchRolloutEnabled: false }).map(tool => tool.name);
    expect(names).toContain('bash');
    expect(names).not.toContain('project_shell');
    expect(names).not.toContain('project_shell_legacy');
    expect(names).not.toContain('project_process');
    expect(names).not.toContain('workbench_tool_inspect');
    expect(names).not.toContain('workbench_runtime_preview_recreate');
  });

  it('refuses member and customer_manager mutation previews', async () => {
    const params = { expectedRevision: 1, reason: 'needed', action: { kind: 'install', manager: 'uv-tool', tool: { name: 'ruff', version: '0.12.0', entrypoints: ['ruff'] } } };
    for (const userRole of ['member', 'customer_manager']) {
      const tool: any = createRuntimeBoxPiTools({ ...context, userRole }).find(tool => tool.name === 'workbench_tool_preview_change');
      expect(tool).toBeUndefined();
    }
    expect(previewWorkbenchToolChange).not.toHaveBeenCalled();
  });

  it('closes actor Project and Session context over preview', async () => {
    vi.mocked(previewWorkbenchToolChange).mockResolvedValue({ intentId: 'i', proposalHash: 'a'.repeat(64) } as any);
    const tool: any = createRuntimeBoxPiTools(context).find(tool => tool.name === 'workbench_tool_preview_change');
    await tool.execute('call-preview', { expectedRevision: 1, reason: 'needed', action: { kind: 'rollback', targetRevision: 1 } });
    expect(previewWorkbenchToolChange).toHaveBeenCalledWith(expect.objectContaining({
      projectId: 'project-a', projectRoot: '/tmp/project-a', actor: { userId: 7, role: 'operator', sessionId: 'session-a' },
    }));
  });

  it('refuses apply without explicit confirmation', async () => {
    const tool: any = createRuntimeBoxPiTools(context).find(tool => tool.name === 'workbench_tool_apply_change');
    const output = await tool.execute('call-apply', { intentId: 'i', proposalHash: 'a'.repeat(64), expectedRevision: 1, idempotencyKey: 'command-key', confirmed: false });
    expect(output.isError).toBe(true);
    expect(readText(output)).toContain('explicit approval');
    expect(applyWorkbenchToolChange).not.toHaveBeenCalled();
  });

  it('keeps recreate preview/apply separate and requires explicit confirmation', async () => {
    vi.mocked(previewWorkbenchRuntimeRecreate).mockResolvedValue({ intentId: 'r', proposalHash: 'b'.repeat(64) } as any);
    const tools: any[] = createRuntimeBoxPiTools(context);
    const preview: any = tools.find(tool => tool.name === 'workbench_runtime_preview_recreate');
    await preview.execute('preview', {});
    expect(previewWorkbenchRuntimeRecreate).toHaveBeenCalledWith(expect.objectContaining({
      projectId: 'project-a', projectRoot: '/tmp/project-a', actor: { userId: 7, role: 'operator', sessionId: 'session-a' },
    }));

    const apply: any = tools.find(tool => tool.name === 'workbench_runtime_apply_recreate');
    const refused = await apply.execute('apply', { intentId: 'r', proposalHash: 'b'.repeat(64), confirmed: false, serviceImpactAcknowledged: true });
    expect(refused.isError).toBe(true);
    expect(applyWorkbenchRuntimeRecreate).not.toHaveBeenCalled();

    vi.mocked(applyWorkbenchRuntimeRecreate).mockResolvedValue({ ok: true });
    await apply.execute('apply', { intentId: 'r', proposalHash: 'b'.repeat(64), confirmed: true, serviceImpactAcknowledged: true });
    expect(applyWorkbenchRuntimeRecreate).toHaveBeenCalledWith(expect.objectContaining({ confirmed: true, serviceImpactAcknowledged: true }));
  });

  it('passes exact approved fields to command service and keeps runner credential-free', async () => {
    vi.mocked(applyWorkbenchToolChange).mockImplementationOnce(async (input: any) => {
      await input.dependencies.install({ projectId: 'project-a', projectRoot: '/tmp/project-a', spec: { name: 'ruff', version: '0.12.0', entrypoints: ['ruff'] }, actor: {} });
      return { revision: 2 };
    });
    const { installUvWorkbenchTool } = await import('../services/runtime-box/workbench-tools.js');
    vi.mocked(installUvWorkbenchTool).mockImplementationOnce(async (input: any) => {
      await input.run({
        command: 'uv --version', cwd: '/workspace', credentialFree: true,
        candidateHostPath: '/store/staging/cmd', candidateContainerPath: '/workspace/.runtime-box/workbench-tools/active', candidateMountMode: 'rw',
      });
      return { revision: 2 } as any;
    });
    vi.mocked(execWorkbenchToolMutation).mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' });
    const tool: any = createRuntimeBoxPiTools(context).find(tool => tool.name === 'workbench_tool_apply_change');
    const output = await tool.execute('call-apply', { intentId: 'i', proposalHash: 'a'.repeat(64), expectedRevision: 1, idempotencyKey: 'command-key', confirmed: true });
    expect(output.isError).not.toBe(true);
    expect(applyWorkbenchToolChange).toHaveBeenCalledWith(expect.objectContaining({ intentId: 'i', proposalHash: 'a'.repeat(64), expectedRevision: 1, idempotencyKey: 'command-key', confirmed: true }));
    expect(execWorkbenchToolMutation).toHaveBeenCalledWith(expect.objectContaining({
      projectId: 'project-a', projectRoot: '/tmp/project-a', candidateHostPath: '/store/staging/cmd',
      candidateContainerPath: '/workspace/.runtime-box/workbench-tools/active', candidateMountMode: 'rw',
    }));
  });
});

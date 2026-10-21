import { beforeEach, describe, expect, it, vi } from 'vitest';

const inspectFileTransfer = vi.fn();
const confirmFileTransferPlan = vi.fn();
const executeFileTransfer = vi.fn();
const getSessionProjectAgentRuntimeProfile = vi.fn();
const getProject = vi.fn();
const getProjects = vi.fn();
const isPathAccessible = vi.fn();

vi.mock('../services/file-exchange/file-exchange-service.js', () => ({ inspectFileTransfer, confirmFileTransferPlan, executeFileTransfer }));
vi.mock('../services/pm/project-agent-profile.js', () => ({ getSessionProjectAgentRuntimeProfile }));
vi.mock('../services/pm/project-manager.js', () => ({ getProject, getProjects }));
vi.mock('../services/pm/project-access.js', () => ({ isPathAccessible }));

const { createDeliverDirectoryTool, createDeliverFileTool, createImportPersonalFileToProjectTool } = await import('./pi-file-exchange-tool.js');
const askUser = vi.fn();
const ctx = { userId: 7, userRole: 'member', sessionId: 'session-1', projectId: 'project-a', askUser };

function output(result: any): string { return result.content[0].text; }

describe('Personal Space Project import agent tool', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getSessionProjectAgentRuntimeProfile.mockResolvedValue({ profileVersion: 4 });
    inspectFileTransfer.mockResolvedValue({ id: 'plan-personal', sourceName: 'draft.md', confirmationRequired: true });
    executeFileTransfer.mockResolvedValue({ id: 'receipt-personal', status: 'completed', result: { scope: 'project', projectId: 'project-a', relativePath: 'sources/draft.md', name: 'draft.md' } });
  });

  it('imports only the exact owner-scoped Personal URI into the current Project after approval', async () => {
    askUser.mockResolvedValueOnce('가져오기 승인');
    const result = await createImportPersonalFileToProjectTool(ctx)!.execute('call-personal', {
      sourceUri: 'personal://notes/draft.md', destinationDirectory: 'sources',
    } as any);

    expect(inspectFileTransfer).toHaveBeenCalledWith(expect.objectContaining({
      userId: 7,
      principal: { kind: 'agent', projectId: 'project-a', sessionId: 'session-1', profileVersion: 4 },
    }), {
      source: { scope: 'personal', uri: 'personal://notes/draft.md' },
      destination: { scope: 'project', projectId: 'project-a', relativeDirectory: 'sources' },
    });
    expect(askUser).toHaveBeenCalledWith('personal-import-plan-personal', expect.any(Array));
    expect(confirmFileTransferPlan).toHaveBeenCalledWith(expect.any(Object), 'plan-personal');
    expect(executeFileTransfer).toHaveBeenCalledWith(expect.any(Object), 'plan-personal');
    expect(JSON.parse(output(result))).toMatchObject({ ok: true, relativePath: 'sources/draft.md' });
  });

  it('does not execute a cancelled import and rejects invalid source or destination paths', async () => {
    askUser.mockResolvedValueOnce('취소');
    const tool = createImportPersonalFileToProjectTool(ctx)!;
    const cancelled = await tool.execute('call-cancel', { sourceUri: 'personal://notes/draft.md' } as any);
    const invalidSource = await tool.execute('call-source', { sourceUri: 'notes/draft.md' } as any);
    const invalidDestination = await tool.execute('call-destination', { sourceUri: 'personal://notes/draft.md', destinationDirectory: '../outside' } as any);

    expect(JSON.parse(output(cancelled)).cancelled).toBe(true);
    expect(invalidSource.isError).toBe(true);
    expect(invalidDestination.isError).toBe(true);
    expect(confirmFileTransferPlan).not.toHaveBeenCalled();
    expect(executeFileTransfer).not.toHaveBeenCalled();
    expect(inspectFileTransfer).toHaveBeenCalledTimes(1);
  });
});

describe('deliver_file agent tool', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getSessionProjectAgentRuntimeProfile.mockResolvedValue({ profileVersion: 4 });
    isPathAccessible.mockResolvedValue(true);
    getProjects.mockResolvedValue([
      { id: 'project-a', name: 'Source', rootPath: '/workspace/projects/source', agent: { displayName: 'Source Agent' } },
      { id: 'project-b', name: 'Reports', rootPath: '/workspace/projects/reports', agent: { displayName: '보고서 담당' } },
    ]);
    inspectFileTransfer.mockResolvedValue({ id: 'plan-1', sourceName: 'report.pdf', confirmationRequired: false });
    executeFileTransfer.mockResolvedValue({ id: 'receipt-1', status: 'completed', result: { scope: 'session' } });
  });

  it('binds the source and agent provenance to the current Project and Session', async () => {
    const tool = createDeliverFileTool(ctx)!;
    const result = await tool.execute('call-1', { sourceRelativePath: 'final/report.pdf', destination: 'session' } as any);

    expect(inspectFileTransfer).toHaveBeenCalledWith(expect.objectContaining({
      userId: 7,
      principal: { kind: 'agent', projectId: 'project-a', sessionId: 'session-1', profileVersion: 4 },
    }), {
      source: { scope: 'project', projectId: 'project-a', relativePath: 'final/report.pdf' },
      destination: { scope: 'session', sessionId: 'session-1' },
    });
    expect(askUser).not.toHaveBeenCalled();
    expect(executeFileTransfer).toHaveBeenCalledWith(expect.any(Object), 'plan-1');
    expect(JSON.parse(output(result)).ok).toBe(true);
  });

  it('records an interactive user approval before a Personal Space copy', async () => {
    inspectFileTransfer.mockResolvedValueOnce({ id: 'plan-2', sourceName: 'report.pdf', confirmationRequired: true, confirmationMessage: '내 자료에 저장할까요?' });
    askUser.mockResolvedValueOnce('내 자료에 저장할까요?: 전달 승인');
    const tool = createDeliverFileTool(ctx)!;
    const result = await tool.execute('call-2', { sourceRelativePath: 'final/report.pdf', destination: 'personal' } as any);

    expect(askUser).toHaveBeenCalledWith('file-exchange-plan-2', expect.any(Array));
    expect(confirmFileTransferPlan).toHaveBeenCalledWith(expect.any(Object), 'plan-2');
    expect(executeFileTransfer).toHaveBeenCalledWith(expect.any(Object), 'plan-2');
    expect(JSON.parse(output(result)).ok).toBe(true);
  });

  it('does not confirm or execute when the user cancels', async () => {
    inspectFileTransfer.mockResolvedValueOnce({ id: 'plan-3', sourceName: 'report.pdf', confirmationRequired: true });
    askUser.mockResolvedValueOnce('파일 report.pdf을 전달할까요?: 취소');
    const tool = createDeliverFileTool(ctx)!;
    const result = await tool.execute('call-3', { sourceRelativePath: 'final/report.pdf', destination: 'personal' } as any);

    expect(confirmFileTransferPlan).not.toHaveBeenCalled();
    expect(executeFileTransfer).not.toHaveBeenCalled();
    expect(JSON.parse(output(result))).toMatchObject({ status: 'user_cancelled', cancelled: true });
  });

  it('distinguishes unavailable approval UI and unknown answers from user cancellation', async () => {
    inspectFileTransfer.mockResolvedValue({ id: 'plan-4', sourceName: 'report.pdf', confirmationRequired: true });
    const tool = createDeliverFileTool(ctx)!;

    askUser.mockResolvedValueOnce('Interactive approval unavailable for this execution mode.');
    const unavailable = await tool.execute('call-unavailable', { sourceRelativePath: 'final/report.pdf', destination: 'project', destinationProjectId: 'project-b' } as any);
    askUser.mockResolvedValueOnce('unexpected transport response');
    const invalid = await tool.execute('call-invalid', { sourceRelativePath: 'final/report.pdf', destination: 'project', destinationProjectId: 'project-b' } as any);

    expect(JSON.parse(output(unavailable))).toMatchObject({ status: 'approval_unavailable', errorCode: 'APPROVAL_UI_UNAVAILABLE', cancelled: false });
    expect(JSON.parse(output(invalid))).toMatchObject({ status: 'invalid_answer', errorCode: 'APPROVAL_INVALID_ANSWER', cancelled: false });
    expect(unavailable.isError).toBe(true);
    expect(invalid.isError).toBe(true);
    expect(confirmFileTransferPlan).not.toHaveBeenCalled();
    expect(executeFileTransfer).not.toHaveBeenCalled();
  });

  it('resolves an exact agent name without requiring the user to know its UUID', async () => {
    inspectFileTransfer.mockResolvedValueOnce({ id: 'plan-name', sourceName: 'report.pdf', confirmationRequired: true });
    askUser.mockResolvedValueOnce('전달 승인');

    const result = await createDeliverFileTool(ctx)!.execute('call-name', {
      sourceRelativePath: 'final/report.pdf', destination: 'project', destinationProject: '보고서 담당', destinationDirectory: 'incoming',
    } as any);

    expect(inspectFileTransfer).toHaveBeenCalledWith(expect.any(Object), {
      source: { scope: 'project', projectId: 'project-a', relativePath: 'final/report.pdf' },
      destination: { scope: 'project', projectId: 'project-b', relativeDirectory: 'incoming' },
    });
    expect(JSON.parse(output(result)).ok).toBe(true);
  });

  it('infers the Project and destination directory from an accessible absolute path', async () => {
    inspectFileTransfer.mockResolvedValueOnce({ id: 'plan-path', sourceName: 'report.pdf', confirmationRequired: true });
    askUser.mockResolvedValueOnce('전달 승인');

    await createDeliverFileTool(ctx)!.execute('call-path', {
      sourceRelativePath: 'final/report.pdf', destination: 'project', destinationProject: '/workspace/projects/reports/incoming/quarterly',
    } as any);

    expect(inspectFileTransfer).toHaveBeenCalledWith(expect.any(Object), expect.objectContaining({
      destination: { scope: 'project', projectId: 'project-b', relativeDirectory: 'incoming/quarterly' },
    }));
  });

  it('rejects traversal, inaccessible paths, ambiguous names, and a same-Project destination', async () => {
    const tool = createDeliverFileTool(ctx)!;
    const traversal = await tool.execute('call-4', { sourceRelativePath: '../secret', destination: 'session' } as any);
    const sameProject = await tool.execute('call-5', { sourceRelativePath: 'a.txt', destination: 'project', destinationProject: 'Source Agent' } as any);
    const inaccessiblePath = await tool.execute('call-6', { sourceRelativePath: 'a.txt', destination: 'project', destinationProject: '/workspace/projects/private' } as any);
    getProjects.mockResolvedValueOnce([
      { id: 'project-b', name: 'Shared', rootPath: '/workspace/projects/b' },
      { id: 'project-c', name: 'Shared', rootPath: '/workspace/projects/c' },
    ]);
    const ambiguous = await tool.execute('call-7', { sourceRelativePath: 'a.txt', destination: 'project', destinationProject: 'Shared' } as any);

    expect(traversal.isError).toBe(true);
    expect(sameProject.isError).toBe(true);
    expect(inaccessiblePath.isError).toBe(true);
    expect(output(inaccessiblePath)).toContain('not found among Projects accessible');
    expect(ambiguous.isError).toBe(true);
    expect(output(ambiguous)).toContain('ambiguous');
    expect(inspectFileTransfer).not.toHaveBeenCalled();
  });

  it('delivers a directory tree after one manifest approval', async () => {
    const fs = await import('fs/promises');
    const os = await import('os');
    const path = await import('path');
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'deliver-directory-'));
    await fs.mkdir(path.join(root, 'bundle', 'nested'), { recursive: true });
    await fs.writeFile(path.join(root, 'bundle', 'a.txt'), 'a');
    await fs.writeFile(path.join(root, 'bundle', 'nested', 'b.txt'), 'bb');
    getProject.mockResolvedValue({ rootPath: root });
    inspectFileTransfer.mockReset();
    inspectFileTransfer.mockResolvedValueOnce({ id: 'plan-a', sourceSizeBytes: 1 }).mockResolvedValueOnce({ id: 'plan-b', sourceSizeBytes: 2 });
    executeFileTransfer.mockReset();
    executeFileTransfer.mockResolvedValueOnce({ id: 'receipt-a', status: 'completed' }).mockResolvedValueOnce({ id: 'receipt-b', status: 'completed' });
    askUser.mockResolvedValueOnce('폴더 전달 승인');

    const result = await createDeliverDirectoryTool(ctx)!.execute('call-dir', {
      sourceRelativePath: 'bundle', destinationProjectId: 'project-b', destinationDirectory: 'incoming',
    } as any);

    expect(inspectFileTransfer).toHaveBeenNthCalledWith(1, expect.any(Object), {
      source: { scope: 'project', projectId: 'project-a', relativePath: 'bundle/a.txt' },
      destination: { scope: 'project', projectId: 'project-b', relativeDirectory: 'incoming/bundle' },
    });
    expect(inspectFileTransfer).toHaveBeenNthCalledWith(2, expect.any(Object), {
      source: { scope: 'project', projectId: 'project-a', relativePath: 'bundle/nested/b.txt' },
      destination: { scope: 'project', projectId: 'project-b', relativeDirectory: 'incoming/bundle/nested' },
    });
    expect(confirmFileTransferPlan).toHaveBeenCalledTimes(2);
    expect(JSON.parse(output(result))).toMatchObject({ ok: true, fileCount: 2, completedCount: 2, totalBytes: 3 });
    await fs.rm(root, { recursive: true, force: true });
  });
});

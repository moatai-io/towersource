import { beforeEach, describe, expect, it, vi } from 'vitest';

const inspectFileTransfer = vi.fn();
const confirmFileTransferPlan = vi.fn();
const executeFileTransfer = vi.fn();
const getSessionProjectAgentRuntimeProfile = vi.fn();
const getProject = vi.fn();
const isPathAccessible = vi.fn();

vi.mock('../services/file-exchange/file-exchange-service.js', () => ({ inspectFileTransfer, confirmFileTransferPlan, executeFileTransfer }));
vi.mock('../services/pm/project-agent-profile.js', () => ({ getSessionProjectAgentRuntimeProfile }));
vi.mock('../services/pm/project-manager.js', () => ({ getProject }));
vi.mock('../services/pm/project-access.js', () => ({ isPathAccessible }));

const { createDeliverDirectoryTool, createDeliverFileTool } = await import('./pi-file-exchange-tool.js');
const askUser = vi.fn();
const ctx = { userId: 7, userRole: 'member', sessionId: 'session-1', projectId: 'project-a', askUser };

function output(result: any): string { return result.content[0].text; }

describe('deliver_file agent tool', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getSessionProjectAgentRuntimeProfile.mockResolvedValue({ profileVersion: 4 });
    isPathAccessible.mockResolvedValue(true);
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
    askUser.mockResolvedValueOnce('전달 승인');
    const tool = createDeliverFileTool(ctx)!;
    const result = await tool.execute('call-2', { sourceRelativePath: 'final/report.pdf', destination: 'personal' } as any);

    expect(askUser).toHaveBeenCalledWith('file-exchange-plan-2', expect.any(Array));
    expect(confirmFileTransferPlan).toHaveBeenCalledWith(expect.any(Object), 'plan-2');
    expect(executeFileTransfer).toHaveBeenCalledWith(expect.any(Object), 'plan-2');
    expect(JSON.parse(output(result)).ok).toBe(true);
  });

  it('does not confirm or execute when the user cancels', async () => {
    inspectFileTransfer.mockResolvedValueOnce({ id: 'plan-3', sourceName: 'report.pdf', confirmationRequired: true });
    askUser.mockResolvedValueOnce('취소');
    const tool = createDeliverFileTool(ctx)!;
    const result = await tool.execute('call-3', { sourceRelativePath: 'final/report.pdf', destination: 'personal' } as any);

    expect(confirmFileTransferPlan).not.toHaveBeenCalled();
    expect(executeFileTransfer).not.toHaveBeenCalled();
    expect(JSON.parse(output(result)).cancelled).toBe(true);
  });

  it('rejects traversal and a same-Project destination', async () => {
    const tool = createDeliverFileTool(ctx)!;
    const traversal = await tool.execute('call-4', { sourceRelativePath: '../secret', destination: 'session' } as any);
    const sameProject = await tool.execute('call-5', { sourceRelativePath: 'a.txt', destination: 'project', destinationProjectId: 'project-a' } as any);

    expect(traversal.isError).toBe(true);
    expect(sameProject.isError).toBe(true);
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

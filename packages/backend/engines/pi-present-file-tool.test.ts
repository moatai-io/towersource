import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'fs/promises';
import path from 'path';
import os from 'os';

const workspaceMocks = vi.hoisted(() => ({ resolve: vi.fn(), exists: vi.fn() }));
vi.mock('../services/pm/project-access.js', () => ({ isPathAccessible: vi.fn(async () => true) }));
vi.mock('../services/project-environment/project-workspace-files.js', () => ({
  resolveProjectWorkspaceFile: workspaceMocks.resolve,
  projectWorkspaceEntryExists: workspaceMocks.exists,
}));

const readText = (result: any) => result.content?.[0]?.text || '';

describe('present_file Pi tool', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'tower-present-file-'));
    workspaceMocks.resolve.mockReset(); workspaceMocks.exists.mockReset();
    workspaceMocks.resolve.mockImplementation(async ({ projectId, projectRoot, relativePath }: any) => ({ projectId, projectRoot, relativePath, hostPath: path.join(projectRoot, relativePath) }));
    workspaceMocks.exists.mockResolvedValue({ exists: true, storageAuthority: 'worker' });
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('returns a structured Viewer Pane presentation contract for an existing accessible file', async () => {
    const { createPresentFileTool } = await import('./pi-present-file-tool.js');
    const filePath = path.join(dir, 'report.md');
    await writeFile(filePath, '# Report\n');

    const tool = createPresentFileTool({ userId: 7, userRole: 'member', cwd: dir });
    const result = await tool.execute('call-1', { path: 'report.md', split: 'bottom', label: 'Executive report' });

    expect(result.isError).not.toBe(true);
    const payload = JSON.parse(readText(result));
    expect(payload).toMatchObject({
      ok: true,
      action: 'present_file',
      path: filePath,
      split: 'right',
      pane: 'right',
      label: 'Executive report',
      focus: true,
    });
  });

  it('checks Project-backed existence through workspace authority without host file access', async () => {
    const { createPresentFileTool } = await import('./pi-present-file-tool.js');
    const tool = createPresentFileTool({ userId: 7, userRole: 'member', cwd: dir, projectId: 'p1', projectRoot: dir });
    const result: any = await tool.execute('call-project', { path: 'worker-only.md' });
    expect(result.isError).toBe(false);
    expect(workspaceMocks.resolve).toHaveBeenCalledWith(expect.objectContaining({ projectId: 'p1', relativePath: 'worker-only.md' }));
    expect(workspaceMocks.exists).toHaveBeenCalledWith(expect.objectContaining({ actorUserId: 7 }));
    expect(await import('fs/promises').then(fs => fs.stat(path.join(dir, 'worker-only.md')).catch(() => null))).toBeNull();
  });

  it('does not report successful presentation for an unreadable canonical host file', async () => {
    const { createPresentFileTool } = await import('./pi-present-file-tool.js');
    const fs = await import('fs/promises');
    const denied = vi.spyOn(fs.default, 'access').mockRejectedValueOnce(Object.assign(new Error('publication required: EACCES'), { code: 'EACCES' }));
    workspaceMocks.exists.mockResolvedValue({ exists: true, storageAuthority: 'host' });
    try {
      const tool = createPresentFileTool({ userId: 7, userRole: 'member', cwd: dir, projectId: 'p1', projectRoot: dir });
      const result: any = await tool.execute('call-denied', { path: 'private.md' });
      expect(result.isError).toBe(true);
      expect(readText(result)).toContain('SHARED_OUTPUT_NOT_READABLE');
    } finally { denied.mockRestore(); }
  });

  it('rejects Project presentation outside the registered root before authority access', async () => {
    const { createPresentFileTool } = await import('./pi-present-file-tool.js');
    const tool = createPresentFileTool({ userId: 7, userRole: 'member', cwd: dir, projectId: 'p1', projectRoot: dir });
    const result: any = await tool.execute('call-outside', { path: path.join(dir, '..', 'other.md') });
    expect(result.isError).toBe(true);
    expect(readText(result)).toContain('outside the current Project');
    expect(workspaceMocks.exists).not.toHaveBeenCalled();
  });

  it('does not present missing files', async () => {
    const { createPresentFileTool } = await import('./pi-present-file-tool.js');
    const tool = createPresentFileTool({ userId: 7, userRole: 'member', cwd: dir });

    const result = await tool.execute('call-2', { path: 'missing.md' });

    expect(result.isError).toBe(true);
    expect(readText(result)).toContain('path is not an existing file');
  });
});

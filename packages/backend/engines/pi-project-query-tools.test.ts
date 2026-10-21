import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  compareAndSwapProjectWorkspaceText,
  createProjectWorkspaceDirectory,
  listProjectWorkspaceDirectory,
  projectWorkspaceEntryExists,
  readProjectWorkspaceFileBytes,
  resolveProjectWorkspaceFile,
  writeProjectWorkspaceText,
} from '../services/project-environment/project-workspace-files.js';
import { isPathAccessible, isPathWritableByRole } from '../services/pm/project-access.js';
import { createProjectFindTool, createProjectGrepTool, createProjectMutationOperations, createProjectQueryOperations } from './pi-project-query-tools.js';

vi.mock('../services/pm/project-access.js', () => ({ isPathAccessible: vi.fn(async () => true), isPathWritableByRole: vi.fn(async () => true) }));
vi.mock('../services/project-environment/project-workspace-files.js', () => ({
  resolveProjectWorkspaceFile: vi.fn(async ({ projectId, projectRoot, relativePath, allowProjectRoot }) => ({ projectId, projectRoot, relativePath, hostPath: path.join(projectRoot, relativePath), allowProjectRoot })),
  compareAndSwapProjectWorkspaceText: vi.fn(),
  createProjectWorkspaceDirectory: vi.fn(),
  writeProjectWorkspaceText: vi.fn(),
  projectWorkspaceEntryExists: vi.fn(async () => ({ exists: true, storageAuthority: 'worker' })),
  readProjectWorkspaceFileBytes: vi.fn(),
  listProjectWorkspaceDirectory: vi.fn(),
}));

const root = '/workspace/project-a';
const tree: Record<string, Array<{ name: string; isDirectory: boolean }>> = {
  '.': [{ name: '.git', isDirectory: true }, { name: 'docs', isDirectory: true }, { name: 'README.md', isDirectory: false }],
  docs: [{ name: 'guide.md', isDirectory: false }, { name: 'nested', isDirectory: true }],
  'docs/nested': [{ name: 'notes.txt', isDirectory: false }],
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(listProjectWorkspaceDirectory).mockImplementation(async ({ reference }: any) => ({ storageAuthority: 'worker', entries: tree[reference.relativePath] || [] }));
  vi.mocked(readProjectWorkspaceFileBytes).mockImplementation(async ({ reference }: any) => ({ storageKind: 'worker', bytes: Buffer.from(reference.relativePath === 'docs/guide.md' ? 'before\nNeedle here\nafter' : 'unrelated') }));
});

describe('Project query operations', () => {
  it('lists through workspace authority and preserves file/directory typing', async () => {
    const ops = createProjectQueryOperations({ projectId: 'p', projectRoot: root, actorUserId: 7 });
    expect(await ops.ls.readdir(root)).toEqual(['.git', 'docs', 'README.md']);
    expect((await ops.ls.stat(path.join(root, 'docs'))).isDirectory()).toBe(true);
    expect(resolveProjectWorkspaceFile).toHaveBeenCalledWith(expect.objectContaining({ projectId: 'p', relativePath: '.', allowProjectRoot: true }));
    expect(listProjectWorkspaceDirectory).toHaveBeenCalledWith(expect.objectContaining({ actorUserId: 7, depth: 1 }));
  });

  it('checks Project root existence through the live authority boundary', async () => {
    const ops = createProjectQueryOperations({ projectId: 'p', projectRoot: root, actorUserId: 7 });
    vi.mocked(projectWorkspaceEntryExists).mockRejectedValueOnce(new Error('PROJECT_FILE_SOURCE_ACCESS_REVOKED'));
    await expect(ops.find.exists(root)).rejects.toThrow('PROJECT_FILE_SOURCE_ACCESS_REVOKED');
  });

  it('finds bounded matches via recursive directory listing and ignores managed folders', async () => {
    const ops = createProjectQueryOperations({ projectId: 'p', projectRoot: root, actorUserId: 7 });
    expect(await ops.find.glob('**/*.md', root, { ignore: [], limit: 10 })).toEqual(['docs/guide.md', 'README.md']);
    expect(vi.mocked(listProjectWorkspaceDirectory).mock.calls.some(([arg]: any) => arg.reference.relativePath === '.git')).toBe(false);
  });

  it('enforces limits and rejects paths outside the registered root before storage access', async () => {
    const ops = createProjectQueryOperations({ projectId: 'p', projectRoot: root, actorUserId: 7 });
    expect(await ops.find.glob('**/*', root, { ignore: [], limit: 1 })).toHaveLength(1);
    await expect(ops.ls.readdir('/workspace/project-b')).rejects.toThrow('PROJECT_FILE_SOURCE_OUTSIDE_ROOT');
    expect(vi.mocked(listProjectWorkspaceDirectory).mock.calls.every(([arg]: any) => arg.reference.projectRoot === root)).toBe(true);
  });

  it('propagates storage authority failures without host fallback', async () => {
    vi.mocked(listProjectWorkspaceDirectory).mockRejectedValueOnce(new Error('WORKER_FILE_AUTHORITY_UNAVAILABLE'));
    const ops = createProjectQueryOperations({ projectId: 'p', projectRoot: root, actorUserId: 7 });
    await expect(ops.ls.readdir(root)).rejects.toThrow('WORKER_FILE_AUTHORITY_UNAVAILABLE');
    expect(projectWorkspaceEntryExists).not.toHaveBeenCalled();
  });

  it('greps bounded text through workspace authority and preserves context output', async () => {
    const tool = createProjectGrepTool({ projectId: 'p', projectRoot: root, actorUserId: 7 });
    const result: any = await tool.execute('g1', { pattern: 'needle', path: 'docs', glob: '**/*.md', ignoreCase: true, context: 1, limit: 10 });
    expect(result.content[0].text).toContain('guide.md:2:Needle here');
    expect(result.content[0].text).toContain('guide.md:1:before');
    expect(readProjectWorkspaceFileBytes).toHaveBeenCalledWith(expect.objectContaining({ actorUserId: 7, maxBytes: 2 * 1024 * 1024 }));
  });

  it('rechecks current access and refuses mutation after membership revocation', async () => {
    vi.mocked(isPathWritableByRole).mockResolvedValueOnce(false);
    const ops = createProjectMutationOperations({ projectId: 'p', projectRoot: root, actorUserId: 7, actorRole: 'member' });
    await expect(ops.write.writeFile(path.join(root, 'blocked.md'), 'x')).rejects.toThrow('PROJECT_FILE_WRITE_ACCESS_REVOKED');
    expect(projectWorkspaceEntryExists).not.toHaveBeenCalled();
    vi.mocked(isPathAccessible).mockResolvedValueOnce(false);
    const query = createProjectQueryOperations({ projectId: 'p', projectRoot: root, actorUserId: 7, actorRole: 'member' });
    await expect(query.ls.readdir(root)).rejects.toThrow('PROJECT_FILE_READ_ACCESS_REVOKED');
    expect(listProjectWorkspaceDirectory).not.toHaveBeenCalled();
  });

  it('creates new files exclusively and creates directories through workspace authority', async () => {
    vi.mocked(projectWorkspaceEntryExists).mockResolvedValueOnce({ exists: false, storageAuthority: 'worker' });
    const ops = createProjectMutationOperations({ projectId: 'p', projectRoot: root, actorUserId: 7 });
    await ops.write.mkdir(path.join(root, 'new'));
    await ops.write.writeFile(path.join(root, 'new/report.md'), 'created');
    expect(createProjectWorkspaceDirectory).toHaveBeenCalledWith(expect.objectContaining({ actorUserId: 7, exclusive: false }));
    expect(writeProjectWorkspaceText).toHaveBeenCalledWith(expect.objectContaining({ actorUserId: 7, content: 'created', exclusive: true }));
    expect(compareAndSwapProjectWorkspaceText).not.toHaveBeenCalled();
  });

  it('edits with exact observed content and rejects path escape before mutation', async () => {
    vi.mocked(readProjectWorkspaceFileBytes).mockResolvedValue({ storageKind: 'worker', bytes: Buffer.from('old text') });
    const ops = createProjectMutationOperations({ projectId: 'p', projectRoot: root, actorUserId: 7 });
    const target = path.join(root, 'README.md');
    expect((await ops.edit.readFile(target)).toString()).toBe('old text');
    await ops.edit.writeFile(target, 'new text');
    expect(compareAndSwapProjectWorkspaceText).toHaveBeenCalledWith(expect.objectContaining({ expectedContent: 'old text', content: 'new text' }));
    await expect(ops.write.writeFile('/workspace/project-b/oops.md', 'x')).rejects.toThrow('PROJECT_FILE_SOURCE_OUTSIDE_ROOT');
    expect(writeProjectWorkspaceText).not.toHaveBeenCalledWith(expect.objectContaining({ content: 'x' }));
  });

  it('propagates compare-and-swap conflict without fallback overwrite', async () => {
    vi.mocked(readProjectWorkspaceFileBytes).mockResolvedValue({ storageKind: 'worker', bytes: Buffer.from('old') });
    vi.mocked(compareAndSwapProjectWorkspaceText).mockRejectedValueOnce(new Error('WORKSPACE_COMPARE_AND_SWAP_CONFLICT'));
    const ops = createProjectMutationOperations({ projectId: 'p', projectRoot: root, actorUserId: 7 });
    const target = path.join(root, 'README.md');
    await ops.edit.readFile(target);
    await expect(ops.edit.writeFile(target, 'changed')).rejects.toThrow('WORKSPACE_COMPARE_AND_SWAP_CONFLICT');
    expect(writeProjectWorkspaceText).not.toHaveBeenCalledWith(expect.objectContaining({ content: 'changed' }));
  });

  it('rejects unsafe regexes before reading Project files', async () => {
    const tool = createProjectGrepTool({ projectId: 'p', projectRoot: root, actorUserId: 7 });
    await expect(tool.execute('g0', { pattern: '(a+)+', path: 'docs' })).rejects.toThrow('UNSAFE_SEARCH_PATTERN');
    await expect(tool.execute('g1', { pattern: 'x'.repeat(501), path: 'docs' })).rejects.toThrow('SEARCH_PATTERN_TOO_LONG');
    expect(readProjectWorkspaceFileBytes).not.toHaveBeenCalled();
  });

  it('skips binary files and rejects grep outside the Project root without reads', async () => {
    vi.mocked(readProjectWorkspaceFileBytes).mockResolvedValueOnce({ storageKind: 'worker', bytes: Buffer.from([0, 1, 2]) });
    const tool = createProjectGrepTool({ projectId: 'p', projectRoot: root, actorUserId: 7 });
    const binary: any = await tool.execute('g1', { pattern: 'x', path: 'README.md' });
    expect(binary.content[0].text).toBe('No matches found');
    vi.mocked(readProjectWorkspaceFileBytes).mockClear();
    await expect(tool.execute('g2', { pattern: 'x', path: '../project-b' })).rejects.toThrow('PROJECT_FILE_SOURCE_OUTSIDE_ROOT');
    expect(readProjectWorkspaceFileBytes).not.toHaveBeenCalled();
  });
});


describe('Project find partial success', () => {
  const input = { projectId: 'p', projectRoot: root, actorUserId: 7 };
  it.each(['EACCES', 'EPERM', 'ENOENT'])('continues after %s and reports skipped paths', async code => {
    vi.mocked(listProjectWorkspaceDirectory).mockImplementation(async ({ reference }) => {
      if (reference.relativePath === '.') return { storageAuthority: 'worker', entries: [
        { name: 'blocked', path: '/host/project/blocked', isDirectory: true },
        { name: 'quote-R3.pdf', path: '/host/project/quote-R3.pdf', isDirectory: false },
      ] };
      throw Object.assign(new Error(code), { code });
    });
    const tool = createProjectFindTool(input);
    const result: any = await tool.execute('find', { pattern: '**/*.pdf' }, new AbortController().signal);
    expect(result.content[0].text).toContain('quote-R3.pdf');
    expect(result.details).toMatchObject({ partial: true, skippedPaths: [{ path: 'blocked', code }] });
  });
  it('reports inaccessible lstat entries and still finds normal files', async () => {
    vi.mocked(listProjectWorkspaceDirectory).mockResolvedValue({ storageAuthority: 'worker', entries: [
      { name: 'user', path: '/host/project/user', isDirectory: true, traversalError: 'EACCES' } as any,
      { name: 'quote-R6.pdf', path: '/host/project/quote-R6.pdf', isDirectory: false },
    ] });
    const result: any = await createProjectFindTool(input).execute('find', { pattern: '*.pdf' }, new AbortController().signal);
    expect(result.content[0].text).toContain('quote-R6.pdf');
    expect(result.details.skippedPaths).toEqual([{ path: 'user', code: 'EACCES' }]);
  });
  it('does not hide authority revocation or unexpected errors', async () => {
    vi.mocked(listProjectWorkspaceDirectory).mockRejectedValue(new Error('PROJECT_FILE_READ_ACCESS_REVOKED'));
    await expect(createProjectFindTool(input).execute('find', { pattern: '*' }, new AbortController().signal)).rejects.toThrow('REVOKED');
  });
});

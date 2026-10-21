const delegation = vi.hoisted(() => ({ target: vi.fn(), write: vi.fn() }));
vi.mock('./canonical-write-target.js', () => ({ resolveCanonicalWriteTarget: delegation.target }));
vi.mock('./canonical-text-delegation.js', () => ({ delegateCanonicalTextWrite: delegation.write }));
import { compareAndSwapProjectWorkspaceText } from './project-workspace-files.js';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getUserAuthState } from '../auth/auth.js';
import { isProjectMember } from '../pm/project-membership-manager.js';
import { getProject } from '../pm/project-manager.js';
import { mirrorWorkerProjectMutation } from '../runtime-box/workbench-project-derived-mirror.js';
import {
  copyWorkerProjectEntry,
  createWorkerProjectDirectory,
  deleteWorkerProjectEntry,
  downloadWorkerProjectFile,
  statWorkerProjectFile,
  readWorkerProjectFileProbe,
  listWorkerProjectDirectory,
  renameWorkerProjectEntry,
  resolveWorkerFileAuthorityForHostPath,
  uploadWorkerProjectFile,
  workerProjectFileExists,
  writeWorkerProjectFile,
} from '../runtime-box/workbench-project-file-authority.js';
import {
  resolveCurrentProjectWorkspaceWrite,
  commitProjectWorkspaceFile,
  createProjectFileRepresentationSource,
  copyProjectWorkspaceEntry,
  createProjectWorkspaceDirectory,
  deleteProjectWorkspaceEntry,
  listProjectWorkspaceDirectory,
  materializeProjectWorkspaceFile,
  projectWorkspaceEntryExists,
  readProjectWorkspaceFileBytes,
  readProjectWorkspaceFileForPresentation,
  renameProjectWorkspaceEntry,
  resolveProjectWorkspaceFile,
  writeProjectWorkspaceText,
} from './project-workspace-files.js';

vi.mock('../auth/auth.js', () => ({ getUserAuthState: vi.fn(async () => ({ disabled: false, approvalStatus: 'active', role: 'member' })) }));
vi.mock('../pm/project-membership-manager.js', () => ({ isProjectMember: vi.fn(async () => true) }));
vi.mock('../pm/project-manager.js', () => ({ getProject: vi.fn() }));
vi.mock('../runtime-box/workbench-project-derived-mirror.js', () => ({ mirrorWorkerProjectMutation: vi.fn() }));
vi.mock('../runtime-box/workbench-project-file-authority.js', () => ({
  copyWorkerProjectEntry: vi.fn(),
  createWorkerProjectDirectory: vi.fn(),
  deleteWorkerProjectEntry: vi.fn(),
  downloadWorkerProjectFile: vi.fn(),
  statWorkerProjectFile: vi.fn(),
  readWorkerProjectFileProbe: vi.fn(),
  listWorkerProjectDirectory: vi.fn(),
  renameWorkerProjectEntry: vi.fn(),
  resolveWorkerFileAuthorityForHostPath: vi.fn(),
  uploadWorkerProjectFile: vi.fn(),
  workerProjectFileExists: vi.fn(),
  writeWorkerProjectFile: vi.fn(),
}));

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true }))));
beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(getUserAuthState).mockResolvedValue({ disabled: false, approvalStatus: 'active', role: 'member' } as any);
  vi.mocked(isProjectMember).mockResolvedValue(true);
});

async function root() {
  const value = await fs.mkdtemp(path.join(os.tmpdir(), 'tower-workspace-files-'));
  roots.push(value);
  vi.mocked(getProject).mockResolvedValue({ id: 'p', rootPath: value } as any);
  return value;
}

describe('Project workspace file façade', () => {
  it('rechecks current membership before canonical host reads and writes', async () => {
    const projectRoot = await root();
    const file = path.join(projectRoot, 'revoked.txt');
    await fs.writeFile(file, 'original');
    vi.mocked(isProjectMember).mockResolvedValue(false);
    const reference = await resolveProjectWorkspaceFile({ projectId: 'p', projectRoot, relativePath: 'revoked.txt' });
    expect(resolveWorkerFileAuthorityForHostPath).toHaveBeenCalledWith(path.join(projectRoot, 'revoked.txt'), { projectId: 'p', projectRoot });

    await expect(readProjectWorkspaceFileBytes({ reference, actorUserId: 7, maxBytes: 100 }))
      .rejects.toThrow('PROJECT_FILE_SOURCE_ACCESS_REVOKED');
    await expect(writeProjectWorkspaceText({ reference, actorUserId: 7, content: 'changed' }))
      .rejects.toThrow('PROJECT_FILE_SOURCE_ACCESS_REVOKED');
    expect(await fs.readFile(file, 'utf8')).toBe('original');
  });

  it('probes only a prefix of large Worker files and uses metadata-only stat', async () => {
    const projectRoot = await root();
    const file = path.join(projectRoot, 'large.pdf');
    vi.mocked(resolveWorkerFileAuthorityForHostPath).mockResolvedValue({ projectId: 'p', projectRoot, relativePath: 'large.pdf', workerId: 'w', workerBaseUrl: 'http://worker' });
    vi.mocked(statWorkerProjectFile).mockResolvedValue({ sizeBytes: 3 * 1024 * 1024, version: 'v1' });
    vi.mocked(readWorkerProjectFileProbe).mockResolvedValue(Buffer.from('%PDF-1.4'));
    const source = await createProjectFileRepresentationSource({ projectId: 'p', projectRoot, actorUserId: 7 });
    expect((await source.stat(file)).size).toBe(3 * 1024 * 1024);
    expect(await source.readProbe(file, 65536)).toEqual(Buffer.from('%PDF-1.4'));
    expect(readWorkerProjectFileProbe).toHaveBeenCalledWith(expect.objectContaining({ maxBytes: 65536 }));
    expect(downloadWorkerProjectFile).not.toHaveBeenCalled();
  });

  it('reads a bounded host prefix rather than rejecting large file size', async () => {
    const projectRoot = await root();
    const file = path.join(projectRoot, 'large.pdf');
    const bytes = Buffer.alloc(100000, 65); await fs.writeFile(file, bytes);
    const source = await createProjectFileRepresentationSource({ projectId: 'p', projectRoot, actorUserId: 7 });
    expect(await source.readProbe(file, 65536)).toEqual(bytes.subarray(0,65536));
  });

  it('permits internal read aliases but rejects hardlinks for prefix reads', async () => {
    const projectRoot = await root();
    await fs.writeFile(path.join(projectRoot, 'original.pdf'), '%PDF');
    await fs.symlink(path.join(projectRoot, 'original.pdf'), path.join(projectRoot, 'link.pdf'));
    const source = await createProjectFileRepresentationSource({ projectId: 'p', projectRoot, actorUserId: 7 });
    await expect(source.readProbe(path.join(projectRoot, 'link.pdf'), 64)).resolves.toEqual(await fs.readFile(path.join(projectRoot, 'original.pdf')));
    await fs.link(path.join(projectRoot, 'original.pdf'), path.join(projectRoot, 'hard.pdf'));
    await expect(source.readProbe(path.join(projectRoot, 'hard.pdf'), 64)).rejects.toThrow('WORKSPACE_READ_SPECIAL_FILE');
  });

  it('rejects upload commit after membership revocation before creating a file', async () => {
    const projectRoot = await root();
    vi.mocked(getProject).mockResolvedValue({ id: 'p', rootPath: projectRoot } as any);
    vi.mocked(isProjectMember).mockResolvedValue(false);
    await expect(commitProjectWorkspaceFile({ projectId: 'p', relativeDirectory: 'uploads',
      requestedName: 'blocked.txt', sourcePath: '/unused', sizeBytes: 1, actorUserId: 7 }))
      .rejects.toThrow('PROJECT_FILE_SOURCE_ACCESS_REVOKED');
    expect(await fs.readdir(projectRoot)).toEqual([]);
  });

  it('presentation reads use the same live access gate as ordinary reads', async () => {
    const projectRoot = await root();
    await fs.writeFile(path.join(projectRoot, 'report.md'), 'private');
    const reference = await resolveProjectWorkspaceFile({ projectId: 'p', projectRoot, relativePath: 'report.md' });
    vi.mocked(isProjectMember).mockResolvedValue(false);
    await expect(readProjectWorkspaceFileForPresentation({ reference, actorUserId: 7 }))
      .rejects.toThrow('PROJECT_FILE_SOURCE_ACCESS_REVOKED');
  });

  it('rechecks current path access on every Project representation source operation', async () => {
    const projectRoot = await root();
    const target = path.join(projectRoot, 'report.pdf');
    await fs.writeFile(target, '%PDF-1.4');
    vi.mocked(resolveWorkerFileAuthorityForHostPath).mockResolvedValue(undefined);
    const source = await createProjectFileRepresentationSource({ projectId: 'p', projectRoot, actorUserId: 7, actorRole: 'member' });
    await source.stat(target);
    await source.readProbe(target, 16);
    await source.readFile(target, 16);
    expect(getUserAuthState).toHaveBeenCalledTimes(3);
    expect(isProjectMember).toHaveBeenCalledTimes(3);
    vi.mocked(isProjectMember).mockResolvedValueOnce(false);
    await expect(source.readFile(target, 16)).rejects.toThrow('PROJECT_FILE_SOURCE_ACCESS_REVOKED');
  });

  it('uses canonical host bytes without consulting Worker health beyond authority resolution', async () => {
    const projectRoot = await root();
    vi.mocked(resolveWorkerFileAuthorityForHostPath).mockResolvedValue(undefined);
    const source = path.join(projectRoot, 'source.txt');
    await fs.writeFile(source, 'canonical');

    const committed = await commitProjectWorkspaceFile({
      projectId: 'p', relativeDirectory: 'uploads', requestedName: 'a.txt', sourcePath: source, sizeBytes: 9, actorUserId: 7,
    });

    expect(await fs.readFile(path.join(projectRoot, committed.relativePath), 'utf8')).toBe('canonical');
    expect(getProject).toHaveBeenCalled();
    expect(workerProjectFileExists).not.toHaveBeenCalled();
    expect(uploadWorkerProjectFile).not.toHaveBeenCalled();
  });

  it('preserves an upload name collision and compensates only the newly imported file', async () => {
    const projectRoot = await root();
    vi.mocked(getProject).mockResolvedValue({ id: 'p', rootPath: projectRoot } as any);
    await fs.mkdir(path.join(projectRoot, 'uploads'));
    await fs.writeFile(path.join(projectRoot, 'uploads/report.txt'), 'existing');
    const source = path.join(projectRoot, 'source.txt');
    await fs.writeFile(source, 'new');
    const committed = await commitProjectWorkspaceFile({ projectId: 'p', relativeDirectory: 'uploads',
      requestedName: 'report.txt', sourcePath: source, sizeBytes: 3, actorUserId: 7 });
    expect(committed.name).toBe('report (1).txt');
    expect(await fs.readFile(path.join(projectRoot, 'uploads/report.txt'), 'utf8')).toBe('existing');
    await committed.compensate();
    await expect(fs.stat(path.join(projectRoot, committed.relativePath))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await fs.readFile(path.join(projectRoot, 'uploads/report.txt'), 'utf8')).toBe('existing');
  });

  it('routes legacy workspace writes only through Worker authority and compensates through Worker delete', async () => {
    await root();
    const resolvedProjectRoot = (await getProject('p'))!.rootPath;
    const authority = { projectId: 'p', projectRoot: resolvedProjectRoot, relativePath: 'uploads/a.txt', workerId: 'w', workerBaseUrl: 'http://worker' } as any;
    vi.mocked(resolveWorkerFileAuthorityForHostPath).mockResolvedValue(authority);
    vi.mocked(workerProjectFileExists).mockResolvedValue(false);
    const source = path.join(os.tmpdir(), 'tower-worker-source.txt');
    await fs.writeFile(source, 'worker');
    try {
      const committed = await commitProjectWorkspaceFile({ projectId: 'p', relativeDirectory: 'uploads', requestedName: 'a.txt', sourcePath: source, sizeBytes: 6, actorUserId: 7 });
      expect(uploadWorkerProjectFile).toHaveBeenCalledWith(expect.objectContaining({ authority, actorUserId: 7, sourcePath: source }));
      await committed.compensate();
      expect(deleteWorkerProjectEntry).toHaveBeenCalledWith({ authority, actorUserId: 7 });
    } finally { await fs.rm(source, { force: true }); }
  });

  it('lists canonical directories and checks canonical existence', async () => {
    const projectRoot = await root();
    vi.mocked(resolveWorkerFileAuthorityForHostPath).mockResolvedValue(undefined);
    await fs.mkdir(path.join(projectRoot, 'final'));
    await fs.writeFile(path.join(projectRoot, 'final', 'report.md'), 'report');
    const directory = await resolveProjectWorkspaceFile({ projectId: 'p', relativePath: 'final' });
    const listed = await listProjectWorkspaceDirectory({ reference: directory, actorUserId: 7 });
    const existing = await projectWorkspaceEntryExists({
      reference: await resolveProjectWorkspaceFile({ projectId: 'p', relativePath: 'final/report.md' }), actorUserId: 7,
    });
    const missing = await projectWorkspaceEntryExists({
      reference: await resolveProjectWorkspaceFile({ projectId: 'p', relativePath: 'final/missing.md' }), actorUserId: 7,
    });
    expect(listed.storageAuthority).toBe('host');
    expect(listed.entries).toEqual([expect.objectContaining({ name: 'report.md', path: path.join(projectRoot, 'final', 'report.md') })]);
    expect(existing).toEqual({ storageAuthority: 'host', exists: true });
    expect(missing).toEqual({ storageAuthority: 'host', exists: false });
  });

  it('lists and checks legacy Worker entries without consulting a host mirror', async () => {
    const projectRoot = await root();
    vi.mocked(resolveWorkerFileAuthorityForHostPath).mockImplementation(async hostPath => ({
      projectId: 'p', projectRoot, relativePath: path.relative(projectRoot, hostPath).split(path.sep).join('/') || '.', workerId: 'w', workerBaseUrl: 'http://worker',
    } as any));
    vi.mocked(listWorkerProjectDirectory).mockResolvedValue([
      { name: 'report.md', path: path.join(projectRoot, 'final', 'report.md'), isDirectory: false, size: 6, extension: 'md' },
    ] as any);
    const directory = await resolveProjectWorkspaceFile({ projectId: 'p', relativePath: 'final' });
    expect(await listProjectWorkspaceDirectory({ reference: directory, actorUserId: 7 })).toMatchObject({ storageAuthority: 'worker', entries: [expect.objectContaining({ name: 'report.md' })] });
    const entry = await resolveProjectWorkspaceFile({ projectId: 'p', relativePath: 'final/report.md' });
    expect(await projectWorkspaceEntryExists({ reference: entry, actorUserId: 7 })).toEqual({ storageAuthority: 'worker', exists: true });
    expect(listWorkerProjectDirectory).toHaveBeenLastCalledWith(expect.objectContaining({ actorUserId: 7, showHidden: true }));
  });

  it('propagates legacy Worker listing failures instead of falling back to host bytes', async () => {
    const projectRoot = await root();
    const authority = { projectId: 'p', projectRoot, relativePath: 'final', workerId: 'w', workerBaseUrl: 'http://worker' } as any;
    vi.mocked(resolveWorkerFileAuthorityForHostPath).mockResolvedValue(authority);
    vi.mocked(listWorkerProjectDirectory).mockRejectedValue(new Error('WORKER_FILE_AUTHORITY_UNAVAILABLE'));
    const reference = await resolveProjectWorkspaceFile({ projectId: 'p', relativePath: 'final' });
    await expect(listProjectWorkspaceDirectory({ reference, actorUserId: 7 })).rejects.toThrow('WORKER_FILE_AUTHORITY_UNAVAILABLE');
  });

  it('reads canonical presentation files beyond the Agent workspace 8MB limit', async () => {
    const projectRoot = await root();
    vi.mocked(resolveWorkerFileAuthorityForHostPath).mockResolvedValue(undefined);
    const bytes = Buffer.alloc(9 * 1024 * 1024, 1);
    await fs.writeFile(path.join(projectRoot, 'large.pdf'), bytes);
    const result = await readProjectWorkspaceFileForPresentation({
      reference: await resolveProjectWorkspaceFile({ projectId: 'p', relativePath: 'large.pdf' }), actorUserId: 7,
    });
    expect(Buffer.from(result.content, 'base64')).toHaveLength(bytes.length);
  });

  it('writes, exclusively creates, creates directories, and deletes canonical entries', async () => {
    const projectRoot = await root();
    vi.mocked(resolveWorkerFileAuthorityForHostPath).mockResolvedValue(undefined);
    const file = await resolveProjectWorkspaceFile({ projectId: 'p', relativePath: 'draft/note.md' });
    expect(await writeProjectWorkspaceText({ reference: file, actorUserId: 7, content: 'one', exclusive: true })).toBe('host');
    await expect(writeProjectWorkspaceText({ reference: file, actorUserId: 7, content: 'two', exclusive: true })).rejects.toMatchObject({ code: 'EEXIST' });
    expect(await fs.readFile(file.hostPath, 'utf8')).toBe('one');
    const directory = await resolveProjectWorkspaceFile({ projectId: 'p', relativePath: 'final/assets' });
    expect(await createProjectWorkspaceDirectory({ reference: directory, actorUserId: 7, exclusive: true })).toBe('host');
    expect(await deleteProjectWorkspaceEntry({ reference: file, actorUserId: 7 })).toBe('host');
    await expect(fs.stat(file.hostPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects canonical writes through hardlinked targets without truncating either link', async () => {
    const projectRoot = await root();
    vi.mocked(resolveWorkerFileAuthorityForHostPath).mockResolvedValue(undefined);
    await fs.mkdir(path.join(projectRoot, 'draft'));
    const original = path.join(projectRoot, 'draft', 'original.md');
    const linked = path.join(projectRoot, 'draft', 'linked.md');
    await fs.writeFile(original, 'protected');
    await fs.link(original, linked);
    const reference = await resolveProjectWorkspaceFile({ projectId: 'p', relativePath: 'draft/linked.md' });
    await expect(writeProjectWorkspaceText({ reference, actorUserId: 7, content: 'changed' })).rejects.toThrow('WORKSPACE_WRITE_UNSAFE_TARGET');
    expect(await fs.readFile(original, 'utf8')).toBe('protected');
    expect(await fs.readFile(linked, 'utf8')).toBe('protected');
  });

  it('routes single-target legacy mutations only through Worker authority', async () => {
    const projectRoot = await root();
    const authority = { projectId: 'p', projectRoot, relativePath: 'draft/note.md', workerId: 'w', workerBaseUrl: 'http://worker' } as any;
    vi.mocked(resolveWorkerFileAuthorityForHostPath).mockResolvedValue(authority);
    const reference = await resolveProjectWorkspaceFile({ projectId: 'p', relativePath: 'draft/note.md' });
    expect(await writeProjectWorkspaceText({ reference, actorUserId: 7, content: 'worker', exclusive: true })).toBe('worker');
    expect(writeWorkerProjectFile).toHaveBeenCalledWith({ authority, actorUserId: 7, content: 'worker', exclusive: true });
    expect(mirrorWorkerProjectMutation).toHaveBeenCalledWith(authority, { kind: 'write-text', hostPath: reference.hostPath, content: 'worker' });
    expect(await createProjectWorkspaceDirectory({ reference, actorUserId: 7, exclusive: true })).toBe('worker');
    expect(createWorkerProjectDirectory).toHaveBeenCalledWith({ authority, actorUserId: 7, exclusive: true });
    expect(await deleteProjectWorkspaceEntry({ reference, actorUserId: 7 })).toBe('worker');
    expect(deleteWorkerProjectEntry).toHaveBeenCalledWith({ authority, actorUserId: 7 });
  });

  it('propagates legacy mutation failure without touching a host mirror', async () => {
    const projectRoot = await root();
    const authority = { projectId: 'p', projectRoot, relativePath: 'draft/note.md', workerId: 'w', workerBaseUrl: 'http://worker' } as any;
    vi.mocked(resolveWorkerFileAuthorityForHostPath).mockResolvedValue(authority);
    vi.mocked(writeWorkerProjectFile).mockRejectedValue(new Error('WORKER_FILE_AUTHORITY_UNAVAILABLE'));
    const reference = await resolveProjectWorkspaceFile({ projectId: 'p', relativePath: 'draft/note.md' });
    await expect(writeProjectWorkspaceText({ reference, actorUserId: 7, content: 'worker' })).rejects.toThrow('WORKER_FILE_AUTHORITY_UNAVAILABLE');
    await expect(fs.stat(reference.hostPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('renames and collision-copies canonical entries within one Project', async () => {
    const projectRoot = await root();
    vi.mocked(resolveWorkerFileAuthorityForHostPath).mockResolvedValue(undefined);
    await fs.mkdir(path.join(projectRoot, 'source'));
    await fs.mkdir(path.join(projectRoot, 'target'));
    await fs.writeFile(path.join(projectRoot, 'source', 'a.txt'), 'a');
    const source = await resolveProjectWorkspaceFile({ projectId: 'p', relativePath: 'source/a.txt' });
    const renamed = await resolveProjectWorkspaceFile({ projectId: 'p', relativePath: 'source/b.txt' });
    expect(await renameProjectWorkspaceEntry({ source, target: renamed, actorUserId: 7 })).toBe('host');
    const targetDirectory = await resolveProjectWorkspaceFile({ projectId: 'p', relativePath: 'target' });
    const first = await copyProjectWorkspaceEntry({ source: renamed, targetDirectory, actorUserId: 7 });
    const second = await copyProjectWorkspaceEntry({ source: renamed, targetDirectory, actorUserId: 7 });
    expect(first.targetPath).toBe(path.join(projectRoot, 'target', 'b.txt'));
    expect(second.targetPath).toBe(path.join(projectRoot, 'target', 'b copy.txt'));
  });

  it('rejects canonical directory copies containing symlinks', async () => {
    const projectRoot = await root();
    vi.mocked(resolveWorkerFileAuthorityForHostPath).mockResolvedValue(undefined);
    await fs.mkdir(path.join(projectRoot, 'source'));
    await fs.mkdir(path.join(projectRoot, 'target'));
    await fs.writeFile(path.join(projectRoot, 'outside.txt'), 'outside');
    await fs.symlink(path.join(projectRoot, 'outside.txt'), path.join(projectRoot, 'source', 'link.txt'));
    const source = await resolveProjectWorkspaceFile({ projectId: 'p', relativePath: 'source' });
    const targetDirectory = await resolveProjectWorkspaceFile({ projectId: 'p', relativePath: 'target' });
    await expect(copyProjectWorkspaceEntry({ source, targetDirectory, actorUserId: 7 })).rejects.toThrow('WORKSPACE_COPY_UNSAFE_SOURCE');
  });

  it('routes legacy rename and copy through one Worker authority and updates the derived mirror', async () => {
    const projectRoot = await root();
    vi.mocked(resolveWorkerFileAuthorityForHostPath).mockImplementation(async hostPath => ({
      projectId: 'p', projectRoot, relativePath: path.relative(projectRoot, hostPath).split(path.sep).join('/'), workerId: 'w', workerBaseUrl: 'http://worker',
    } as any));
    vi.mocked(copyWorkerProjectEntry).mockResolvedValue({ targetPath: path.join(projectRoot, 'target', 'a.txt') });
    const source = await resolveProjectWorkspaceFile({ projectId: 'p', relativePath: 'source/a.txt' });
    const renamed = await resolveProjectWorkspaceFile({ projectId: 'p', relativePath: 'source/b.txt' });
    expect(await renameProjectWorkspaceEntry({ source, target: renamed, actorUserId: 7 })).toBe('worker');
    expect(renameWorkerProjectEntry).toHaveBeenCalledWith({ authority: source.workerAuthority, actorUserId: 7, newHostPath: renamed.hostPath });
    const targetDirectory = await resolveProjectWorkspaceFile({ projectId: 'p', relativePath: 'target' });
    expect(await copyProjectWorkspaceEntry({ source: renamed, targetDirectory, actorUserId: 7 })).toMatchObject({ storageAuthority: 'worker' });
    expect(copyWorkerProjectEntry).toHaveBeenCalledWith({ authority: renamed.workerAuthority, actorUserId: 7, targetDirHostPath: targetDirectory.hostPath });
    expect(mirrorWorkerProjectMutation).toHaveBeenCalledWith(renamed.workerAuthority, expect.objectContaining({ kind: 'copy' }));
  });

  it('rejects rename and copy across Projects or storage authorities', async () => {
    const projectRoot = await root();
    vi.mocked(resolveWorkerFileAuthorityForHostPath).mockResolvedValue(undefined);
    const source = await resolveProjectWorkspaceFile({ projectId: 'p', relativePath: 'source/a.txt' });
    const other = { ...source, projectId: 'other', projectRoot: path.join(projectRoot, 'other'), hostPath: path.join(projectRoot, 'other', 'a.txt') };
    await expect(renameProjectWorkspaceEntry({ source, target: other, actorUserId: 7 })).rejects.toThrow('Cannot rename across storage authorities');
    await expect(copyProjectWorkspaceEntry({ source, targetDirectory: other, actorUserId: 7 })).rejects.toThrow('Cannot copy across storage authorities');
  });

  it('presents canonical text and binary files with the Viewer contract', async () => {
    const projectRoot = await root();
    vi.mocked(resolveWorkerFileAuthorityForHostPath).mockResolvedValue(undefined);
    await fs.writeFile(path.join(projectRoot, 'note.md'), '# hello');
    await fs.writeFile(path.join(projectRoot, 'image.png'), Buffer.from([0, 1, 2]));
    const text = await readProjectWorkspaceFileForPresentation({
      reference: await resolveProjectWorkspaceFile({ projectId: 'p', relativePath: 'note.md' }), actorUserId: 7,
    });
    const binary = await readProjectWorkspaceFileForPresentation({
      reference: await resolveProjectWorkspaceFile({ projectId: 'p', relativePath: 'image.png' }), actorUserId: 7,
    });
    expect(text).toMatchObject({ storageAuthority: 'host', content: '# hello', language: 'markdown' });
    expect(binary).toMatchObject({ storageAuthority: 'host', content: Buffer.from([0, 1, 2]).toString('base64'), language: 'image', encoding: 'base64' });
  });

  it('presents legacy Worker bytes without reading a host mirror', async () => {
    const projectRoot = await root();
    const authority = { projectId: 'p', projectRoot, relativePath: 'final/a.pdf', workerId: 'w', workerBaseUrl: 'http://worker' } as any;
    vi.mocked(resolveWorkerFileAuthorityForHostPath).mockResolvedValue(authority);
    vi.mocked(downloadWorkerProjectFile).mockResolvedValue(Buffer.from('worker-pdf'));
    const result = await readProjectWorkspaceFileForPresentation({
      reference: await resolveProjectWorkspaceFile({ projectId: 'p', relativePath: 'final/a.pdf' }), actorUserId: 7,
    });
    expect(result).toMatchObject({ storageAuthority: 'worker', content: Buffer.from('worker-pdf').toString('base64'), language: 'pdf', encoding: 'base64' });
    expect(downloadWorkerProjectFile).toHaveBeenCalledOnce();
  });

  it('enforces expected storage inside the façade', async () => {
    const projectRoot = await root();
    vi.mocked(resolveWorkerFileAuthorityForHostPath).mockResolvedValue(undefined);
    await fs.writeFile(path.join(projectRoot, 'a.txt'), 'host');
    const reference = await resolveProjectWorkspaceFile({ projectId: 'p', relativePath: 'a.txt' });
    await expect(readProjectWorkspaceFileBytes({
      reference, actorUserId: 7, maxBytes: 100, expectedStorage: { kind: 'worker', workerId: 'w' },
    })).rejects.toThrow('WORKSPACE_STORAGE_CHANGED');
  });

  it('rejects mismatched legacy Worker authority metadata', async () => {
    const projectRoot = await root();
    vi.mocked(resolveWorkerFileAuthorityForHostPath).mockResolvedValue({
      projectId: 'other', projectRoot, relativePath: 'final/a.bin', workerId: 'w', workerBaseUrl: 'http://worker',
    } as any);
    await expect(resolveProjectWorkspaceFile({ projectId: 'p', relativePath: 'final/a.bin' }))
      .rejects.toThrow('PROJECT_WORKSPACE_STORAGE_CHANGED');
  });

  it('materializes legacy Worker bytes as a cleanup-bound local snapshot', async () => {
    const projectRoot = await root();
    const authority = { projectId: 'p', projectRoot, relativePath: 'final/a.bin', workerId: 'w', workerBaseUrl: 'http://worker' } as any;
    vi.mocked(resolveWorkerFileAuthorityForHostPath).mockResolvedValue(authority);
    vi.mocked(downloadWorkerProjectFile).mockResolvedValue(Buffer.from('legacy'));
    const reference = await resolveProjectWorkspaceFile({ projectId: 'p', relativePath: 'final/a.bin' });
    const snapshot = await materializeProjectWorkspaceFile({ reference, actorUserId: 7, stagingDirectory: path.join(projectRoot, '.staging') });
    expect(await fs.readFile(snapshot.path, 'utf8')).toBe('legacy');
    expect(snapshot).toMatchObject({ sizeBytes: 6, version: expect.stringMatching(/^sha256:/) });
    await snapshot.cleanup();
    await expect(fs.stat(snapshot.path)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});


describe('last-mile read-only actor guard', () => {
  it.each(['viewer', 'guest'])('allows %s reading but rejects mutation before adapter I/O', async role => {
    const value = await root();
    await fs.writeFile(path.join(value, 'doc.md'), 'original');
    const reference = await resolveProjectWorkspaceFile({ relativePath: 'doc.md', projectId: 'p', projectRoot: value });
    vi.mocked(getUserAuthState).mockResolvedValue({ disabled: false, approvalStatus: 'active', role } as any);
    expect((await readProjectWorkspaceFileBytes({ reference, actorUserId: 7, maxBytes: 1024 })).bytes.toString()).toBe('original');
    await expect(compareAndSwapProjectWorkspaceText({ reference, actorUserId: 7, expectedContent: 'original', content: 'changed' })).rejects.toThrow('WRITE_ACCESS_DENIED');
    expect(await fs.readFile(path.join(value, 'doc.md'), 'utf8')).toBe('original');
  });
});

// Admission-only authorization gap: this fixture is NOT a real Worker/DB E2E.
// The production adapter interface currently has no publication-time actor callback.
it.fails('does not publish an in-flight import after requester membership is revoked', async () => {
  const value = await root();
  const source = path.join(value, 'source.md'); await fs.writeFile(source, 'payload');
  vi.mocked(resolveWorkerFileAuthorityForHostPath).mockImplementation(async hostPath => ({
    projectId: 'p', projectRoot: value, relativePath: path.relative(value, hostPath), workerId: 'synthetic', workerBaseUrl: 'http://worker.invalid',
  }));
  vi.mocked(workerProjectFileExists).mockResolvedValue(false);
  let release!: () => void; let reached!: () => void;
  const ready = new Promise<void>(resolve => { reached = resolve; });
  const resume = new Promise<void>(resolve => { release = resolve; });
  let published = false;
  vi.mocked(uploadWorkerProjectFile).mockImplementation(async () => { reached(); await resume; published = true; return undefined as any; });
  const pending = commitProjectWorkspaceFile({ projectId: 'p', projectRoot: value, actorUserId: 7, relativeDirectory: 'docs', requestedName: 'result.md', sourcePath: source, sizeBytes: 7 });
  await ready;
  vi.mocked(isProjectMember).mockResolvedValue(false);
  release(); await pending;
  expect(published).toBe(false);
});


it('rejects canonical publication when membership is revoked while copying, and cleans staging', async () => {
  const value = await root(); const source = path.join(value, 'source.md');
  await fs.writeFile(source, 'payload');
  const link = fs.link.bind(fs);
  let published = false;
  vi.spyOn(fs, 'link').mockImplementation(async (...args: Parameters<typeof fs.link>) => { published = true; return link(...args); });
  // The bounded upload consumes a real source stream; force revocation before
  // admission refresh by changing membership on its second check.
  vi.mocked(isProjectMember).mockResolvedValueOnce(true).mockResolvedValue(false);
  await expect(commitProjectWorkspaceFile({ projectId: 'p', relativeDirectory: 'docs', requestedName: 'result.md', sourcePath: source, sizeBytes: 7, actorUserId: 7 })).rejects.toThrow('ACCESS_REVOKED');
  expect(published).toBe(false);
  expect(await fs.readdir(path.join(value, 'docs'))).toEqual([]);
  expect(await fs.readFile(source, 'utf8')).toBe('payload');
});

it('denies writes for read-only membership even when the requester originally created the Project', async () => {
 const projectRoot = await root();
 vi.mocked(resolveWorkerFileAuthorityForHostPath).mockResolvedValue(undefined);
 vi.mocked(getProject).mockResolvedValue({ id: 'p', rootPath: projectRoot, userId: 7 } as any);
 vi.mocked(isProjectMember).mockImplementation(async (_p, _u, mode) => mode !== 'write');
 const reference = await resolveProjectWorkspaceFile({ projectId: 'p', relativePath: 'protected.txt' });
 await fs.writeFile(reference.hostPath, 'original');
 await expect(writeProjectWorkspaceText({ reference, actorUserId: 7, content: 'changed' })).rejects.toThrow('ACCESS');
 expect(await fs.readFile(reference.hostPath, 'utf8')).toBe('original');
 expect((await readProjectWorkspaceFileBytes({ reference, actorUserId: 7, maxBytes: 1024 })).bytes.toString()).toBe('original');
});

it('refuses a saved text reference after the registered Project root changes', async () => {
 const oldRoot = await root(); const newRoot = await root();
 vi.mocked(resolveWorkerFileAuthorityForHostPath).mockResolvedValue(undefined);
 vi.mocked(getProject).mockResolvedValue({ id: 'p', rootPath: oldRoot } as any);
 const reference = await resolveProjectWorkspaceFile({ projectId: 'p', relativePath: 'a.txt' });
 await fs.writeFile(reference.hostPath, 'original');
 vi.mocked(getProject).mockResolvedValue({ id: 'p', rootPath: newRoot } as any);
 await expect(writeProjectWorkspaceText({ reference, actorUserId: 7, content: 'new' })).rejects.toThrow('STORAGE_CHANGED');
 expect(await fs.readFile(reference.hostPath, 'utf8')).toBe('original');
 await expect(fs.stat(path.join(newRoot, 'a.txt'))).rejects.toThrow();
});
it('refuses saved host write references after storage becomes blocked', async () => {
 const projectRoot = await root();
 vi.mocked(getProject).mockResolvedValue({ id: 'p', rootPath: projectRoot } as any);
 vi.mocked(resolveWorkerFileAuthorityForHostPath).mockResolvedValue(undefined);
 const reference = await resolveProjectWorkspaceFile({ projectId: 'p', relativePath: 'a.txt' });
 await fs.writeFile(reference.hostPath, 'original');
 vi.mocked(resolveWorkerFileAuthorityForHostPath).mockRejectedValue(new Error('PROJECT_STORAGE_NOT_READY'));
 await expect(writeProjectWorkspaceText({ reference, actorUserId: 7, content: 'new' })).rejects.toThrow('STORAGE_NOT_READY');
 expect(await fs.readFile(reference.hostPath, 'utf8')).toBe('original');
});

it('resolves current write authority without performing file I/O or trusting a forged hostPath', async () => {
 const projectRoot = await root();
 vi.mocked(resolveWorkerFileAuthorityForHostPath).mockResolvedValue(undefined);
 const reference = await resolveProjectWorkspaceFile({ projectId: 'p', relativePath: 'a.txt' });
 expect(await resolveCurrentProjectWorkspaceWrite({ reference, actorUserId: 7 })).toEqual(reference);
 await expect(fs.stat(reference.hostPath)).rejects.toThrow();
 await expect(resolveCurrentProjectWorkspaceWrite({ reference: { ...reference, hostPath: path.join(projectRoot, 'other.txt') }, actorUserId: 7 })).rejects.toThrow('STORAGE_CHANGED');
});
it('does not accept a saved host reference once authority becomes Worker-owned', async () => {
 const projectRoot = await root();
 vi.mocked(resolveWorkerFileAuthorityForHostPath).mockResolvedValue(undefined);
 const reference = await resolveProjectWorkspaceFile({ projectId: 'p', relativePath: 'a.txt' });
 vi.mocked(resolveWorkerFileAuthorityForHostPath).mockResolvedValue({ workerId: 'other', projectId: 'p', projectRoot, relativePath: 'a.txt' } as any);
 await expect(resolveCurrentProjectWorkspaceWrite({ reference, actorUserId: 7 })).rejects.toThrow('STORAGE_CHANGED');
 expect(writeWorkerProjectFile).not.toHaveBeenCalled();
 await expect(fs.stat(reference.hostPath)).rejects.toThrow();
});

it('uses selected canonical delegation and never local fallback after failure', async () => {
 const projectRoot=await root(); vi.mocked(resolveWorkerFileAuthorityForHostPath).mockResolvedValue(undefined);
 const reference=await resolveProjectWorkspaceFile({projectId:'p',relativePath:'a.txt'}); await fs.writeFile(reference.hostPath,'old');
 delegation.target.mockResolvedValue({workerId:'selected'}); delegation.write.mockRejectedValue(new Error('CANONICAL_WRITE_NOT_CONFIRMED'));
 await expect(writeProjectWorkspaceText({reference,actorUserId:7,content:'new'})).rejects.toThrow('NOT_CONFIRMED');
 expect(await fs.readFile(reference.hostPath,'utf8')).toBe('old'); expect(delegation.write).toHaveBeenCalledTimes(1);
});
it('reports host authority after delegated writes without local publication', async () => {
 const projectRoot=await root(); vi.mocked(resolveWorkerFileAuthorityForHostPath).mockResolvedValue(undefined);
 const reference=await resolveProjectWorkspaceFile({projectId:'p',relativePath:'a.txt'});
 delegation.target.mockResolvedValue({workerId:'selected'}); delegation.write.mockResolvedValue({storageKind:'host',bytesWritten:3});
 await expect(writeProjectWorkspaceText({reference,actorUserId:7,content:'new',exclusive:true})).resolves.toBe('host');
 expect(delegation.write.mock.calls[0][0].exclusive).toBe(true); await expect(fs.stat(reference.hostPath)).rejects.toThrow();
});

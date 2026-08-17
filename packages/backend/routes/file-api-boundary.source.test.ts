import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const apiSource = fs.readFileSync(path.resolve(import.meta.dirname, './api.ts'), 'utf8');
const projectFilesSource = fs.readFileSync(path.resolve(import.meta.dirname, './project-files/project-files-router.ts'), 'utf8');

describe('file API boundary hardening source contract', () => {
  it('does not bypass isPathAccessible for privileged roles in file browsing APIs', () => {
    expect(projectFilesSource).not.toContain('!isPrivilegedRole(role) && !(await isPathAccessible');
    expect(projectFilesSource).not.toContain('!isPrivilegedRole(role)\n        && !(await isPathAccessible');
  });

  it('keeps file API routes behind the symlink-aware path access helpers', () => {
    expect(apiSource).toContain("router.use('/', projectFilesRouter)");
    expect(projectFilesSource).toContain("router.get('/files/tree'");
    expect(projectFilesSource).toContain("router.get('/files/read'");
    expect(projectFilesSource).toContain("router.post('/files/write'");
    expect(projectFilesSource).toContain('await isPathAccessible');
    expect(projectFilesSource).toContain('await isPathWritableByRole');
  });

  it('routes read-only file authority through Worker storage only after existing Project ACL checks', () => {
    expect(projectFilesSource).toContain('resolveWorkerFileAuthorityForHostPath');
    expect(projectFilesSource).toContain('readWorkerProjectFile');
    expect(projectFilesSource).toContain('listWorkerProjectDirectory');
    expect(projectFilesSource.indexOf('await isPathAccessible(filePath, userId, role)')).toBeLessThan(projectFilesSource.indexOf('await readWorkerProjectFile'));
    expect(projectFilesSource.indexOf('await isPathAccessible(dirPath, userId, role || \'member\')')).toBeLessThan(projectFilesSource.indexOf('await listWorkerProjectDirectory'));
  });

  it('routes Project mutations to Worker authority without bypassing ACL and rejects cross-authority moves', () => {
    for (const helper of ['writeWorkerProjectFile', 'createWorkerProjectDirectory', 'deleteWorkerProjectEntry', 'renameWorkerProjectEntry', 'copyWorkerProjectEntry']) {
      expect(projectFilesSource).toContain(helper);
    }
    expect(projectFilesSource).toContain('Cannot rename across storage authorities');
    expect(projectFilesSource).toContain('Cannot copy across storage authorities');
    expect(projectFilesSource.indexOf('await isPathWritableByRole(filePath, userId, role || \'member\')')).toBeLessThan(projectFilesSource.indexOf('await writeWorkerProjectFile'));
  });

  it('streams staged multipart uploads to Worker authority after target write policy checks', () => {
    expect(apiSource).toContain('uploadWorkerProjectFile');
    expect(apiSource).toContain("mirrorWorkerProjectMutation(workerAuthority, { kind: 'upload'");
    expect(apiSource).toContain("const storageAuthority = userId && await resolveWorkerFileAuthorityForHostPath(targetDir) ? 'worker' : 'host'");
    expect(apiSource.indexOf('await isPathWritableByRole(targetDir, userId, role || \'member\')')).toBeLessThan(apiSource.indexOf('await uploadWorkerProjectFile'));
  });

  it('updates the host-derived search and knowledge read model only after Worker mutations succeed', () => {
    for (const kind of ['write-text', 'mkdir', 'delete', 'rename', 'copy']) {
      expect(projectFilesSource).toContain(`kind: '${kind}'`);
    }
    expect(projectFilesSource.indexOf('await writeWorkerProjectFile')).toBeLessThan(projectFilesSource.indexOf("mirrorWorkerProjectMutation(workerAuthority, { kind: 'write-text'"));
    expect(projectFilesSource.indexOf('await deleteWorkerProjectEntry')).toBeLessThan(projectFilesSource.indexOf("mirrorWorkerProjectMutation(workerAuthority, { kind: 'delete'"));
  });
});

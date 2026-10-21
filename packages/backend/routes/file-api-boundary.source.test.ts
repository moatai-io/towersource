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
    expect(projectFilesSource).toContain("router.post('/files/scoped-edit/plan'");
    expect(projectFilesSource).toContain("router.post('/files/scoped-edit/propose'");
    expect(projectFilesSource).toContain('discoverStaticHtmlCssEditPlan');
    expect(projectFilesSource).toContain("router.post('/files/scoped-edit/apply'");
    expect(projectFilesSource).toContain("router.get('/files/scoped-edit/multi-file-proposal/:intentId'");
    expect(projectFilesSource).toContain("router.post('/files/scoped-edit/multi-file-apply'");
    expect(projectFilesSource).toContain('reserveMultiFileEditProposal');
    expect(projectFilesSource).toContain('applyMultiFileEditProposal');
    expect(projectFilesSource).toContain('req.body?.confirmed !== true');
    expect(projectFilesSource).toContain('verifyScopedEditProposal');
    expect(projectFilesSource).toContain('applyScopedReplacement');
    expect(projectFilesSource).toContain('lockfile.lock(proposal.path');
    expect(projectFilesSource).toContain('worker_cas_unavailable');
    expect(projectFilesSource).toContain('await isPathAccessible');
    expect(projectFilesSource).toContain('await isPathWritableByRole');
  });

  it('routes Project file reads through workspace authority only after existing Project ACL checks', () => {
    expect(projectFilesSource).toContain('resolveProjectWorkspaceFile');
    expect(projectFilesSource).toContain('readProjectWorkspaceFileForPresentation');
    expect(projectFilesSource).toContain('listProjectWorkspaceDirectory');
    expect(projectFilesSource).toContain('projectWorkspaceEntryExists');
    expect(projectFilesSource.indexOf('await isPathAccessible(filePath, userId, role)')).toBeLessThan(projectFilesSource.indexOf('await readProjectWorkspaceFileForPresentation'));
    expect(projectFilesSource.indexOf('await isPathAccessible(dirPath, userId, role || \'member\')')).toBeLessThan(projectFilesSource.indexOf('await listProjectWorkspaceDirectory'));
    expect(projectFilesSource).toContain("return res.status(503).json({ exists: false, error: error.message })");
  });

  it('routes Project mutations through the workspace façade and rejects cross-authority moves', () => {
    for (const helper of ['writeProjectWorkspaceText', 'createProjectWorkspaceDirectory', 'deleteProjectWorkspaceEntry', 'renameProjectWorkspaceEntry', 'copyProjectWorkspaceEntry']) {
      expect(projectFilesSource).toContain(helper);
    }
    expect(projectFilesSource).toContain('Cannot rename across storage authorities');
    expect(projectFilesSource).toContain('Cannot copy across storage authorities');
    const writeRoute = projectFilesSource.slice(projectFilesSource.indexOf("router.post('/files/write'"));
    expect(writeRoute.indexOf('await isPathWritableByRole(filePath, userId, role || \'member\')')).toBeGreaterThan(-1);
    expect(writeRoute.indexOf('await isPathWritableByRole(filePath, userId, role || \'member\')')).toBeLessThan(writeRoute.indexOf('await writeProjectWorkspaceText'));
  });

  it('streams staged multipart uploads to Worker authority after target write and Project namespace checks', () => {
    expect(apiSource).toContain('uploadWorkerProjectFile');
    expect(apiSource).toContain('await assertProjectSharedMutationForHostPath(filePath)');
    expect(apiSource.indexOf("await isPathWritableByRole(targetDir, userId, role || 'member')")).toBeLessThan(apiSource.indexOf('await assertProjectSharedMutationForHostPath(filePath)'));
    expect(apiSource).toContain("mirrorWorkerProjectMutation(workerAuthority, { kind: 'upload'");
    expect(apiSource).toContain("const storageAuthority = userId && await resolveWorkerFileAuthorityForHostPath(targetDir) ? 'worker' : 'host'");
    expect(apiSource.indexOf('await isPathWritableByRole(targetDir, userId, role || \'member\')')).toBeLessThan(apiSource.indexOf('await uploadWorkerProjectFile'));
  });

  it('keeps UI directory creation behind the same Project shared-namespace boundary', () => {
    expect(projectFilesSource).toContain('await assertProjectSharedMutationForHostPath(dirPath)');
    expect(projectFilesSource.indexOf("await isPathWritableByRole(dirPath, userId, role || 'member')")).toBeLessThan(projectFilesSource.indexOf('await assertProjectSharedMutationForHostPath(dirPath)'));
    expect(projectFilesSource.indexOf('await assertProjectSharedMutationForHostPath(dirPath)')).toBeLessThan(projectFilesSource.indexOf('await createProjectWorkspaceDirectory'));
  });

  it('does not directly select Worker authority for routed Project mutation endpoints', () => {
    expect(projectFilesSource).not.toContain('await renameWorkerProjectEntry');
    expect(projectFilesSource).not.toContain('await copyWorkerProjectEntry');
  });
});

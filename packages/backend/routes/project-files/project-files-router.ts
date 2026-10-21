import { parseControlRegistry } from '../../../shared/publishing/control-room-registry.js';
import { parsePricingDeclaration } from '../../../shared/pricing-app.js';
import { addRegisteredDashboard } from '../../services/publishing/control-room-registration.js';
import { searchFileTree } from '../../services/workspace/search-file-tree.js';
/**
 * Owns: authenticated Project file browsing and core mutations.
 * Public API: projectFilesRouter. See README.md.
 */
import { Router, type Response } from 'express';
import fs from 'fs';
import path from 'path';
import lockfile from 'proper-lockfile';
import { config } from '../../config.js';
import { applyMultiFileEditProposal, runInlineEdit, appendInlineEditAudit, ScopedEditError, applyScopedReplacement, createScopedEditProposal, discoverStaticHtmlCssEditPlan, inspectMultiFileEditProposal, reserveMultiFileEditProposal, validateScopedSelection, verifyScopedEditProposal } from '../../services/inline-edit/index.js';
import { getUserAllowedPath } from '../../services/auth/auth.js';
import {
  copyEntry, createDirectory, deleteEntry, expandHome, getFileTreeAsync,
  invalidateTreeCache, isPathSafe, readFile, renameEntry, writeFile,
} from '../../services/workspace/file-system.js';
import { scanNotesIndex, type NotesIndexMode } from '../../services/workspace/notes-index.js';
import { buildWorkspaceKnowledgeGraph } from '../../services/workspace/knowledge-graph.js';
import { hasInternalShareForUser } from '../../services/workspace/share-manager.js';
import { findProjectByPath, isDotfileDenied, isPathAccessible, isPathWritableByRole, isPrivilegedRole } from '../../services/pm/project-access.js';
import { getProject } from '../../services/pm/project-manager.js';
import {
  copyProjectWorkspaceEntry,
  createProjectWorkspaceDirectory,
  deleteProjectWorkspaceEntry,
  compareAndSwapProjectWorkspaceText,
  listProjectWorkspaceDirectory,
  projectWorkspaceEntryExists,
  readProjectWorkspaceFileBytes,
  readProjectWorkspaceFileForPresentation,
  renameProjectWorkspaceEntry,
  resolveProjectWorkspaceFile,
  writeProjectWorkspaceText,
} from '../../services/project-environment/project-workspace-files.js';
import { isPathAllowedByCoarseRootOrAcl } from './project-files-access.js';
import { assertProjectSharedMutationForHostPath } from '../../services/runtime-box/workbench-project-file-authority.js';

const router = Router();
function respondCanonicalWriteError(res: Response, error: unknown): boolean {
  const code = error instanceof Error ? error.message : '';
  if (!code.startsWith('CANONICAL_WRITE_')) return false;
  if (code === 'CANONICAL_WRITE_NOT_CONFIRMED') {
    res.status(409).json({ code, retryable: false, error: '쓰기 결과를 확인하지 못했습니다. 파일 내용을 확인한 후 다시 저장하세요.' });
  } else if (['CANONICAL_WRITE_DENIED','CANONICAL_WRITE_ACCESS_REVOKED','CANONICAL_WRITE_PATH_DENIED'].includes(code)) {
    res.status(403).json({ code, retryable: false, error: '현재 파일 쓰기 권한을 확인할 수 없습니다.' });
  } else {
    res.status(503).json({ code: 'CANONICAL_WRITE_UNAVAILABLE', retryable: false, error: '현재 파일 쓰기를 사용할 수 없습니다. 읽기는 계속 사용할 수 있습니다.' });
  }
  return true;
}

const consumedScopedEditProposalIds = new Map<string, number>();

function reserveScopedEditProposal(proposalId: string): () => void {
  const now = Date.now();
  for (const [id, expiresAt] of consumedScopedEditProposalIds) {
    if (expiresAt <= now) consumedScopedEditProposalIds.delete(id);
  }
  if (consumedScopedEditProposalIds.has(proposalId)) {
    throw new ScopedEditError('scoped_edit_proposal_already_used', 409);
  }
  consumedScopedEditProposalIds.set(proposalId, now + 10 * 60 * 1000);
  return () => consumedScopedEditProposalIds.delete(proposalId);
}

// Registration only: does not publish, execute HTML or grant access.
router.post('/dashboards/register', async (req, res) => {
  const user = (req as any).user;
  if (!user?.userId) return res.status(401).json({ error: 'Authentication required' });
  let entry;
  try {
    if (typeof req.body.projectId !== 'string' || req.body.confirmed !== true) throw Error();
    entry = parseControlRegistry({ version: 1, dashboards: [req.body.entry] })[0];
  } catch { return res.status(400).json({ error: 'Invalid registration' }); }
  try {
    const project = await getProject(req.body.projectId);
    if (!project?.rootPath || project.archived) return res.status(404).json({ error: 'Project unavailable' });
    const registryPath = path.join(project.rootPath, 'dashboards/control-room.json');
    const targetRelative = `dashboards/${entry.slug}/${entry.format === 'html' ? entry.entry : 'dashboard.pricing-app.json'}`;
    const targetPath = path.join(project.rootPath, targetRelative);
    for (const candidate of [registryPath, targetPath]) {
      if (!await isPathAccessible(candidate, user.userId, user.role)) return res.status(403).json({ error: 'Access denied' });
    }
    if (!await isPathWritableByRole(registryPath, user.userId, user.role || 'member')) return res.status(403).json({ error: 'Write denied' });
    const target = await resolveProjectWorkspaceFile({ projectId: project.id, projectRoot: project.rootPath, relativePath: targetRelative });
    const bytes = (await readProjectWorkspaceFileBytes({ reference: target, actorUserId: user.userId, maxBytes: 5 * 1024 * 1024 })).bytes;
    if (!bytes.length) return res.status(400).json({ error: 'Empty dashboard' });
    if (entry.format !== 'html') parsePricingDeclaration(JSON.parse(bytes.toString('utf8')));
    const reference = await resolveProjectWorkspaceFile({ projectId: project.id, projectRoot: project.rootPath, relativePath: 'dashboards/control-room.json' });
    if (!(await projectWorkspaceEntryExists({ reference, actorUserId: user.userId })).exists) {
      try {
        await writeProjectWorkspaceText({ reference, actorUserId: user.userId, content: JSON.stringify({ version: 1, dashboards: [entry] }, null, 2) + '\n', exclusive: true });
        return res.json({ ok: true, changed: true });
      } catch (error) {
        if (!(await projectWorkspaceEntryExists({ reference, actorUserId: user.userId })).exists) throw error;
      }
    }
    const result = await addRegisteredDashboard(reference, user.userId, entry);
    return res.json({ ok: true, ...result });
  } catch (error) {
    if (respondCanonicalWriteError(res, error)) return;
    return res.status(409).json({ error: 'Registration could not be confirmed. Check target file, permissions and concurrent changes.' });
  }
});

// ───── Directories ─────
router.get('/directories', async (req, res) => {
  try {
    const userId = (req as any).user?.userId;
    const role = (req as any).user?.role;
    const userRoot = userId ? await getUserAllowedPath(userId) : config.workspaceRoot;
    const dirPath = (req.query.path as string) || userRoot;
    if (isDotfileDenied(dirPath)) return res.status(403).json({ error: 'Access denied: system path' });
    if (!(await isPathAllowedByCoarseRootOrAcl(dirPath, userRoot, userId, role))) {
      return res.status(403).json({ error: 'Access denied' });
    }
    // 2026-05-02: non-privileged callers may only enumerate directories within
    // their accessible paths (mirrors /files/tree policy).
    if (userId && !(await isPathAccessible(dirPath, userId, role || 'member'))) {
      return res.status(403).json({ error: 'Access denied: outside your project folders' });
    }
    if (!fs.existsSync(dirPath) || !fs.statSync(dirPath).isDirectory()) {
      return res.status(400).json({ error: 'Invalid directory path' });
    }
    const entries = fs.readdirSync(dirPath, { withFileTypes: true })
      .filter((d) => d.isDirectory() && !d.name.startsWith('.'))
      .map((d) => ({
        name: d.name,
        path: dirPath === '/' ? `/${d.name}` : `${dirPath}/${d.name}`,
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
    res.json({ path: dirPath, entries });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

async function assertHostAuthoritativeProjectDirectory(rootPath: string): Promise<void> {
  const projectId = await findProjectByPath(rootPath);
  if (!projectId) return;
  const project = await getProject(projectId);
  if (!project?.rootPath) throw new Error('PROJECT_WORKSPACE_NOT_FOUND');
  const relativePath = path.relative(path.resolve(project.rootPath), path.resolve(rootPath)).split(path.sep).join('/') || '.';
  const reference = await resolveProjectWorkspaceFile({ projectId, projectRoot: project.rootPath, relativePath, allowProjectRoot: true });
  if (reference.workerAuthority) {
    const error = new Error('PROJECT_WORKSPACE_INDEX_REQUIRES_AUTHORITATIVE_SNAPSHOT');
    (error as any).statusCode = 503;
    throw error;
  }
}

// ───── Files ─────
router.get('/files/notes-index', async (req, res) => {
  try {
    const userId = (req as any).user?.userId;
    const role = (req as any).user?.role;
    const userRoot = userId ? await getUserAllowedPath(userId) : config.workspaceRoot;
    const rootPath = expandHome((req.query.path as string) || userRoot);
    const modeRaw = String(req.query.mode || 'current');
    const mode: NotesIndexMode = ['current', 'all', 'archive', 'system'].includes(modeRaw)
      ? (modeRaw as NotesIndexMode)
      : 'current';
    const maxFiles = parseInt(String(req.query.maxFiles || '2500'), 10) || 2500;
    const maxDepth = parseInt(String(req.query.maxDepth || '8'), 10) || 8;

    if (!rootPath) return res.status(400).json({ error: 'path required' });
    if (isDotfileDenied(rootPath)) return res.status(403).json({ error: 'Access denied: system path' });
    if (!(await isPathAllowedByCoarseRootOrAcl(rootPath, userRoot, userId, role))) {
      return res.status(403).json({ error: 'Access denied' });
    }
    if (userId && !(await isPathAccessible(rootPath, userId, role || 'member'))) {
      return res.status(403).json({ error: 'Access denied: outside your project folders' });
    }
    await assertHostAuthoritativeProjectDirectory(rootPath);
    if (!fs.existsSync(rootPath) || !fs.statSync(rootPath).isDirectory()) {
      return res.status(400).json({ error: 'path must be a directory' });
    }

    const result = await scanNotesIndex(rootPath, { mode, maxFiles, maxDepth });
    res.json(result);
  } catch (error: any) {
    console.error('[api] files/notes-index failed:', error);
    res.status(error?.statusCode || 500).json({ error: error.message || 'Failed to build notes index' });
  }
});

router.get('/files/knowledge-graph', async (req, res) => {
  try {
    const userId = (req as any).user?.userId;
    const role = (req as any).user?.role;
    const userRoot = userId ? await getUserAllowedPath(userId) : config.workspaceRoot;
    const rootPath = expandHome((req.query.path as string) || userRoot);
    const maxFiles = parseInt(String(req.query.maxFiles || '1500'), 10) || 1500;
    const maxDepth = parseInt(String(req.query.maxDepth || '8'), 10) || 8;
    const includeUnresolved = req.query.includeUnresolved !== 'false';

    if (!rootPath) return res.status(400).json({ error: 'path required' });
    if (isDotfileDenied(rootPath)) return res.status(403).json({ error: 'Access denied: system path' });
    if (!(await isPathAllowedByCoarseRootOrAcl(rootPath, userRoot, userId, role))) {
      return res.status(403).json({ error: 'Access denied' });
    }
    if (userId && !(await isPathAccessible(rootPath, userId, role || 'member'))) {
      return res.status(403).json({ error: 'Access denied: outside your project folders' });
    }
    await assertHostAuthoritativeProjectDirectory(rootPath);
    if (!fs.existsSync(rootPath) || !fs.statSync(rootPath).isDirectory()) {
      return res.status(400).json({ error: 'path must be a directory' });
    }

    const result = await buildWorkspaceKnowledgeGraph(rootPath, { maxFiles, maxDepth, includeUnresolved });
    res.json(result);
  } catch (error: any) {
    console.error('[api] files/knowledge-graph failed:', error);
    res.status(error?.statusCode || 500).json({ error: error.message || 'Failed to build knowledge graph' });
  }
});

router.get('/files/reveal', async (req, res) => {
  try {
    const userId = (req as any).user?.userId;
    const role = (req as any).user?.role;
    const userRoot = userId ? await getUserAllowedPath(userId) : config.workspaceRoot;
    const targetPath = expandHome(req.query.path as string);
    const requestedRootPath = req.query.rootPath ? expandHome(req.query.rootPath as string) : '';
    const showHidden = req.query.showHidden === 'true' || req.query.showHidden === '1';

    if (!targetPath) return res.status(400).json({ error: 'path required' });
    if (isDotfileDenied(targetPath) || (requestedRootPath && isDotfileDenied(requestedRootPath))) {
      return res.status(403).json({ error: 'Access denied: system path' });
    }
    if (!(await isPathAllowedByCoarseRootOrAcl(targetPath, userRoot, userId, role))) {
      return res.status(403).json({ error: 'Access denied: outside allowed path' });
    }
    if (requestedRootPath && !(await isPathAllowedByCoarseRootOrAcl(requestedRootPath, userRoot, userId, role))) {
      return res.status(403).json({ error: 'Access denied: outside allowed root path' });
    }
    if (userId && !(await isPathAccessible(targetPath, userId, role || 'member'))) {
      return res.status(403).json({ error: 'Access denied: outside your project folders' });
    }
    if (requestedRootPath && userId && !(await isPathAccessible(requestedRootPath, userId, role || 'member'))) {
      return res.status(403).json({ error: 'Access denied: outside your project folders' });
    }
    if (!fs.existsSync(targetPath)) return res.status(404).json({ error: 'path not found' });

    const stat = fs.statSync(targetPath);
    const targetDir = stat.isDirectory() ? targetPath : path.dirname(targetPath);
    const rootPath = requestedRootPath && isPathSafe(targetPath, requestedRootPath) ? requestedRootPath : targetDir;
    if (!fs.existsSync(rootPath) || !fs.statSync(rootPath).isDirectory()) {
      return res.status(400).json({ error: 'rootPath must be a directory' });
    }

    const relativeDir = path.relative(rootPath, targetDir);
    if (relativeDir.startsWith('..') || path.isAbsolute(relativeDir)) {
      return res.status(400).json({ error: 'path is outside rootPath' });
    }

    const dirs = [rootPath];
    let current = rootPath;
    for (const segment of relativeDir.split(path.sep).filter(Boolean)) {
      current = path.join(current, segment);
      if (isDotfileDenied(current)) return res.status(403).json({ error: 'Access denied: system path' });
      dirs.push(current);
    }

    const entriesByPath: Record<string, Awaited<ReturnType<typeof getFileTreeAsync>>> = {};
    await Promise.all(dirs.map(async (dir) => {
      entriesByPath[dir] = await getFileTreeAsync(dir, 2, {
        ...(isPathSafe(dir, userRoot) ? {} : { skipSafetyCheck: true }),
        showHidden,
      });
    }));

    res.json({
      path: targetPath,
      rootPath,
      targetDir,
      ancestors: dirs.slice(1),
      entriesByPath,
    });
  } catch (error: any) {
    res.status(403).json({ error: error.message });
  }
});

router.get('/files/tree', async (req, res) => {
  try {
    const userId = (req as any).user?.userId;
    const role = (req as any).user?.role;
    const userRoot = userId ? await getUserAllowedPath(userId) : config.workspaceRoot;
    // Expand `~/...` for portable AI-emitted paths.
    // Decision: workspace/decisions/2026-05-03-path-portability.md
    const dirPath = expandHome((req.query.path as string) || userRoot);
    const inWorkspace = isPathSafe(dirPath, userRoot);
    if (!inWorkspace) {
      // Outside the legacy coarse root — allow if active project/shared ACL allows it.
      if (!(await isPathAllowedByCoarseRootOrAcl(dirPath, userRoot, userId, role))) {
        return res.status(403).json({ error: 'Access denied: outside allowed path' });
      }
    }

    // 2026-05-02: dotfile denylist (admin included — those paths are never
    // surfaced through the file browser; admin uses ssh for them).
    if (isDotfileDenied(dirPath)) {
      return res.status(403).json({ error: 'Access denied: system path' });
    }

    // 2026-05-02 (workspace-root-isolation): non-privileged users may not
    // browse the workspace root itself or any non-projects/, non-public
    // directory directly via ?path=. The Sidebar default already routes them
    // to workspace/projects/, so this just blocks URL-tampering / API probes.
    if (userId && !(await isPathAccessible(dirPath, userId, role || 'member'))) {
      return res.status(403).json({ error: 'Access denied: outside your project folders' });
    }

    // showHidden is allowed inside already-authorized paths for all roles.
    // ALWAYS_HIDDEN/system paths are still filtered by getFileTreeAsync and
    // isDotfileDenied, so project members can inspect project-local dotfiles
    // without exposing credentials/runtime state.
    const showHidden = req.query.showHidden === 'true' || req.query.showHidden === '1';
    const projectId = await findProjectByPath(dirPath);
    let entries;
    if (userId && projectId) {
      const project = await getProject(projectId);
      if (!project?.rootPath) return res.status(404).json({ error: 'Project not found' });
      const relativePath = path.relative(path.resolve(project.rootPath), path.resolve(dirPath)).split(path.sep).join('/') || '.';
      const reference = await resolveProjectWorkspaceFile({ projectId, projectRoot: project.rootPath, relativePath, allowProjectRoot: true });
      entries = (await listProjectWorkspaceDirectory({ reference, actorUserId: userId, showHidden })).entries;
    } else {
      entries = await getFileTreeAsync(dirPath, 2, {
        ...(inWorkspace ? {} : { skipSafetyCheck: true }),
        showHidden,
      });
    }

    // Filter project folders: non-privileged users only see projects they're a member of
    const projectsDir = path.resolve(path.join(config.workspaceRoot, 'projects'));
    if (userId && !isPrivilegedRole(role) && path.resolve(dirPath) === projectsDir) {
      const { getUserAccessiblePaths } = await import('../../services/pm/project-access.js');
      const accessiblePaths = await getUserAccessiblePaths(userId, role || 'member');
      if (accessiblePaths) {
        const resolvedRoots = accessiblePaths.map(p => path.resolve(p));
        entries = entries.filter(e => {
          if (!e.isDirectory) return true; // files in projects/ root are visible
          const entryResolved = path.resolve(e.path);
          return resolvedRoots.some(root => entryResolved === root || root.startsWith(entryResolved + path.sep));
        });
      }
    }

    res.json({ path: dirPath, entries });
  } catch (error: any) {
    res.status(403).json({ error: error.message });
  }
});

router.get('/files/read', async (req, res) => {
  try {
    // Expand `~/...` for portable AI-emitted paths.
    // Decision: workspace/decisions/2026-05-03-path-portability.md
    const filePath = expandHome(req.query.path as string);
    if (!filePath) return res.status(400).json({ error: 'path required' });
    const userId = (req as any).user?.userId;
    const role = (req as any).user?.role;
    const userRoot = userId ? await getUserAllowedPath(userId) : config.workspaceRoot;
    if (isDotfileDenied(filePath)) return res.status(403).json({ error: 'Access denied: system path' });
    if (!(await isPathAllowedByCoarseRootOrAcl(filePath, userRoot, userId, role))) {
      if (!userId || !(await hasInternalShareForUser(filePath, userId))) {
        return res.status(403).json({ error: 'Access denied' });
      }
      // internal share found — allow read to continue
    }
    // Project-level path check
    if (userId && !(await isPathAccessible(filePath, userId, role))) {
      return res.status(403).json({ error: 'Access denied: not a member of the project owning this file' });
    }
    const projectId = await findProjectByPath(filePath);
    if (userId && projectId) {
      const project = await getProject(projectId);
      if (!project?.rootPath) return res.status(404).json({ error: 'Project not found' });
      const relativePath = path.relative(path.resolve(project.rootPath), path.resolve(filePath)).split(path.sep).join('/');
      const reference = await resolveProjectWorkspaceFile({ projectId, projectRoot: project.rootPath, relativePath });
      const result = await readProjectWorkspaceFileForPresentation({ reference, actorUserId: userId });
      return res.json({ path: filePath, ...result });
    }
    const result = readFile(filePath);
    res.json({ path: filePath, storageAuthority: 'host', ...result });
  } catch (error: any) {
    res.status(403).json({ error: error.message });
  }
});

// Lightweight file existence check (no content read)
router.get('/files/exists', async (req, res) => {
  try {
    const filePath = req.query.path as string;
    if (!filePath) return res.status(400).json({ exists: false });
    const userId = (req as any).user?.userId;
    const role = (req as any).user?.role;
    const userRoot = userId ? await getUserAllowedPath(userId) : config.workspaceRoot;
    if (isDotfileDenied(filePath)) return res.json({ exists: false });
    if (!(await isPathAllowedByCoarseRootOrAcl(filePath, userRoot, userId, role))) {
      return res.json({ exists: false });
    }
    if (userId && !(await isPathAccessible(filePath, userId, role))) {
      return res.json({ exists: false });
    }
    const projectId = await findProjectByPath(filePath);
    if (userId && projectId) {
      const project = await getProject(projectId);
      if (!project?.rootPath) return res.json({ exists: false });
      const relativePath = path.relative(path.resolve(project.rootPath), path.resolve(filePath)).split(path.sep).join('/') || '.';
      const reference = await resolveProjectWorkspaceFile({ projectId, projectRoot: project.rootPath, relativePath, allowProjectRoot: true });
      const result = await projectWorkspaceEntryExists({ reference, actorUserId: userId });
      return res.json({ ...result, path: filePath });
    }
    const fs = await import('fs');
    const exists = fs.existsSync(filePath);
    res.json({ exists, path: filePath, storageAuthority: 'host' });
  } catch (error: any) {
    if (/WORKER_FILE_AUTHORITY|PROJECT_WORKSPACE_STORAGE_CHANGED/.test(error?.message || '')) {
      return res.status(503).json({ exists: false, error: error.message });
    }
    res.json({ exists: false });
  }
});

async function assertScopedEditFileAccess(req: any, filePath: string) {
  const userId = req.user?.userId as number | undefined;
  const role = String(req.user?.role || 'member');
  if (!userId) throw new ScopedEditError('scoped_edit_auth_required', 401);
  const userRoot = await getUserAllowedPath(userId);
  if (!(await isPathAllowedByCoarseRootOrAcl(filePath, userRoot, userId, role))) {
    throw new ScopedEditError('scoped_edit_access_denied', 403);
  }
  if (isDotfileDenied(filePath)) throw new ScopedEditError('scoped_edit_system_path_denied', 403);
  if (!(await isPathAccessible(filePath, userId, role))) throw new ScopedEditError('scoped_edit_access_denied', 403);
  if (!(await isPathWritableByRole(filePath, userId, role || 'member'))) {
    throw new ScopedEditError('scoped_edit_read_only', 403);
  }
  const projectId = await findProjectByPath(filePath);
  if (projectId) {
    const project = await getProject(projectId);
    if (!project?.rootPath) throw new ScopedEditError('scoped_edit_project_not_found', 404);
    const relativePath = path.relative(path.resolve(project.rootPath), path.resolve(filePath)).split(path.sep).join('/');
    const reference = await resolveProjectWorkspaceFile({ projectId, projectRoot: project.rootPath, relativePath });
    const result = await readProjectWorkspaceFileBytes({ reference, actorUserId: userId, maxBytes: 1024 * 1024 });
    return { userId, role, reference, content: result.bytes.toString('utf8') };
  }
  return { userId, role, content: readFile(filePath).content };
}

router.post('/files/scoped-edit/plan', async (req, res) => {
  try {
    if (!config.inlineEditEnabled) return res.status(404).json({ error: 'Inline edit feature is not enabled' });
    const rawPath = typeof req.body?.path === 'string' ? req.body.path : '';
    const filePath = expandHome(rawPath);
    const start = req.body?.start;
    const end = req.body?.end;
    const expectedSource = typeof req.body?.expectedSource === 'string' ? req.body.expectedSource : '';
    if (!filePath || !expectedSource) return res.status(400).json({ error: 'path and expectedSource required' });
    if (!/\.html?$/i.test(filePath)) return res.status(400).json({ error: 'scoped_edit_static_html_required' });
    const access = await assertScopedEditFileAccess(req, filePath);
    validateScopedSelection(access.content, { path: filePath, start, end, expectedSource });
    const plan = await discoverStaticHtmlCssEditPlan({
      htmlPath: filePath,
      htmlContent: access.content,
      elementStart: start,
      elementEnd: end,
      expectedSource,
      readLocalFile: async (relatedPath) => {
        try {
          const related = await assertScopedEditFileAccess(req, relatedPath);
          return related.content;
        } catch {
          return null;
        }
      },
    });
    res.json(plan);
  } catch (error: any) {
    const status = error instanceof ScopedEditError
      ? error.status
      : /stale|mapping_missing/i.test(error?.message || '') ? 409 : 500;
    if (status >= 500) console.error('[scoped-edit] plan failed:', error);
    res.status(status).json({ error: error?.code || error?.message || 'scoped_edit_plan_failed' });
  }
});

router.post('/files/scoped-edit/propose', async (req, res) => {
  try {
    if (!config.inlineEditEnabled) return res.status(404).json({ error: 'Inline edit feature is not enabled' });
    const rawPath = typeof req.body?.path === 'string' ? req.body.path : '';
    const filePath = expandHome(rawPath);
    const start = req.body?.start;
    const end = req.body?.end;
    const expectedSource = typeof req.body?.expectedSource === 'string' ? req.body.expectedSource : '';
    const instruction = typeof req.body?.instruction === 'string' ? req.body.instruction.trim() : '';
    if (!filePath || !expectedSource || !instruction) {
      return res.status(400).json({ error: 'path, expectedSource, and instruction required' });
    }
    const access = await assertScopedEditFileAccess(req, filePath);
    const selection = { path: filePath, start, end, expectedSource };
    // Validate before invoking the model: stale or tampered ranges must not
    // consume AI work and must never receive a proposal token.
    validateScopedSelection(access.content, selection);
    const beforeContext = access.content.slice(Math.max(0, start - 2_000), start);
    const afterContext = access.content.slice(end, end + 2_000);
    const result = await runInlineEdit({
      selection: expectedSource,
      beforeContext,
      afterContext,
      instruction,
      selectionKind: 'html',
      editMode: 'replace',
    });
    const proposal = createScopedEditProposal({
      userId: access.userId,
      selection,
      currentContent: access.content,
      replacement: result.replacement,
      instruction,
      model: result.model,
    });
    appendInlineEditAudit({
      userId: access.userId,
      role: access.role ?? null,
      path: filePath,
      instruction,
      selectionLen: expectedSource.length,
      replacementLen: result.replacement.length,
      model: result.model,
      applied: false,
      durationMs: result.durationMs,
    });
    res.json({
      proposalToken: proposal.proposalToken,
      replacement: proposal.replacement,
      original: expectedSource,
      path: filePath,
      start,
      end,
      model: result.model,
      durationMs: result.durationMs,
      unchanged: result.replacement === expectedSource,
    });
  } catch (error: any) {
    const status = error instanceof ScopedEditError
      ? error.status
      : /too long|empty|required/i.test(error?.message || '') ? 400 : 500;
    if (status >= 500) console.error('[scoped-edit] propose failed:', error);
    res.status(status).json({ error: error?.code || error?.message || 'scoped_edit_proposal_failed' });
  }
});

router.get('/files/scoped-edit/multi-file-proposal/:intentId', async (req, res) => {
  try {
    if (!config.inlineEditEnabled) return res.status(404).json({ error: 'Inline edit feature is not enabled' });
    const userId = (req as any).user?.userId as number | undefined;
    const proposalHash = typeof req.query?.proposalHash === 'string' ? req.query.proposalHash : '';
    if (!userId) return res.status(401).json({ error: 'scoped_edit_auth_required' });
    if (!proposalHash) return res.status(400).json({ error: 'proposalHash required' });
    res.json(inspectMultiFileEditProposal({ intentId: req.params.intentId, proposalHash, userId }));
  } catch (error: any) {
    const status = error instanceof ScopedEditError ? error.status : 500;
    res.status(status).json({ error: error?.code || error?.message || 'scoped_edit_multifile_proposal_failed' });
  }
});

router.post('/files/scoped-edit/multi-file-apply', async (req, res) => {
  let reservation: ReturnType<typeof reserveMultiFileEditProposal> | null = null;
  try {
    if (!config.inlineEditEnabled) return res.status(404).json({ error: 'Inline edit feature is not enabled' });
    const userId = (req as any).user?.userId as number | undefined;
    const role = (req as any).user?.role || 'member';
    const intentId = typeof req.body?.intentId === 'string' ? req.body.intentId : '';
    const proposalHash = typeof req.body?.proposalHash === 'string' ? req.body.proposalHash : '';
    if (!userId) return res.status(401).json({ error: 'scoped_edit_auth_required' });
    if (!intentId || !proposalHash || req.body?.confirmed !== true) return res.status(400).json({ error: 'intentId, proposalHash, and confirmed=true required' });
    reservation = reserveMultiFileEditProposal({ intentId, proposalHash, userId });
    for (const file of reservation.intent.files) {
      const access = await assertScopedEditFileAccess(req, file.path);
      if (access.reference?.workerAuthority) throw new ScopedEditError('scoped_edit_worker_cas_unavailable', 409);
      if (!(await isPathWritableByRole(file.path, userId, role))) throw new ScopedEditError('scoped_edit_access_denied', 403);
    }
    const result = await applyMultiFileEditProposal(reservation.intent);
    reservation.complete();
    reservation = null;
    res.json({ ok: true, applied: true, paths: result.paths, crashAtomic: false });
  } catch (error: any) {
    reservation?.release();
    const status = error instanceof ScopedEditError ? error.status : 500;
    if (status >= 500) console.error('[scoped-edit] multi-file apply failed:', error);
    res.status(status).json({ error: error?.code || error?.message || 'scoped_edit_multifile_apply_failed' });
  }
});

router.post('/files/scoped-edit/apply', async (req, res) => {
  let releaseReservation: (() => void) | null = null;
  try {
    if (!config.inlineEditEnabled) return res.status(404).json({ error: 'Inline edit feature is not enabled' });
    const proposalToken = typeof req.body?.proposalToken === 'string' ? req.body.proposalToken : '';
    const userId = (req as any).user?.userId as number | undefined;
    if (!proposalToken) return res.status(400).json({ error: 'proposalToken required' });
    if (!userId) return res.status(401).json({ error: 'scoped_edit_auth_required' });
    const proposal = verifyScopedEditProposal(proposalToken, userId);
    releaseReservation = reserveScopedEditProposal(proposal.proposalId);
    const access = await assertScopedEditFileAccess(req, proposal.path);
    if (access.reference) {
      const next = applyScopedReplacement(access.content, proposal);
      const storageAuthority = await compareAndSwapProjectWorkspaceText({
        reference: access.reference,
        actorUserId: userId,
        expectedContent: access.content,
        content: next,
      });
      appendInlineEditAudit({
        userId,
        role: access.role ?? null,
        path: proposal.path,
        instruction: proposal.instruction,
        selectionLen: proposal.end - proposal.start,
        replacementLen: proposal.replacement.length,
        model: proposal.model,
        applied: true,
        durationMs: 0,
      });
      releaseReservation = null;
      return res.json({ ok: true, path: proposal.path, content: next, start: proposal.start, end: proposal.end, replacement: proposal.replacement, storageAuthority });
    }
    const release = await lockfile.lock(proposal.path, {
      realpath: true,
      retries: { retries: 3, minTimeout: 25, maxTimeout: 100 },
    });
    let next: string;
    try {
      const lockedContent = readFile(proposal.path).content;
      next = applyScopedReplacement(lockedContent, proposal);
      writeFile(proposal.path, next);
    } finally {
      await release();
    }
    appendInlineEditAudit({
      userId,
      role: access.role ?? null,
      path: proposal.path,
      instruction: proposal.instruction,
      selectionLen: proposal.end - proposal.start,
      replacementLen: proposal.replacement.length,
      model: proposal.model,
      applied: true,
      durationMs: 0,
    });
    releaseReservation = null;
    res.json({
      ok: true,
      path: proposal.path,
      content: next,
      start: proposal.start,
      end: proposal.end,
      replacement: proposal.replacement,
      storageAuthority: 'host',
    });
  } catch (error: any) {
    releaseReservation?.();
    const status = error instanceof ScopedEditError ? error.status : 500;
    if (status >= 500) console.error('[scoped-edit] apply failed:', error);
    res.status(status).json({ error: error?.code || error?.message || 'scoped_edit_apply_failed' });
  }
});

router.post('/files/write', async (req, res) => {
  try {
    const { path: filePath, content } = req.body;
    if (!filePath || content === undefined) return res.status(400).json({ error: 'path and content required' });
    const userId = (req as any).user?.userId;
    const role = (req as any).user?.role;
    const userRoot = userId ? await getUserAllowedPath(userId) : config.workspaceRoot;
    if (!(await isPathAllowedByCoarseRootOrAcl(filePath, userRoot, userId, role))) return res.status(403).json({ error: 'Access denied' });
    if (isDotfileDenied(filePath)) return res.status(403).json({ error: 'Access denied: system path' });
    // Project-level path check (read-membership) + role-based write check
    if (userId && !(await isPathAccessible(filePath, userId, role))) {
      return res.status(403).json({ error: 'Access denied: not a member of the project owning this file' });
    }
    if (userId && !(await isPathWritableByRole(filePath, userId, role || 'member'))) {
      return res.status(403).json({ error: 'Access denied: this folder is read-only for your role' });
    }
    const projectId = await findProjectByPath(filePath);
    if (userId && projectId) {
      const project = await getProject(projectId);
      if (!project?.rootPath) return res.status(404).json({ error: 'Project not found' });
      const relativePath = path.relative(path.resolve(project.rootPath), path.resolve(filePath)).split(path.sep).join('/');
      const reference = await resolveProjectWorkspaceFile({ projectId, projectRoot: project.rootPath, relativePath });
      const storageAuthority = await writeProjectWorkspaceText({ reference, actorUserId: userId, content });
      return res.json({ ok: true, path: filePath, storageAuthority });
    }
    writeFile(filePath, content);
    res.json({ ok: true, path: filePath, storageAuthority: 'host' });
  } catch (error: any) {
    if (respondCanonicalWriteError(res, error)) return;
    res.status(403).json({ error: error.message });
  }
});


// ───── File Management (create / mkdir / delete / rename / copy / search) ─────
// - New top-level folders under workspace/ require admin/operator
//   (members must work inside their own project)
// - Filenames/dirnames starting with `.` rejected for non-privileged roles
//   (prevents members creating .env / .mcp.json / .claude / etc)

function rejectDotName(name: string, role: string | undefined): { allowed: boolean; message?: string } {
  if (isPrivilegedRole(role)) return { allowed: true };
  if (name.startsWith('.')) {
    return {
      allowed: false,
      message: 'Access denied: file/folder names starting with "." are restricted to admin/operator.',
    };
  }
  return { allowed: true };
}

router.post('/files/create', async (req, res) => {
  try {
    const { path: filePath, content } = req.body;
    if (!filePath) return res.status(400).json({ error: 'path required' });
    const userId = (req as any).user?.userId;
    const role = (req as any).user?.role;
    const userRoot = userId ? await getUserAllowedPath(userId) : config.workspaceRoot;
    if (!(await isPathAllowedByCoarseRootOrAcl(filePath, userRoot, userId, role))) return res.status(403).json({ error: 'Access denied' });
    if (isDotfileDenied(filePath)) return res.status(403).json({ error: 'Access denied: system path' });
    if (userId && !(await isPathAccessible(filePath, userId, role))) return res.status(403).json({ error: 'Access denied: outside your project folders' });
    if (userId && !(await isPathWritableByRole(filePath, userId, role || 'member'))) {
      return res.status(403).json({ error: 'Access denied: this folder is read-only for your role' });
    }
    const nameCheck = rejectDotName(path.basename(filePath), role);
    if (!nameCheck.allowed) return res.status(403).json({ error: nameCheck.message });
    const projectId = await findProjectByPath(filePath);
    if (userId && projectId) {
      const project = await getProject(projectId);
      if (!project?.rootPath) return res.status(404).json({ error: 'Project not found' });
      const relativePath = path.relative(path.resolve(project.rootPath), path.resolve(filePath)).split(path.sep).join('/');
      const reference = await resolveProjectWorkspaceFile({ projectId, projectRoot: project.rootPath, relativePath });
      try {
        const storageAuthority = await writeProjectWorkspaceText({ reference, actorUserId: userId, content: content || '', exclusive: true });
        invalidateTreeCache(filePath);
        return res.json({ ok: true, path: filePath, storageAuthority });
      } catch (error: any) {
    if (respondCanonicalWriteError(res, error)) return;
        if (error?.code === 'EEXIST' || /EEXIST|exit code 17/.test(error?.message || '')) return res.status(409).json({ error: 'File already exists' });
        throw error;
      }
    }
    if (fs.existsSync(filePath)) return res.status(409).json({ error: 'File already exists' });
    writeFile(filePath, content || '');
    invalidateTreeCache(filePath);
    res.json({ ok: true, path: filePath, storageAuthority: 'host' });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/files/mkdir', async (req, res) => {
  try {
    const { path: dirPath } = req.body;
    if (!dirPath) return res.status(400).json({ error: 'path required' });
    const userId = (req as any).user?.userId;
    const role = (req as any).user?.role;
    const userRoot = userId ? await getUserAllowedPath(userId) : config.workspaceRoot;
    if (!(await isPathAllowedByCoarseRootOrAcl(dirPath, userRoot, userId, role))) return res.status(403).json({ error: 'Access denied' });
    if (isDotfileDenied(dirPath)) return res.status(403).json({ error: 'Access denied: system path' });
    if (userId && !(await isPathAccessible(dirPath, userId, role))) return res.status(403).json({ error: 'Access denied: outside your project folders' });
    if (userId && !(await isPathWritableByRole(dirPath, userId, role || 'member'))) {
      return res.status(403).json({ error: 'Access denied: cannot create folders in this location' });
    }
    // 2026-05-02: block creation of new top-level folders directly under workspace/
    // for non-privileged roles. Decision: workspace 루트는 admin/operator territory.
    const parent = path.resolve(path.dirname(dirPath));
    if (parent === path.resolve(config.workspaceRoot) && !isPrivilegedRole(role)) {
      return res.status(403).json({
        error: 'Access denied: only admin/operator can create new top-level folders under workspace/. Create a project instead.',
      });
    }
    const nameCheck = rejectDotName(path.basename(dirPath), role);
    if (!nameCheck.allowed) return res.status(403).json({ error: nameCheck.message });
    await assertProjectSharedMutationForHostPath(dirPath);
    const projectId = await findProjectByPath(dirPath);
    if (userId && projectId) {
      const project = await getProject(projectId);
      if (!project?.rootPath) return res.status(404).json({ error: 'Project not found' });
      const relativePath = path.relative(path.resolve(project.rootPath), path.resolve(dirPath)).split(path.sep).join('/');
      const reference = await resolveProjectWorkspaceFile({ projectId, projectRoot: project.rootPath, relativePath });
      try {
        const storageAuthority = await createProjectWorkspaceDirectory({ reference, actorUserId: userId, exclusive: true });
        invalidateTreeCache(dirPath);
        return res.json({ ok: true, path: dirPath, storageAuthority });
      } catch (error: any) {
        if (error?.code === 'EEXIST' || /EEXIST|exit code 17/.test(error?.message || '')) return res.status(409).json({ error: 'Directory already exists' });
        throw error;
      }
    }
    if (fs.existsSync(dirPath)) return res.status(409).json({ error: 'Directory already exists' });
    createDirectory(dirPath);
    invalidateTreeCache(dirPath);
    res.json({ ok: true, path: dirPath, storageAuthority: 'host' });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/files/delete', async (req, res) => {
  try {
    const { path: targetPath } = req.body;
    if (!targetPath) return res.status(400).json({ error: 'path required' });
    const userId = (req as any).user?.userId;
    const role = (req as any).user?.role;
    // A readable path is not a write grant (including guest and project viewers).
    if (role === 'viewer' || role === 'guest') return res.status(403).json({ error: 'Read-only role cannot delete files' });
    const userRoot = userId ? await getUserAllowedPath(userId) : config.workspaceRoot;
    if (!(await isPathAllowedByCoarseRootOrAcl(targetPath, userRoot, userId, role))) return res.status(403).json({ error: 'Access denied' });
    if (userId && !(await isPathAccessible(targetPath, userId, role))) return res.status(403).json({ error: 'Access denied: outside your project folders' });
    if (!userId || !(await isPathWritableByRole(targetPath, userId, role || 'guest'))) {
      return res.status(403).json({ error: 'Access denied: this folder is read-only for your role' });
    }
    const projectId = await findProjectByPath(targetPath);
    if (projectId) {
      const project = await getProject(projectId);
      if (!project?.rootPath) return res.status(404).json({ error: 'Project not found' });
      const relativePath = path.relative(path.resolve(project.rootPath), path.resolve(targetPath)).split(path.sep).join('/');
      const reference = await resolveProjectWorkspaceFile({ projectId, projectRoot: project.rootPath, relativePath });
      const storageAuthority = await deleteProjectWorkspaceEntry({ reference, actorUserId: userId });
      invalidateTreeCache(targetPath);
      return res.json({ ok: true, storageAuthority });
    }
    deleteEntry(targetPath);
    invalidateTreeCache(targetPath);
    res.json({ ok: true, storageAuthority: 'host' });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/files/rename', async (req, res) => {
  try {
    const { oldPath, newPath } = req.body;
    if (!oldPath || !newPath) return res.status(400).json({ error: 'oldPath and newPath required' });
    const userId = (req as any).user?.userId;
    const role = (req as any).user?.role;
    const userRoot = userId ? await getUserAllowedPath(userId) : config.workspaceRoot;
    if (!(await isPathAllowedByCoarseRootOrAcl(oldPath, userRoot, userId, role))) return res.status(403).json({ error: 'Access denied' });
    if (!(await isPathAllowedByCoarseRootOrAcl(newPath, userRoot, userId, role))) return res.status(403).json({ error: 'Access denied' });
    if (isDotfileDenied(oldPath) || isDotfileDenied(newPath)) {
      return res.status(403).json({ error: 'Access denied: system path' });
    }
    if (userId && (!(await isPathAccessible(oldPath, userId, role)) || !(await isPathAccessible(newPath, userId, role)))) {
      return res.status(403).json({ error: 'Access denied: outside your project folders' });
    }
    if (userId && (!(await isPathWritableByRole(oldPath, userId, role || 'member')) || !(await isPathWritableByRole(newPath, userId, role || 'member')))) {
      return res.status(403).json({ error: 'Access denied: source or destination is read-only for your role' });
    }
    // 2026-05-02: block moves into workspace root for non-privileged
    const newParent = path.resolve(path.dirname(newPath));
    if (newParent === path.resolve(config.workspaceRoot) && !isPrivilegedRole(role)) {
      return res.status(403).json({ error: 'Access denied: cannot move into workspace root. admin/operator only.' });
    }
    const nameCheck = rejectDotName(path.basename(newPath), role);
    if (!nameCheck.allowed) return res.status(403).json({ error: nameCheck.message });
    const sourceProjectId = await findProjectByPath(oldPath);
    const targetProjectId = await findProjectByPath(newPath);
    if (userId && sourceProjectId && targetProjectId) {
      const sourceProject = await getProject(sourceProjectId);
      const targetProject = sourceProjectId === targetProjectId ? sourceProject : await getProject(targetProjectId);
      if (!sourceProject?.rootPath || !targetProject?.rootPath) return res.status(404).json({ error: 'Project not found' });
      const source = await resolveProjectWorkspaceFile({ projectId: sourceProjectId, projectRoot: sourceProject.rootPath, relativePath: path.relative(sourceProject.rootPath, oldPath).split(path.sep).join('/') });
      const target = await resolveProjectWorkspaceFile({ projectId: targetProjectId, projectRoot: targetProject.rootPath, relativePath: path.relative(targetProject.rootPath, newPath).split(path.sep).join('/') });
      try {
        const storageAuthority = await renameProjectWorkspaceEntry({ source, target, actorUserId: userId });
        invalidateTreeCache(oldPath);
        invalidateTreeCache(newPath);
        return res.json({ ok: true, path: newPath, storageAuthority });
      } catch (error: any) {
        if (/across storage authorities/.test(error?.message || '')) return res.status(409).json({ error: error.message });
        throw error;
      }
    }
    if (sourceProjectId || targetProjectId) return res.status(409).json({ error: 'Cannot rename across storage authorities' });
    renameEntry(oldPath, newPath);
    invalidateTreeCache(oldPath);
    invalidateTreeCache(newPath);
    res.json({ ok: true, path: newPath, storageAuthority: 'host' });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

function compactTopLevelPaths(paths: string[]): string[] {
  const unique = [...new Set(paths.filter(Boolean))]
    .map((p) => ({ original: p, resolved: path.resolve(p) }))
    .sort((a, b) => a.resolved.length - b.resolved.length);
  const kept: typeof unique = [];
  for (const candidate of unique) {
    if (kept.some((parent) => candidate.resolved.startsWith(parent.resolved + path.sep))) continue;
    kept.push(candidate);
  }
  return kept.map((p) => p.original);
}

function nextAvailableCopyPath(targetDir: string, sourceName: string): string {
  const ext = path.extname(sourceName);
  const stem = ext ? sourceName.slice(0, -ext.length) : sourceName;
  const first = path.join(targetDir, sourceName);
  if (!fs.existsSync(first)) return first;
  for (let i = 1; i <= 1000; i++) {
    const suffix = i === 1 ? ' copy' : ` copy ${i}`;
    const candidate = path.join(targetDir, `${stem}${suffix}${ext}`);
    if (!fs.existsSync(candidate)) return candidate;
  }
  throw new Error(`Could not find available copy name for ${sourceName}`);
}

router.post('/files/copy', async (req, res) => {
  try {
    const { paths: rawPaths, targetDir } = req.body as { paths?: string[]; targetDir?: string };
    if (!Array.isArray(rawPaths) || rawPaths.length === 0) return res.status(400).json({ error: 'paths required' });
    if (!targetDir) return res.status(400).json({ error: 'targetDir required' });

    const userId = (req as any).user?.userId;
    const role = (req as any).user?.role;
    if (role === 'viewer') return res.status(403).json({ error: 'Viewer role cannot copy files' });

    const userRoot = userId ? await getUserAllowedPath(userId) : config.workspaceRoot;
    if (!(await isPathAllowedByCoarseRootOrAcl(targetDir, userRoot, userId, role))) return res.status(403).json({ error: 'Access denied' });
    if (isDotfileDenied(targetDir)) return res.status(403).json({ error: 'Access denied: system path' });
    if (userId && !(await isPathAccessible(targetDir, userId, role))) return res.status(403).json({ error: 'Access denied: outside your project folders' });
    if (userId && !(await isPathWritableByRole(targetDir, userId, role || 'member'))) {
      return res.status(403).json({ error: 'Access denied: target folder is read-only for your role' });
    }

    const resolvedTargetDir = path.resolve(targetDir);
    const targetProjectId = await findProjectByPath(resolvedTargetDir);
    let targetReference;
    if (userId && targetProjectId) {
      const project = await getProject(targetProjectId);
      if (!project?.rootPath) return res.status(404).json({ error: 'Project not found' });
      targetReference = await resolveProjectWorkspaceFile({ projectId: targetProjectId, projectRoot: project.rootPath, relativePath: path.relative(project.rootPath, resolvedTargetDir).split(path.sep).join('/') || '.', allowProjectRoot: true });
      if (!(await projectWorkspaceEntryExists({ reference: targetReference, actorUserId: userId })).exists) return res.status(404).json({ error: 'Target directory not found' });
    } else if (!fs.existsSync(resolvedTargetDir) || !fs.statSync(resolvedTargetDir).isDirectory()) return res.status(404).json({ error: 'Target directory not found' });
    if (resolvedTargetDir === path.resolve(config.workspaceRoot) && !isPrivilegedRole(role)) {
      return res.status(403).json({ error: 'Access denied: cannot copy into workspace root. admin/operator only.' });
    }

    const paths = compactTopLevelPaths(rawPaths);
    const results: { sourcePath: string; targetPath?: string; error?: string }[] = [];

    for (const sourcePath of paths) {
      try {
        if (!(await isPathAllowedByCoarseRootOrAcl(sourcePath, userRoot, userId, role))) throw new Error('Access denied');
        if (isDotfileDenied(sourcePath)) throw new Error('Access denied: system path');
        if (userId && !(await isPathAccessible(sourcePath, userId, role))) throw new Error('Access denied: outside your project folders');

        const resolvedSource = path.resolve(sourcePath);
        const sourceProjectId = await findProjectByPath(resolvedSource);
        const targetPath = path.join(resolvedTargetDir, path.basename(resolvedSource));
        const nameCheck = rejectDotName(path.basename(targetPath), role);
        if (!nameCheck.allowed) throw new Error(nameCheck.message || 'Access denied');
        if (userId && !(await isPathWritableByRole(targetPath, userId, role || 'member'))) {
          throw new Error('Access denied: target path is read-only for your role');
        }

        let copied: { targetPath: string };
        if (userId && sourceProjectId && targetProjectId && targetReference) {
          const project = await getProject(sourceProjectId);
          if (!project?.rootPath) throw new Error('Project not found');
          const source = await resolveProjectWorkspaceFile({ projectId: sourceProjectId, projectRoot: project.rootPath, relativePath: path.relative(project.rootPath, resolvedSource).split(path.sep).join('/') });
          copied = await copyProjectWorkspaceEntry({ source, targetDirectory: targetReference, actorUserId: userId });
        } else {
          if (sourceProjectId || targetProjectId) throw new Error('Cannot copy across storage authorities');
          if (!fs.existsSync(resolvedSource)) throw new Error('Source path does not exist');
          const availableTargetPath = nextAvailableCopyPath(resolvedTargetDir, path.basename(resolvedSource));
          copyEntry(resolvedSource, availableTargetPath);
          copied = { targetPath: availableTargetPath };
        }
        invalidateTreeCache(sourcePath);
        invalidateTreeCache(copied.targetPath);
        results.push({ sourcePath, targetPath: copied.targetPath });
      } catch (error: any) {
        results.push({ sourcePath, error: error.message || 'Copy failed' });
      }
    }

    const copied = results.filter((r) => !r.error).length;
    const failed = results.length - copied;
    res.json({ ok: failed === 0, copied, failed, results });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/files/search', async (req, res) => {
  try {
    const root = String(req.query.root || '');
    const query = String(req.query.q || '').trim().toLowerCase();
    if (!root || query.length < 2) return res.status(400).json({ error: 'root and q (2+ chars) required' });
    const userId = (req as any).user?.userId;
    const role = (req as any).user?.role;
    const userRoot = userId ? await getUserAllowedPath(userId) : config.workspaceRoot;
    if (!(await isPathAllowedByCoarseRootOrAcl(root, userRoot, userId, role)) || (userId && !(await isPathAccessible(root, userId, role)))) return res.status(403).json({ error: 'Access denied' });
    const resolvedRoot = path.resolve(root);
    const projectId = await findProjectByPath(resolvedRoot);
    const project = projectId ? await getProject(projectId) : undefined;
    const showHidden = req.query.showHidden === 'true';
    const skip = new Set(['.git', 'node_modules', '.cache', 'dist', 'build']);
    const result = await searchFileTree(resolvedRoot, query, async directory => {
      const entries = userId && projectId && project?.rootPath
        ? (await listProjectWorkspaceDirectory({
            reference: await resolveProjectWorkspaceFile({ projectId, projectRoot: project.rootPath,
              relativePath: path.relative(project.rootPath, directory).split(path.sep).join('/') || '.', allowProjectRoot: true }),
            actorUserId: userId, showHidden, depth: 1,
          })).entries
        : await getFileTreeAsync(directory, 1, { showHidden });
      return entries.filter(entry => !skip.has(entry.name) && !isDotfileDenied(entry.path)
        && (showHidden || !entry.name.startsWith('.')));
    });
    res.json(result);
  } catch (error: any) { res.status(500).json({ error: error.message }); }
});


export default router;

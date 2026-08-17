/**
 * Owns: authenticated Project file browsing and core mutations.
 * Public API: projectFilesRouter. See README.md.
 */
import { Router } from 'express';
import fs from 'fs';
import path from 'path';
import { config } from '../../config.js';
import { getUserAllowedPath } from '../../services/auth/auth.js';
import {
  copyEntry, createDirectory, deleteEntry, expandHome, getFileTreeAsync,
  invalidateTreeCache, isPathSafe, readFile, renameEntry, writeFile,
} from '../../services/workspace/file-system.js';
import { scanNotesIndex, type NotesIndexMode } from '../../services/workspace/notes-index.js';
import { buildWorkspaceKnowledgeGraph } from '../../services/workspace/knowledge-graph.js';
import { hasInternalShareForUser } from '../../services/workspace/share-manager.js';
import { isDotfileDenied, isPathAccessible, isPathWritableByRole, isPrivilegedRole } from '../../services/pm/project-access.js';
import { isPathAllowedByCoarseRootOrAcl } from './project-files-access.js';
import {
  copyWorkerProjectEntry,
  createWorkerProjectDirectory,
  deleteWorkerProjectEntry,
  listWorkerProjectDirectory,
  readWorkerProjectFile,
  renameWorkerProjectEntry,
  resolveWorkerFileAuthorityForHostPath,
  workerProjectFileExists,
  writeWorkerProjectFile,
} from '../../services/runtime-box/workbench-project-file-authority.js';
import { mirrorWorkerProjectMutation } from '../../services/runtime-box/workbench-project-derived-mirror.js';

const router = Router();
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
    if (!fs.existsSync(rootPath) || !fs.statSync(rootPath).isDirectory()) {
      return res.status(400).json({ error: 'path must be a directory' });
    }

    const result = await scanNotesIndex(rootPath, { mode, maxFiles, maxDepth });
    res.json(result);
  } catch (error: any) {
    console.error('[api] files/notes-index failed:', error);
    res.status(500).json({ error: error.message || 'Failed to build notes index' });
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
    if (!fs.existsSync(rootPath) || !fs.statSync(rootPath).isDirectory()) {
      return res.status(400).json({ error: 'path must be a directory' });
    }

    const result = await buildWorkspaceKnowledgeGraph(rootPath, { maxFiles, maxDepth, includeUnresolved });
    res.json(result);
  } catch (error: any) {
    console.error('[api] files/knowledge-graph failed:', error);
    res.status(500).json({ error: error.message || 'Failed to build knowledge graph' });
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
    const workerAuthority = userId ? await resolveWorkerFileAuthorityForHostPath(dirPath) : undefined;
    let entries = workerAuthority
      ? await listWorkerProjectDirectory({ authority: workerAuthority, actorUserId: userId, showHidden })
      : await getFileTreeAsync(dirPath, 2, {
        ...(inWorkspace ? {} : { skipSafetyCheck: true }),
        showHidden,
      });

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
    const workerAuthority = userId ? await resolveWorkerFileAuthorityForHostPath(filePath) : undefined;
    const result = workerAuthority
      ? await readWorkerProjectFile({ authority: workerAuthority, actorUserId: userId })
      : readFile(filePath);
    res.json({ path: filePath, storageAuthority: workerAuthority ? 'worker' : 'host', ...result });
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
    const workerAuthority = userId ? await resolveWorkerFileAuthorityForHostPath(filePath) : undefined;
    if (workerAuthority) {
      const exists = await workerProjectFileExists({ authority: workerAuthority, actorUserId: userId });
      return res.json({ exists, path: filePath, storageAuthority: 'worker' });
    }
    const fs = await import('fs');
    const exists = fs.existsSync(filePath);
    res.json({ exists, path: filePath, storageAuthority: 'host' });
  } catch {
    res.json({ exists: false });
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
    const workerAuthority = userId ? await resolveWorkerFileAuthorityForHostPath(filePath) : undefined;
    if (workerAuthority) {
      await writeWorkerProjectFile({ authority: workerAuthority, actorUserId: userId, content });
      mirrorWorkerProjectMutation(workerAuthority, { kind: 'write-text', hostPath: filePath, content });
    } else writeFile(filePath, content);
    res.json({ ok: true, path: filePath, storageAuthority: workerAuthority ? 'worker' : 'host' });
  } catch (error: any) {
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
    const workerAuthority = userId ? await resolveWorkerFileAuthorityForHostPath(filePath) : undefined;
    const exists = workerAuthority
      ? await workerProjectFileExists({ authority: workerAuthority, actorUserId: userId })
      : fs.existsSync(filePath);
    if (exists) return res.status(409).json({ error: 'File already exists' });
    if (workerAuthority) {
      await writeWorkerProjectFile({ authority: workerAuthority, actorUserId: userId, content: content || '', exclusive: true });
      mirrorWorkerProjectMutation(workerAuthority, { kind: 'write-text', hostPath: filePath, content: content || '' });
    } else writeFile(filePath, content || '');
    invalidateTreeCache(filePath);
    res.json({ ok: true, path: filePath, storageAuthority: workerAuthority ? 'worker' : 'host' });
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
    const workerAuthority = userId ? await resolveWorkerFileAuthorityForHostPath(dirPath) : undefined;
    const exists = workerAuthority
      ? await workerProjectFileExists({ authority: workerAuthority, actorUserId: userId })
      : fs.existsSync(dirPath);
    if (exists) return res.status(409).json({ error: 'Directory already exists' });
    if (workerAuthority) {
      await createWorkerProjectDirectory({ authority: workerAuthority, actorUserId: userId, exclusive: true });
      mirrorWorkerProjectMutation(workerAuthority, { kind: 'mkdir', hostPath: dirPath });
    } else createDirectory(dirPath);
    invalidateTreeCache(dirPath);
    res.json({ ok: true, path: dirPath, storageAuthority: workerAuthority ? 'worker' : 'host' });
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
    // viewer is read-only — block UI delete even when path-accessible.
    // (Other roles fall through to project-membership / allowed-path checks.)
    if (role === 'viewer') return res.status(403).json({ error: 'Viewer role cannot delete files' });
    const userRoot = userId ? await getUserAllowedPath(userId) : config.workspaceRoot;
    if (!(await isPathAllowedByCoarseRootOrAcl(targetPath, userRoot, userId, role))) return res.status(403).json({ error: 'Access denied' });
    if (userId && !(await isPathAccessible(targetPath, userId, role))) return res.status(403).json({ error: 'Access denied: outside your project folders' });
    const workerAuthority = userId ? await resolveWorkerFileAuthorityForHostPath(targetPath) : undefined;
    if (workerAuthority) {
      await deleteWorkerProjectEntry({ authority: workerAuthority, actorUserId: userId });
      mirrorWorkerProjectMutation(workerAuthority, { kind: 'delete', hostPath: targetPath });
    } else deleteEntry(targetPath);
    invalidateTreeCache(targetPath);
    res.json({ ok: true, storageAuthority: workerAuthority ? 'worker' : 'host' });
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
    const workerAuthority = userId ? await resolveWorkerFileAuthorityForHostPath(oldPath) : undefined;
    const newWorkerAuthority = userId ? await resolveWorkerFileAuthorityForHostPath(newPath) : undefined;
    if (Boolean(workerAuthority) !== Boolean(newWorkerAuthority) || (workerAuthority && newWorkerAuthority && workerAuthority.workerId !== newWorkerAuthority.workerId)) {
      return res.status(409).json({ error: 'Cannot rename across storage authorities' });
    }
    if (workerAuthority) {
      await renameWorkerProjectEntry({ authority: workerAuthority, actorUserId: userId, newHostPath: newPath });
      mirrorWorkerProjectMutation(workerAuthority, { kind: 'rename', oldHostPath: oldPath, newHostPath: newPath });
    } else renameEntry(oldPath, newPath);
    invalidateTreeCache(oldPath);
    invalidateTreeCache(newPath);
    res.json({ ok: true, path: newPath, storageAuthority: workerAuthority ? 'worker' : 'host' });
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
    const targetWorkerAuthority = userId ? await resolveWorkerFileAuthorityForHostPath(resolvedTargetDir) : undefined;
    const targetExists = targetWorkerAuthority
      ? await workerProjectFileExists({ authority: targetWorkerAuthority, actorUserId: userId })
      : fs.existsSync(resolvedTargetDir) && fs.statSync(resolvedTargetDir).isDirectory();
    if (!targetExists) return res.status(404).json({ error: 'Target directory not found' });
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
        const sourceWorkerAuthority = userId ? await resolveWorkerFileAuthorityForHostPath(resolvedSource) : undefined;
        if (Boolean(sourceWorkerAuthority) !== Boolean(targetWorkerAuthority)
          || (sourceWorkerAuthority && targetWorkerAuthority && sourceWorkerAuthority.workerId !== targetWorkerAuthority.workerId)) {
          throw new Error('Cannot copy across storage authorities');
        }
        if (sourceWorkerAuthority) {
          if (!(await workerProjectFileExists({ authority: sourceWorkerAuthority, actorUserId: userId }))) throw new Error('Source path does not exist');
        } else if (!fs.existsSync(resolvedSource)) throw new Error('Source path does not exist');
        if (!sourceWorkerAuthority) {
          const stat = fs.statSync(resolvedSource);
          if (stat.isDirectory() && (resolvedTargetDir === resolvedSource || resolvedTargetDir.startsWith(resolvedSource + path.sep))) {
            throw new Error('Cannot copy a folder into itself or its subfolder');
          }
        }

        const targetPath = sourceWorkerAuthority
          ? path.join(resolvedTargetDir, path.basename(resolvedSource))
          : nextAvailableCopyPath(resolvedTargetDir, path.basename(resolvedSource));
        const nameCheck = rejectDotName(path.basename(targetPath), role);
        if (!nameCheck.allowed) throw new Error(nameCheck.message || 'Access denied');
        if (userId && !(await isPathWritableByRole(targetPath, userId, role || 'member'))) {
          throw new Error('Access denied: target path is read-only for your role');
        }

        const copied = sourceWorkerAuthority
          ? await copyWorkerProjectEntry({ authority: sourceWorkerAuthority, actorUserId: userId, targetDirHostPath: resolvedTargetDir })
          : (copyEntry(resolvedSource, targetPath), { targetPath });
        if (sourceWorkerAuthority) {
          mirrorWorkerProjectMutation(sourceWorkerAuthority, { kind: 'copy', sourceHostPath: resolvedSource, targetHostPath: copied.targetPath });
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
    if (!fs.existsSync(resolvedRoot) || !fs.statSync(resolvedRoot).isDirectory()) return res.status(404).json({ error: 'Root directory not found' });
    const results: any[] = [];
    const skip = new Set(['.git', 'node_modules', '.cache', 'dist']);
    const walk = (dir: string, depth: number) => {
      if (depth > 12 || results.length >= 500) return;
      for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
        if (skip.has(item.name) || (!req.query.showHidden && item.name.startsWith('.'))) continue;
        const fullPath = path.join(dir, item.name);
        if (item.name.toLowerCase().includes(query) || path.relative(resolvedRoot, fullPath).toLowerCase().includes(query)) {
          const stat = fs.statSync(fullPath);
          results.push({ name: item.name, path: fullPath, isDirectory: item.isDirectory(), size: item.isDirectory() ? undefined : stat.size, modified: stat.mtime.toISOString(), extension: item.isDirectory() ? undefined : path.extname(item.name).slice(1) });
          if (results.length >= 500) return;
        }
        if (item.isDirectory()) walk(fullPath, depth + 1);
      }
    };
    walk(resolvedRoot, 0);
    res.json({ results, truncated: results.length >= 500 });
  } catch (error: any) { res.status(500).json({ error: error.message }); }
});


export default router;

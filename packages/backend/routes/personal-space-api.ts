/**
 * Owns: authenticated HTTP API for user-owned Personal Space files.
 * Public API: mounted at /api/personal-space after authMiddleware.
 * See services/personal-space/README.md.
 */
import { Router } from 'express';
import multer from 'multer';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.js';
import {
  PersonalSpaceError,
  archivePersonalFile,
  createPersonalBinaryFileFromPath,
  createPersonalDirectory,
  createPersonalNote,
  ensurePersonalSpace,
  listArchivedPersonalFiles,
  listPersonalDirectory,
  listPersonalFiles,
  movePersonalEntry,
  readPersonalFile,
  resolvePersonalBinaryFile,
  renamePersonalFile,
  restorePersonalFile,
  writePersonalFile,
} from '../services/personal-space/personal-space-store.js';
import {
  importPersonalDocumentPreferences,
  listPersonalDocumentPreferences,
  recordPersonalDocumentOpened,
  setPersonalDocumentPinned,
} from '../services/personal-space/personal-document-preferences.js';
import {
  archivePersonalTodo,
  createPersonalTodo,
  listPersonalTodos,
  updatePersonalTodo,
} from '../services/personal-space/personal-todo-store.js';

const router = Router();
const personalUploadStagingDir = path.join(config.dataDir, 'upload-staging', 'personal-files');
const upload = multer({
  storage: multer.diskStorage({
    destination(_req, _file, cb) {
      fs.mkdir(personalUploadStagingDir, { recursive: true })
        .then(() => cb(null, personalUploadStagingDir))
        .catch(error => cb(error, personalUploadStagingDir));
    },
    filename(_req, _file, cb) { cb(null, `${Date.now()}-${crypto.randomUUID()}.upload`); },
  }),
  limits: { fileSize: 200 * 1024 * 1024, files: 20 },
});

function stagedPersonalFiles(req: any): Express.Multer.File[] {
  return Array.isArray(req.files) ? req.files as Express.Multer.File[] : [];
}

async function cleanupPersonalUploadStaging(req: any): Promise<void> {
  const root = path.resolve(personalUploadStagingDir) + path.sep;
  await Promise.all(stagedPersonalFiles(req)
    .filter(file => typeof file.path === 'string' && path.resolve(file.path).startsWith(root))
    .map(file => fs.rm(file.path, { force: true }).catch(() => undefined)));
}

function withPersonalUploadCleanup(req: any, res: any, next: (error?: unknown) => void) {
  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    void cleanupPersonalUploadStaging(req);
  };
  res.once('finish', cleanup);
  res.once('close', cleanup);
  next();
}

function userId(req: any): number {
  const value = req.user?.userId;
  if (!Number.isInteger(value) || value <= 0) throw new PersonalSpaceError('INVALID_PATH', 'Auth required');
  return value;
}

function errorStatus(error: unknown): number {
  if (!(error instanceof PersonalSpaceError)) return 500;
  if (error.message === 'Auth required') return 401;
  switch (error.code) {
    case 'INVALID_PATH': return 400;
    case 'NOT_FOUND': return 404;
    case 'CONFLICT': return 409;
    case 'TOO_LARGE': return 413;
  }
}

function sendError(res: any, error: unknown): void {
  const status = errorStatus(error);
  if (status >= 500) console.error('[personal-space] request failed:', error);
  res.status(status).json({ error: error instanceof Error ? error.message : 'Personal Space request failed' });
}

router.get('/todos', async (req, res) => {
  try {
    res.json({ todos: await listPersonalTodos(userId(req)) });
  } catch (error) {
    sendError(res, error);
  }
});

router.post('/todos', async (req, res) => {
  try {
    const title = typeof req.body?.title === 'string' ? req.body.title : '';
    const sourceSessionId = typeof req.body?.sourceSessionId === 'string' ? req.body.sourceSessionId : undefined;
    res.status(201).json(await createPersonalTodo(userId(req), title, sourceSessionId));
  } catch (error) {
    sendError(res, error);
  }
});

router.patch('/todos/:id', async (req, res) => {
  try {
    const patch: { title?: string; completed?: boolean } = {};
    if (typeof req.body?.title === 'string') patch.title = req.body.title;
    if (typeof req.body?.completed === 'boolean') patch.completed = req.body.completed;
    res.json(await updatePersonalTodo(userId(req), req.params.id, patch));
  } catch (error) {
    sendError(res, error);
  }
});

router.delete('/todos/:id', async (req, res) => {
  try {
    await archivePersonalTodo(userId(req), req.params.id);
    res.json({ ok: true });
  } catch (error) {
    sendError(res, error);
  }
});

router.get('/document-preferences', async (req, res) => {
  try {
    res.json(await listPersonalDocumentPreferences(userId(req)));
  } catch (error) { sendError(res, error); }
});

router.post('/document-preferences/opened', async (req, res) => {
  try {
    const uri = typeof req.body?.uri === 'string' ? req.body.uri : '';
    if (!uri) return res.status(400).json({ error: 'uri required' });
    res.json(await recordPersonalDocumentOpened(userId(req), uri));
  } catch (error) { sendError(res, error); }
});

router.put('/document-preferences/pinned', async (req, res) => {
  try {
    const uri = typeof req.body?.uri === 'string' ? req.body.uri : '';
    const pinned = req.body?.pinned;
    if (!uri || typeof pinned !== 'boolean') return res.status(400).json({ error: 'uri and pinned required' });
    res.json(await setPersonalDocumentPinned(userId(req), uri, pinned));
  } catch (error) { sendError(res, error); }
});

router.post('/document-preferences/import', async (req, res) => {
  try {
    const pinnedUris = Array.isArray(req.body?.pinnedUris) ? req.body.pinnedUris.filter((uri: unknown) => typeof uri === 'string') : [];
    const recentUris = Array.isArray(req.body?.recentUris) ? req.body.recentUris.filter((uri: unknown) => typeof uri === 'string') : [];
    res.json(await importPersonalDocumentPreferences(userId(req), pinnedUris, recentUris));
  } catch (error) { sendError(res, error); }
});

router.get('/files/directory', async (req, res) => {
  try {
    const requestedPath = typeof req.query.path === 'string' ? req.query.path : '';
    res.json(await listPersonalDirectory(userId(req), requestedPath));
  } catch (error) { sendError(res, error); }
});

router.post('/files/create-directory', async (req, res) => {
  try {
    const requestedPath = typeof req.body?.path === 'string' ? req.body.path : '';
    if (!requestedPath) return res.status(400).json({ error: 'path required' });
    res.status(201).json(await createPersonalDirectory(userId(req), requestedPath));
  } catch (error) { sendError(res, error); }
});

router.post('/files/move', async (req, res) => {
  try {
    const uri = typeof req.body?.uri === 'string' ? req.body.uri : '';
    const nextPath = typeof req.body?.nextPath === 'string' ? req.body.nextPath : '';
    if (!uri || !nextPath) return res.status(400).json({ error: 'uri and nextPath required' });
    res.json(await movePersonalEntry(userId(req), uri, nextPath));
  } catch (error) { sendError(res, error); }
});

router.get('/files/archived', async (req, res) => {
  try {
    res.json({ files: await listArchivedPersonalFiles(userId(req)) });
  } catch (error) {
    sendError(res, error);
  }
});

router.post('/files/:id/restore', async (req, res) => {
  try {
    res.json(await restorePersonalFile(userId(req), req.params.id));
  } catch (error) {
    sendError(res, error);
  }
});

router.get('/files', async (req, res) => {
  try {
    await ensurePersonalSpace(userId(req));
    res.json({ files: await listPersonalFiles(userId(req)) });
  } catch (error) {
    sendError(res, error);
  }
});

router.post('/files/upload', upload.array('files', 20), withPersonalUploadCleanup, async (req: any, res) => {
  const created: Array<{ uri: string }> = [];
  try {
    const ownerId = userId(req);
    const files = (req.files || []) as Express.Multer.File[];
    const directory = typeof req.body?.directory === 'string' && req.body.directory.trim() ? req.body.directory.trim().replace(/^personal:\/\//, '') : 'files';
    if (!files.length) return res.status(400).json({ error: 'No files provided' });
    const documents = [];
    for (const file of files) {
      file.originalname = Buffer.from(file.originalname, 'latin1').toString('utf8');
      const document = await createPersonalBinaryFileFromPath(ownerId, `${directory}/${file.originalname}`, file.path, file.mimetype);
      created.push(document);
      documents.push(document);
    }
    res.status(201).json({ files: documents });
  } catch (error) {
    // Each successful create is durable and visible; report partial results instead
    // of pretending an all-or-nothing filesystem transaction exists.
    if (created.length) return res.status(207).json({ files: created, error: error instanceof Error ? error.message : 'Some files failed' });
    sendError(res, error);
  }
});

router.get('/files/content', async (req, res) => {
  try {
    const uri = typeof req.query.uri === 'string' ? req.query.uri : '';
    if (!uri) return res.status(400).json({ error: 'uri required' });
    const item = await resolvePersonalBinaryFile(userId(req), uri);
    res.type(item.document.mimeType || 'application/octet-stream');
    res.setHeader('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(item.document.name)}`);
    res.sendFile(item.path);
  } catch (error) {
    sendError(res, error);
  }
});

router.get('/files/read', async (req, res) => {
  try {
    const uri = typeof req.query.uri === 'string' ? req.query.uri : '';
    if (!uri) return res.status(400).json({ error: 'uri required' });
    res.json(await readPersonalFile(userId(req), uri));
  } catch (error) {
    sendError(res, error);
  }
});

router.post('/files/create-note', async (req, res) => {
  try {
    const requestedPath = typeof req.body?.path === 'string' ? req.body.path : undefined;
    const content = typeof req.body?.content === 'string' ? req.body.content : '';
    res.status(201).json(await createPersonalNote(userId(req), requestedPath, content));
  } catch (error) {
    sendError(res, error);
  }
});

router.put('/files/write', async (req, res) => {
  try {
    const uri = typeof req.body?.uri === 'string' ? req.body.uri : '';
    const content = typeof req.body?.content === 'string' ? req.body.content : undefined;
    const expectedVersion = Number.isInteger(req.body?.expectedVersion) ? req.body.expectedVersion : undefined;
    if (!uri || content === undefined) return res.status(400).json({ error: 'uri and content required' });
    res.json(await writePersonalFile(userId(req), uri, content, expectedVersion));
  } catch (error) {
    sendError(res, error);
  }
});

router.post('/files/rename', async (req, res) => {
  try {
    const uri = typeof req.body?.uri === 'string' ? req.body.uri : '';
    const nextPath = typeof req.body?.nextPath === 'string' ? req.body.nextPath : '';
    if (!uri || !nextPath) return res.status(400).json({ error: 'uri and nextPath required' });
    res.json(await renamePersonalFile(userId(req), uri, nextPath));
  } catch (error) {
    sendError(res, error);
  }
});

router.post('/files/archive', async (req, res) => {
  try {
    const uri = typeof req.body?.uri === 'string' ? req.body.uri : '';
    if (!uri) return res.status(400).json({ error: 'uri required' });
    await archivePersonalFile(userId(req), uri);
    res.json({ ok: true });
  } catch (error) {
    sendError(res, error);
  }
});

export default router;

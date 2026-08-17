/**
 * Owns: 사용자별 Personal Space 파일 저장과 `personal_files` 메타데이터.
 * Public API: ensurePersonalSpace, listPersonalFiles, listPersonalDirectory, createPersonalDirectory,
 * createPersonalNote, createPersonalBinaryFile, resolvePersonalBinaryFile, readPersonalFile, writePersonalFile,
 * appendToPersonalInbox, movePersonalEntry, renamePersonalFile, archivePersonalFile, listArchivedPersonalFiles,
 * restorePersonalFile.
 * See README.md.
 */
import crypto from 'crypto';
import path from 'path';
import fs from 'fs/promises';
import { constants as fsConstants, createReadStream, createWriteStream } from 'fs';
import { pipeline } from 'stream/promises';
// @ts-ignore -- proper-lockfile does not ship TypeScript declarations.
import lockfile from 'proper-lockfile';
import { config } from '../../config.js';
import { execute, query, queryOne, transaction, withClient } from '../../db/pg-repo.js';

const PERSONAL_URI_PREFIX = 'personal://';
const DEFAULT_INBOX_PATH = 'notes/inbox.md';
const MAX_NOTE_BYTES = 10 * 1024 * 1024;
const MAX_PERSONAL_FILE_BYTES = 200 * 1024 * 1024;

export interface PersonalFileRow {
  id: string;
  owner_user_id: number;
  relative_path: string;
  kind: 'note' | 'file';
  mime_type: string | null;
  size_bytes: number;
  content_sha256: string;
  version: number;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

export interface PersonalDirectoryEntry {
  id: string;
  uri: string;
  relativePath: string;
  name: string;
  kind: 'directory' | 'note' | 'file';
  mimeType: string | null;
  sizeBytes: number;
  version: number;
  updatedAt: string;
}

export interface PersonalFileDocument {
  id: string;
  uri: string;
  relativePath: string;
  name: string;
  kind: 'note' | 'file';
  mimeType: string | null;
  sizeBytes: number;
  version: number;
  content: string;
  updatedAt: string;
}

export class PersonalSpaceError extends Error {
  constructor(public code: 'INVALID_PATH' | 'NOT_FOUND' | 'CONFLICT' | 'TOO_LARGE', message: string) {
    super(message);
    this.name = 'PersonalSpaceError';
  }
}

/** Resolve the user-owned storage root. Never expose this path outside this module. */
export function personalFilesRoot(userId: number): string {
  if (!Number.isInteger(userId) || userId <= 0) throw new PersonalSpaceError('INVALID_PATH', 'Invalid user');
  return path.join(config.dataDir, 'personal-spaces', String(userId), 'files');
}

/** Convert a virtual URI or relative path into one canonical safe relative path. */
export function normalizePersonalPath(input: string): string {
  if (typeof input !== 'string' || !input.trim()) throw new PersonalSpaceError('INVALID_PATH', 'Personal file path required');
  let value = input.trim();
  if (value.startsWith(PERSONAL_URI_PREFIX)) value = value.slice(PERSONAL_URI_PREFIX.length);
  value = value.replace(/\\/g, '/');
  if (value.startsWith('/')) throw new PersonalSpaceError('INVALID_PATH', 'Personal file path must be relative');
  value = value.replace(/\/{2,}/g, '/');
  const normalized = path.posix.normalize(value);
  if (!normalized || normalized === '.' || normalized === '..' || normalized.startsWith('../') || path.posix.isAbsolute(normalized)) {
    throw new PersonalSpaceError('INVALID_PATH', 'Invalid personal file path');
  }
  const segments = normalized.split('/');
  if (segments.some((segment) => !segment || segment === '.' || segment === '..' || segment.includes('\0'))) {
    throw new PersonalSpaceError('INVALID_PATH', 'Invalid personal file path');
  }
  return normalized;
}

/** Return the stable user-facing URI for a personal file. */
export function toPersonalUri(relativePath: string): string {
  return `${PERSONAL_URI_PREFIX}${normalizePersonalPath(relativePath)}`;
}

/** Build one inbox append payload while preserving a single date heading. */
export function buildInboxAppendContent(
  currentContent: string,
  text: string,
  checklist: boolean,
  date: string,
): string {
  let next = currentContent;
  if (!next.endsWith('\n')) next += '\n';
  const heading = `## ${date}`;
  const item = `- ${checklist ? '[ ] ' : ''}${text}`;
  if (!next.includes(`${heading}\n`) && !next.endsWith(heading)) next += `\n${heading}\n\n`;
  return `${next}${item}\n`;
}

function normalizeDirectoryPath(input?: string): string {
  const value = String(input || '').trim();
  if (!value || value === PERSONAL_URI_PREFIX) return '';
  return normalizePersonalPath(value);
}

async function resolveDirectoryPath(userId: number, input?: string, allowMissing = false): Promise<string> {
  const root = personalFilesRoot(userId);
  const relativePath = normalizeDirectoryPath(input);
  const candidate = relativePath ? path.resolve(root, ...relativePath.split('/')) : path.resolve(root);
  const resolvedRoot = path.resolve(root);
  if (candidate !== resolvedRoot && !candidate.startsWith(`${resolvedRoot}${path.sep}`)) {
    throw new PersonalSpaceError('INVALID_PATH', 'Directory escapes personal storage');
  }
  if (!allowMissing) {
    const stat = await fs.lstat(candidate).catch(() => null);
    if (!stat?.isDirectory() || stat.isSymbolicLink()) throw new PersonalSpaceError('NOT_FOUND', 'Personal folder not found');
  }
  return candidate;
}

function sha256(content: string | Buffer): string {
  return crypto.createHash('sha256').update(content).digest('hex');
}

function assertMarkdownPath(relativePath: string): void {
  if (!relativePath.toLowerCase().endsWith('.md')) {
    throw new PersonalSpaceError('INVALID_PATH', 'Personal note must use the .md extension');
  }
}

async function resolveStoragePath(userId: number, relativePath: string, allowMissing = false): Promise<string> {
  const root = personalFilesRoot(userId);
  const normalized = normalizePersonalPath(relativePath);
  const candidate = path.resolve(root, ...normalized.split('/'));
  const resolvedRoot = path.resolve(root);
  if (!candidate.startsWith(`${resolvedRoot}${path.sep}`)) throw new PersonalSpaceError('INVALID_PATH', 'Path escapes personal storage');

  await fs.mkdir(path.dirname(candidate), { recursive: true });
  const realRoot = await fs.realpath(root).catch(async () => {
    await fs.mkdir(root, { recursive: true });
    return fs.realpath(root);
  });
  const realParent = await fs.realpath(path.dirname(candidate));
  if (realParent !== realRoot && !realParent.startsWith(`${realRoot}${path.sep}`)) {
    throw new PersonalSpaceError('INVALID_PATH', 'Symlink escapes personal storage');
  }
  try {
    const stat = await fs.lstat(candidate);
    if (stat.isSymbolicLink()) throw new PersonalSpaceError('INVALID_PATH', 'Personal files cannot be symlinks');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  if (!allowMissing) {
    await fs.access(candidate, fsConstants.R_OK).catch(() => { throw new PersonalSpaceError('NOT_FOUND', 'Personal file not found'); });
  }
  return candidate;
}

async function upsertMetadata(userId: number, relativePath: string, content: string): Promise<PersonalFileRow> {
  const bytes = Buffer.byteLength(content, 'utf8');
  const digest = sha256(content);
  const row = await queryOne<PersonalFileRow>(
    `INSERT INTO personal_files
       (owner_user_id, relative_path, kind, mime_type, size_bytes, content_sha256)
     VALUES ($1, $2, 'note', 'text/markdown', $3, $4)
     ON CONFLICT (owner_user_id, relative_path) WHERE deleted_at IS NULL
     DO UPDATE SET size_bytes = EXCLUDED.size_bytes,
                   content_sha256 = EXCLUDED.content_sha256,
                   version = personal_files.version + 1,
                   updated_at = NOW()
     RETURNING *`,
    [userId, relativePath, bytes, digest],
  );
  if (!row) throw new Error('Failed to persist personal file metadata');
  return row;
}

/** Create the user directory and the default notes/inbox.md once. */
export async function ensurePersonalSpace(userId: number): Promise<PersonalFileRow> {
  const root = personalFilesRoot(userId);
  await fs.mkdir(path.join(root, 'notes'), { recursive: true });
  await fs.mkdir(path.join(root, 'files'), { recursive: true });
  await fs.mkdir(path.join(root, 'archive'), { recursive: true });

  const existing = await queryOne<PersonalFileRow>(
    `SELECT * FROM personal_files WHERE owner_user_id = $1 AND relative_path = $2 AND deleted_at IS NULL`,
    [userId, DEFAULT_INBOX_PATH],
  );
  const inboxPath = await resolveStoragePath(userId, DEFAULT_INBOX_PATH, true);
  const defaultContent = '# Inbox\n\n';
  try {
    await fs.access(inboxPath);
  } catch {
    await fs.writeFile(inboxPath, defaultContent, { encoding: 'utf8', flag: 'wx' }).catch((err: NodeJS.ErrnoException) => {
      if (err.code !== 'EEXIST') throw err;
    });
  }
  if (existing) return existing;
  const content = await fs.readFile(inboxPath, 'utf8');
  return upsertMetadata(userId, DEFAULT_INBOX_PATH, content);
}

/** List active personal files owned by one user. */
export async function listPersonalFiles(userId: number): Promise<Array<Omit<PersonalFileDocument, 'content'>>> {
  await ensurePersonalSpace(userId);
  const rows = await query<PersonalFileRow>(
    `SELECT * FROM personal_files WHERE owner_user_id = $1 AND deleted_at IS NULL ORDER BY updated_at DESC, relative_path`,
    [userId],
  );
  return rows.map((row) => ({
    id: row.id,
    uri: toPersonalUri(row.relative_path),
    relativePath: row.relative_path,
    name: path.posix.basename(row.relative_path),
    kind: row.kind,
    mimeType: row.mime_type,
    sizeBytes: Number(row.size_bytes),
    version: Number(row.version),
    updatedAt: row.updated_at,
  }));
}

/** List one Personal Space directory without exposing its host path. */
export async function listPersonalDirectory(userId: number, input?: string): Promise<{ path: string; entries: PersonalDirectoryEntry[] }> {
  await ensurePersonalSpace(userId);
  const directory = normalizeDirectoryPath(input);
  const directoryPath = await resolveDirectoryPath(userId, directory);
  const children = await fs.readdir(directoryPath, { withFileTypes: true });
  const prefix = directory ? `${directory}/` : '';
  const rows = await query<PersonalFileRow>(
    `SELECT * FROM personal_files WHERE owner_user_id = $1 AND deleted_at IS NULL AND relative_path LIKE $2 ORDER BY relative_path`,
    [userId, `${prefix}%`],
  );
  const directRows = new Map(rows.filter(row => !row.relative_path.slice(prefix.length).includes('/')).map(row => [row.relative_path, row]));
  const entries: PersonalDirectoryEntry[] = [];
  for (const child of children) {
    if (child.isSymbolicLink()) continue;
    const relativePath = `${prefix}${child.name}`;
    if (child.isDirectory()) {
      const stat = await fs.stat(path.join(directoryPath, child.name));
      entries.push({ id: `directory:${relativePath}`, uri: `${PERSONAL_URI_PREFIX}${relativePath}`, relativePath, name: child.name, kind: 'directory', mimeType: null, sizeBytes: 0, version: 1, updatedAt: stat.mtime.toISOString() });
      continue;
    }
    const row = directRows.get(relativePath);
    if (!row) continue;
    entries.push({ id: row.id, uri: toPersonalUri(row.relative_path), relativePath: row.relative_path, name: child.name, kind: row.kind, mimeType: row.mime_type, sizeBytes: Number(row.size_bytes), version: Number(row.version), updatedAt: row.updated_at });
  }
  entries.sort((a, b) => a.kind === 'directory' && b.kind !== 'directory' ? -1 : a.kind !== 'directory' && b.kind === 'directory' ? 1 : a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));
  return { path: directory, entries };
}

/** Create one empty owner-only folder. */
export async function createPersonalDirectory(userId: number, input: string): Promise<PersonalDirectoryEntry> {
  await ensurePersonalSpace(userId);
  const relativePath = normalizePersonalPath(input);
  const destination = await resolveDirectoryPath(userId, relativePath, true);
  await fs.mkdir(destination, { recursive: false }).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'EEXIST') throw new PersonalSpaceError('CONFLICT', 'A personal folder already exists at this path');
    if (error.code === 'ENOENT') throw new PersonalSpaceError('NOT_FOUND', 'Parent folder not found');
    throw error;
  });
  const stat = await fs.stat(destination);
  return { id: `directory:${relativePath}`, uri: `${PERSONAL_URI_PREFIX}${relativePath}`, relativePath, name: path.posix.basename(relativePath), kind: 'directory', mimeType: null, sizeBytes: 0, version: 1, updatedAt: stat.mtime.toISOString() };
}

/** Read one owner-scoped personal file by virtual URI or relative path. */
export async function readPersonalFile(userId: number, input: string): Promise<PersonalFileDocument> {
  await ensurePersonalSpace(userId);
  const relativePath = normalizePersonalPath(input);
  const row = await queryOne<PersonalFileRow>(
    `SELECT * FROM personal_files WHERE owner_user_id = $1 AND relative_path = $2 AND deleted_at IS NULL`,
    [userId, relativePath],
  );
  if (!row) throw new PersonalSpaceError('NOT_FOUND', 'Personal file not found');
  const storagePath = await resolveStoragePath(userId, relativePath);
  if (row.kind !== 'note') throw new PersonalSpaceError('INVALID_PATH', 'Binary personal files must be opened through the file content endpoint');
  const content = await fs.readFile(storagePath, 'utf8');
  return {
    id: row.id,
    uri: toPersonalUri(relativePath),
    relativePath,
    name: path.posix.basename(relativePath),
    kind: row.kind,
    mimeType: row.mime_type,
    sizeBytes: Buffer.byteLength(content, 'utf8'),
    version: Number(row.version),
    content,
    updatedAt: row.updated_at,
  };
}

/** Resolve an owner-scoped binary file for authenticated download/preview. */
export async function resolvePersonalBinaryFile(userId: number, input: string): Promise<{ document: Omit<PersonalFileDocument, 'content'>; path: string }> {
  await ensurePersonalSpace(userId);
  const relativePath = normalizePersonalPath(input);
  const row = await queryOne<PersonalFileRow>(
    `SELECT * FROM personal_files WHERE owner_user_id = $1 AND relative_path = $2 AND deleted_at IS NULL`,
    [userId, relativePath],
  );
  if (!row) throw new PersonalSpaceError('NOT_FOUND', 'Personal file not found');
  if (row.kind !== 'file') throw new PersonalSpaceError('INVALID_PATH', 'Personal note is not a binary file');
  return {
    document: {
      id: row.id,
      uri: toPersonalUri(row.relative_path),
      relativePath: row.relative_path,
      name: path.posix.basename(row.relative_path),
      kind: row.kind,
      mimeType: row.mime_type,
      sizeBytes: Number(row.size_bytes),
      version: Number(row.version),
      updatedAt: row.updated_at,
    },
    path: await resolveStoragePath(userId, relativePath),
  };
}

/** Stream a staged binary artifact into owner-only Personal Space without holding it in request RAM. */
export async function createPersonalBinaryFileFromPath(userId: number, requestedPath: string, sourcePath: string, mimeType?: string | null): Promise<Omit<PersonalFileDocument, 'content'>> {
  const sourceStat = await fs.stat(sourcePath).catch(() => null);
  if (!sourceStat?.isFile()) throw new PersonalSpaceError('INVALID_PATH', 'Personal upload source must be a regular file');
  if (sourceStat.size > MAX_PERSONAL_FILE_BYTES) throw new PersonalSpaceError('TOO_LARGE', 'Personal file is too large');
  await ensurePersonalSpace(userId);
  let relativePath = normalizePersonalPath(requestedPath);
  if (relativePath.startsWith('notes/')) relativePath = `files/${path.posix.basename(relativePath)}`;
  let destination = await resolveStoragePath(userId, relativePath, true);
  try {
    await fs.access(destination);
    const ext = path.posix.extname(relativePath);
    const stem = path.posix.basename(relativePath, ext);
    const parent = path.posix.dirname(relativePath);
    relativePath = normalizePersonalPath(`${parent === '.' ? 'files' : parent}/${stem}-${Date.now()}-${crypto.randomUUID().slice(0, 8)}${ext}`);
    destination = await resolveStoragePath(userId, relativePath, true);
  } catch {}
  await fs.mkdir(path.dirname(destination), { recursive: true });
  const temporaryDestination = `${destination}.tower-upload-${crypto.randomUUID()}.tmp`;
  const hash = crypto.createHash('sha256');
  const source = createReadStream(sourcePath);
  source.on('data', chunk => hash.update(chunk));
  try {
    await pipeline(source, createWriteStream(temporaryDestination, { flags: 'wx', mode: 0o600 }));
    await fs.rename(temporaryDestination, destination);
    const row = await queryOne<PersonalFileRow>(
      `INSERT INTO personal_files (owner_user_id, relative_path, kind, mime_type, size_bytes, content_sha256)
       VALUES ($1,$2,'file',$3,$4,$5) RETURNING *`,
      [userId, relativePath, mimeType || null, sourceStat.size, hash.digest('hex')],
    );
    if (!row) throw new Error('Personal file metadata insert failed');
    return {
      id: row.id,
      uri: toPersonalUri(row.relative_path),
      relativePath: row.relative_path,
      name: path.posix.basename(row.relative_path),
      kind: row.kind,
      mimeType: row.mime_type,
      sizeBytes: Number(row.size_bytes),
      version: Number(row.version),
      updatedAt: row.updated_at,
    };
  } catch (error) {
    await fs.rm(temporaryDestination, { force: true }).catch(() => undefined);
    await fs.rm(destination, { force: true }).catch(() => undefined);
    throw error;
  }
}

/** Copy a binary artifact into owner-only Personal Space without exposing its host path. */
export async function createPersonalBinaryFile(userId: number, requestedPath: string, content: Buffer, mimeType?: string | null): Promise<Omit<PersonalFileDocument, 'content'>> {
  if (content.length > MAX_PERSONAL_FILE_BYTES) throw new PersonalSpaceError('TOO_LARGE', 'Personal file is too large');
  await ensurePersonalSpace(userId);
  let relativePath = normalizePersonalPath(requestedPath);
  if (relativePath.startsWith('notes/')) relativePath = `files/${path.posix.basename(relativePath)}`;
  let destination = await resolveStoragePath(userId, relativePath, true);
  try {
    await fs.access(destination);
    const ext = path.posix.extname(relativePath);
    const stem = path.posix.basename(relativePath, ext);
    const parent = path.posix.dirname(relativePath);
    relativePath = normalizePersonalPath(`${parent === '.' ? 'files' : parent}/${stem}-${Date.now()}${ext}`);
    destination = await resolveStoragePath(userId, relativePath, true);
  } catch {}
  await fs.mkdir(path.dirname(destination), { recursive: true });
  await fs.writeFile(destination, content, { flag: 'wx', mode: 0o600 });
  const digest = sha256(content);
  const row = await queryOne<PersonalFileRow>(
    `INSERT INTO personal_files (owner_user_id, relative_path, kind, mime_type, size_bytes, content_sha256)
     VALUES ($1,$2,'file',$3,$4,$5) RETURNING *`,
    [userId, relativePath, mimeType || null, content.length, digest],
  );
  if (!row) {
    await fs.rm(destination, { force: true });
    throw new Error('Personal file metadata insert failed');
  }
  return {
    id: row.id,
    uri: toPersonalUri(row.relative_path),
    relativePath: row.relative_path,
    name: path.posix.basename(row.relative_path),
    kind: row.kind,
    mimeType: row.mime_type,
    sizeBytes: Number(row.size_bytes),
    version: Number(row.version),
    updatedAt: row.updated_at,
  };
}

/** Create a uniquely named Markdown note and return it opened-ready. */
export async function createPersonalNote(userId: number, requestedPath?: string, content = ''): Promise<PersonalFileDocument> {
  await ensurePersonalSpace(userId);
  const fallback = `notes/새 노트 ${new Date().toISOString().replace(/[:T.]/g, '-').replace('Z', '')}.md`;
  const relativePath = normalizePersonalPath(requestedPath || fallback);
  assertMarkdownPath(relativePath);
  if (Buffer.byteLength(content, 'utf8') > MAX_NOTE_BYTES) throw new PersonalSpaceError('TOO_LARGE', 'Personal note is too large');
  const exists = await queryOne<{ id: string }>(
    `SELECT id FROM personal_files WHERE owner_user_id = $1 AND relative_path = $2 AND deleted_at IS NULL`,
    [userId, relativePath],
  );
  if (exists) throw new PersonalSpaceError('CONFLICT', 'A personal file already exists at this path');
  const storagePath = await resolveStoragePath(userId, relativePath, true);
  await fs.writeFile(storagePath, content, { encoding: 'utf8', flag: 'wx' }).catch((err: NodeJS.ErrnoException) => {
    if (err.code === 'EEXIST') throw new PersonalSpaceError('CONFLICT', 'A personal file already exists at this path');
    throw err;
  });
  try {
    await upsertMetadata(userId, relativePath, content);
  } catch (error) {
    await fs.unlink(storagePath).catch(() => undefined);
    throw error;
  }
  return readPersonalFile(userId, relativePath);
}

/** Replace a personal Markdown note, optionally guarding against stale editors. */
export async function writePersonalFile(userId: number, input: string, content: string, expectedVersion?: number): Promise<PersonalFileDocument> {
  const relativePath = normalizePersonalPath(input);
  assertMarkdownPath(relativePath);
  if (Buffer.byteLength(content, 'utf8') > MAX_NOTE_BYTES) throw new PersonalSpaceError('TOO_LARGE', 'Personal note is too large');
  const storagePath = await resolveStoragePath(userId, relativePath);
  const release = await lockfile.lock(storagePath, {
    realpath: true,
    retries: { retries: 30, minTimeout: 5, maxTimeout: 100, factor: 1.25 },
  });
  try {
    const previousContent = await fs.readFile(storagePath, 'utf8');
    await transaction(async (client) => {
      const repo = withClient(client);
      const row = await repo.queryOne<PersonalFileRow>(
        `SELECT * FROM personal_files
         WHERE owner_user_id = $1 AND relative_path = $2 AND deleted_at IS NULL
         FOR UPDATE`,
        [userId, relativePath],
      );
      if (!row) throw new PersonalSpaceError('NOT_FOUND', 'Personal file not found');
      if (expectedVersion != null && Number(row.version) !== expectedVersion) {
        throw new PersonalSpaceError('CONFLICT', 'Personal file changed in another editor');
      }

      const tempPath = `${storagePath}.tower-${crypto.randomUUID()}.tmp`;
      await fs.writeFile(tempPath, content, 'utf8');
      await fs.rename(tempPath, storagePath);
      try {
        const result = await repo.execute(
          `UPDATE personal_files
           SET size_bytes = $3, content_sha256 = $4, version = version + 1, updated_at = NOW()
           WHERE id = $1 AND owner_user_id = $2 AND deleted_at IS NULL`,
          [row.id, userId, Buffer.byteLength(content, 'utf8'), sha256(content)],
        );
        if (result.changes !== 1) throw new Error('Personal file metadata write failed');
      } catch (error) {
        await fs.writeFile(storagePath, previousContent, 'utf8').catch(() => undefined);
        throw error;
      }
    });
  } finally {
    await release();
  }
  return readPersonalFile(userId, relativePath);
}

/** Append a dated bullet or checklist item to the personal inbox with optimistic retry. */
export async function appendToPersonalInbox(
  userId: number,
  text: string,
  checklist = false,
): Promise<PersonalFileDocument> {
  const clean = text.replace(/\r?\n+/g, ' ').trim();
  if (!clean) throw new PersonalSpaceError('INVALID_PATH', 'Note text required');
  if (clean.length > 4000) throw new PersonalSpaceError('TOO_LARGE', 'Note text is too long');

  await ensurePersonalSpace(userId);
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const current = await readPersonalFile(userId, DEFAULT_INBOX_PATH);
    const date = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(new Date());
    const next = buildInboxAppendContent(current.content, clean, checklist, date);
    try {
      return await writePersonalFile(userId, current.uri, next, current.version);
    } catch (error) {
      if (!(error instanceof PersonalSpaceError) || error.code !== 'CONFLICT' || attempt === 4) throw error;
    }
  }
  throw new PersonalSpaceError('CONFLICT', 'Personal inbox changed repeatedly; try again');
}

/** Move or rename one personal file while preserving its kind and owner metadata. */
export async function movePersonalEntry(userId: number, input: string, nextInput: string): Promise<Omit<PersonalFileDocument, 'content'>> {
  const from = normalizePersonalPath(input);
  const to = normalizePersonalPath(nextInput);
  const source = await queryOne<PersonalFileRow>(
    `SELECT * FROM personal_files WHERE owner_user_id = $1 AND relative_path = $2 AND deleted_at IS NULL`,
    [userId, from],
  );
  if (!source) throw new PersonalSpaceError('NOT_FOUND', 'Personal file not found');
  const collision = await queryOne<{ id: string }>(
    `SELECT id FROM personal_files WHERE owner_user_id = $1 AND relative_path = $2 AND deleted_at IS NULL`,
    [userId, to],
  );
  if (collision) throw new PersonalSpaceError('CONFLICT', 'A personal file already exists at the destination');
  const fromPath = await resolveStoragePath(userId, from);
  const toPath = await resolveStoragePath(userId, to, true);
  await fs.rename(fromPath, toPath);
  try {
    const result = await execute(
      `UPDATE personal_files SET relative_path = $3, version = version + 1, updated_at = NOW()
       WHERE id = $1 AND owner_user_id = $2 AND deleted_at IS NULL`,
      [source.id, userId, to],
    );
    if (result.changes !== 1) throw new Error('Personal file metadata rename failed');
  } catch (error) {
    await fs.rename(toPath, fromPath).catch(() => undefined);
    throw error;
  }
  const moved = await queryOne<PersonalFileRow>(
    `SELECT * FROM personal_files WHERE id = $1 AND owner_user_id = $2 AND deleted_at IS NULL`,
    [source.id, userId],
  );
  if (!moved) throw new Error('Personal file metadata missing after move');
  return { id: moved.id, uri: toPersonalUri(moved.relative_path), relativePath: moved.relative_path, name: path.posix.basename(moved.relative_path), kind: moved.kind, mimeType: moved.mime_type, sizeBytes: Number(moved.size_bytes), version: Number(moved.version), updatedAt: moved.updated_at };
}

/** Backward-compatible note rename entry point. */
export async function renamePersonalFile(userId: number, input: string, nextInput: string): Promise<PersonalFileDocument> {
  const from = normalizePersonalPath(input);
  const to = normalizePersonalPath(nextInput);
  assertMarkdownPath(from);
  assertMarkdownPath(to);
  await movePersonalEntry(userId, from, to);
  return readPersonalFile(userId, to);
}

/** List archived personal files without exposing their storage location. */
export async function listArchivedPersonalFiles(userId: number): Promise<Array<Omit<PersonalFileDocument, 'content'>>> {
  await ensurePersonalSpace(userId);
  const rows = await query<PersonalFileRow>(
    `SELECT * FROM personal_files WHERE owner_user_id = $1 AND deleted_at IS NOT NULL ORDER BY deleted_at DESC, relative_path`,
    [userId],
  );
  return rows.map((row) => ({
    id: row.id,
    uri: toPersonalUri(row.relative_path),
    relativePath: row.relative_path,
    name: path.posix.basename(row.relative_path),
    kind: row.kind,
    mimeType: row.mime_type,
    sizeBytes: Number(row.size_bytes),
    version: Number(row.version),
    updatedAt: row.updated_at,
  }));
}

/** Soft-delete metadata and move the file into a deterministic owner-only archive location. */
export async function archivePersonalFile(userId: number, input: string): Promise<void> {
  const relativePath = normalizePersonalPath(input);
  const row = await queryOne<PersonalFileRow>(
    `SELECT * FROM personal_files WHERE owner_user_id = $1 AND relative_path = $2 AND deleted_at IS NULL`,
    [userId, relativePath],
  );
  if (!row) throw new PersonalSpaceError('NOT_FOUND', 'Personal file not found');
  const sourcePath = await resolveStoragePath(userId, relativePath);
  const archivedRelative = normalizePersonalPath(`archive/${row.id}/${relativePath}`);
  const archivedPath = await resolveStoragePath(userId, archivedRelative, true);
  await fs.mkdir(path.dirname(archivedPath), { recursive: true });
  await fs.rename(sourcePath, archivedPath);
  try {
    const result = await execute(
      `UPDATE personal_files SET deleted_at = NOW(), updated_at = NOW() WHERE id = $1 AND owner_user_id = $2`,
      [row.id, userId],
    );
    if (result.changes !== 1) throw new Error('Personal file metadata archive failed');
  } catch (error) {
    await fs.rename(archivedPath, sourcePath).catch(() => undefined);
    throw error;
  }
}

async function resolveArchivedStoragePath(userId: number, row: PersonalFileRow): Promise<string> {
  const deterministic = normalizePersonalPath(`archive/${row.id}/${row.relative_path}`);
  try {
    return await resolveStoragePath(userId, deterministic);
  } catch (error) {
    if (!(error instanceof PersonalSpaceError) || error.code !== 'NOT_FOUND') throw error;
  }
  // Compatibility with files archived before deterministic archive paths were introduced.
  const archiveRoot = await resolveDirectoryPath(userId, 'archive');
  const suffix = `-${path.posix.basename(row.relative_path)}`;
  const legacy = (await fs.readdir(archiveRoot, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && entry.name.endsWith(suffix))
    .sort((a, b) => b.name.localeCompare(a.name))[0];
  if (!legacy) throw new PersonalSpaceError('NOT_FOUND', 'Archived personal file content not found');
  return path.join(archiveRoot, legacy.name);
}

/** Restore one archived file to its original logical path. */
export async function restorePersonalFile(userId: number, fileId: string): Promise<Omit<PersonalFileDocument, 'content'>> {
  const row = await queryOne<PersonalFileRow>(
    `SELECT * FROM personal_files WHERE id = $1 AND owner_user_id = $2 AND deleted_at IS NOT NULL`,
    [fileId, userId],
  );
  if (!row) throw new PersonalSpaceError('NOT_FOUND', 'Archived personal file not found');
  const collision = await queryOne<{ id: string }>(
    `SELECT id FROM personal_files WHERE owner_user_id = $1 AND relative_path = $2 AND deleted_at IS NULL`,
    [userId, row.relative_path],
  );
  if (collision) throw new PersonalSpaceError('CONFLICT', 'A personal file already exists at the restore location');

  const archivedPath = await resolveArchivedStoragePath(userId, row);
  const destination = await resolveStoragePath(userId, row.relative_path, true);
  await fs.mkdir(path.dirname(destination), { recursive: true });
  await fs.rename(archivedPath, destination);
  try {
    const result = await execute(
      `UPDATE personal_files SET deleted_at = NULL, version = version + 1, updated_at = NOW() WHERE id = $1 AND owner_user_id = $2 AND deleted_at IS NOT NULL`,
      [row.id, userId],
    );
    if (result.changes !== 1) throw new Error('Personal file metadata restore failed');
  } catch (error) {
    await fs.mkdir(path.dirname(archivedPath), { recursive: true });
    await fs.rename(destination, archivedPath).catch(() => undefined);
    throw error;
  }
  const restored = await queryOne<PersonalFileRow>(
    `SELECT * FROM personal_files WHERE id = $1 AND owner_user_id = $2 AND deleted_at IS NULL`,
    [row.id, userId],
  );
  if (!restored) throw new Error('Personal file metadata missing after restore');
  return { id: restored.id, uri: toPersonalUri(restored.relative_path), relativePath: restored.relative_path, name: path.posix.basename(restored.relative_path), kind: restored.kind, mimeType: restored.mime_type, sizeBytes: Number(restored.size_bytes), version: Number(restored.version), updatedAt: restored.updated_at };
}

/**
 * Owns: Project file authority seam for Worker-first Projects.
 * Public API: resolve authority and read/write/mkdir/delete/rename/copy/list/exists via Worker root.
 *
 * HTTP file APIs still authorize against the host-shaped Project path, then apply the
 * same relative operation to Worker-local persistent storage when workstation_mode=true.
 */

import fs from 'node:fs';
import path from 'node:path';
import { query } from '../../db/pg-repo.js';
import { getPersistedWorkbenchWorker } from './workbench-worker-repository.js';
import { resolveWorkbenchWorkerTransportToken } from './workbench-worker-transport-credentials.js';
import { createRemoteWorkbenchHttpTransport } from './workbench-remote-http-transport.js';

const BINARY_EXTENSIONS = new Set(['bin', 'pdf', 'png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'ico', 'svg', 'mp4', 'webm', 'docx', 'doc', 'xlsx', 'xls', 'pptx', 'ppt', 'hwp', 'hwpx', 'db', 'sqlite', 'sqlite3', 'dxf', 'dwg']);

const LANGUAGE_MAP: Record<string, string> = {
  ts: 'typescript', tsx: 'typescript', js: 'javascript', jsx: 'javascript',
  py: 'python', md: 'markdown', markdown: 'markdown', json: 'json', yaml: 'yaml', yml: 'yaml',
  html: 'html', htm: 'html', css: 'css', sh: 'shell', bash: 'shell',
  sql: 'sql', rs: 'rust', go: 'go', java: 'java',
  txt: 'text', rst: 'text', org: 'text', csv: 'csv', tsv: 'csv', ipynb: 'json', log: 'text', bin: 'binary',
  pdf: 'pdf',
  png: 'image', jpg: 'image', jpeg: 'image', gif: 'image', webp: 'image', bmp: 'image', ico: 'image', svg: 'image',
  mp4: 'video', webm: 'video',
  docx: 'docx', doc: 'docx', xlsx: 'xlsx', xls: 'xlsx', pptx: 'pptx', ppt: 'pptx', hwp: 'hwp', hwpx: 'hwp',
  db: 'sqlite', sqlite: 'sqlite', sqlite3: 'sqlite', dxf: 'cad', dwg: 'cad',
};

type WorkstationProjectRow = {
  project_id: string;
  root_path: string;
  default_worker_id: string;
};

export interface WorkerFileAuthority {
  projectId: string;
  projectRoot: string;
  relativePath: string;
  workerId: string;
  workerBaseUrl: string;
}

export interface WorkerReadFileResult {
  content: string;
  language: string;
  encoding?: string;
}

export interface WorkerProjectManifestEntry {
  path: string;
  type: 'file' | 'directory';
  sizeBytes?: number;
  modified: string;
  sha256?: string;
}

export interface WorkerProjectManifest {
  entries: WorkerProjectManifestEntry[];
  fileCount: number;
  totalBytes: number;
}

export interface WorkerFileTreeEntry {
  name: string;
  path: string;
  isDirectory: boolean;
  modified?: string;
  size?: number;
  extension?: string;
}

function isInsidePath(root: string, candidate: string): boolean {
  const resolvedRoot = path.resolve(root);
  const resolvedCandidate = path.resolve(candidate);
  return resolvedCandidate === resolvedRoot || resolvedCandidate.startsWith(resolvedRoot + path.sep);
}

function toPosixRelative(root: string, target: string): string {
  const rel = path.relative(path.resolve(root), path.resolve(target));
  if (!rel || rel === '') return '.';
  if (rel.startsWith('..') || path.isAbsolute(rel) || rel.includes('\0')) throw new Error('WORKER_FILE_PATH_OUTSIDE_PROJECT');
  return rel.split(path.sep).join('/');
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function relativeWorkerPath(authority: WorkerFileAuthority, hostPath: string): string {
  return toPosixRelative(authority.projectRoot, hostPath);
}

function languageFor(relativePath: string): { language: string; binary: boolean } {
  const ext = path.posix.extname(relativePath).slice(1).toLowerCase();
  return { language: LANGUAGE_MAP[ext] || 'text', binary: BINARY_EXTENSIONS.has(ext) };
}

/** Resolve host Project path to Worker-local authority metadata when the Project opted in. */
export async function resolveWorkerFileAuthorityForHostPath(hostPath: string): Promise<WorkerFileAuthority | undefined> {
  const rows = await query<WorkstationProjectRow>(
    `SELECT p.id AS project_id, p.root_path, pcs.default_worker_id
       FROM project_compute_settings pcs
       JOIN projects p ON p.id=pcs.project_id
      WHERE pcs.workstation_mode=TRUE AND pcs.default_worker_id IS NOT NULL
      ORDER BY length(p.root_path) DESC`,
  );
  const resolved = path.resolve(hostPath);
  for (const row of rows) {
    if (!row.root_path || !isInsidePath(row.root_path, resolved)) continue;
    const worker = await getPersistedWorkbenchWorker(row.default_worker_id).catch(() => undefined);
    if (!worker || worker.status !== 'healthy') return undefined;
    return {
      projectId: row.project_id,
      projectRoot: path.resolve(row.root_path),
      relativePath: toPosixRelative(row.root_path, resolved),
      workerId: worker.workerId,
      workerBaseUrl: worker.baseUrl,
    };
  }
  return undefined;
}

async function runWorkerFileCommand(input: {
  authority: WorkerFileAuthority;
  actorUserId: number;
  command: string;
  timeoutSec?: number;
}): Promise<string> {
  const token = await resolveWorkbenchWorkerTransportToken(input.authority.workerId, input.actorUserId);
  if (!token) throw new Error('WORKER_FILE_AUTHORITY_TOKEN_MISSING');
  const transport = createRemoteWorkbenchHttpTransport({
    workerId: input.authority.workerId,
    baseUrl: input.authority.workerBaseUrl,
    token,
  });
  const result = await transport.execute({
    spec: {
      jobId: Date.now(),
      projectId: input.authority.projectId,
      command: input.command,
      timeoutSec: input.timeoutSec ?? 15,
      workbenchRevision: null,
      environmentKeys: [],
    },
    credentials: {},
    signal: new AbortController().signal,
    onStdout: () => undefined,
    onStderr: () => undefined,
  });
  if (result.execResult.exit_code !== 0) {
    throw new Error(result.execResult.stderr || `WORKER_FILE_COMMAND_FAILED_${result.execResult.exit_code}`);
  }
  return result.execResult.stdout;
}

/** Read a bounded subtree manifest from Worker-local persistent storage. */
export async function readWorkerProjectManifest(input: {
  authority: WorkerFileAuthority;
  actorUserId: number;
  maxFiles?: number;
  maxBytes?: number;
}): Promise<WorkerProjectManifest> {
  const token = await resolveWorkbenchWorkerTransportToken(input.authority.workerId, input.actorUserId);
  if (!token) throw new Error('WORKER_FILE_AUTHORITY_TOKEN_MISSING');
  const endpoint = new URL(`/v1/files/${encodeURIComponent(input.authority.projectId)}/manifest`, input.authority.workerBaseUrl);
  endpoint.searchParams.set('path', input.authority.relativePath);
  endpoint.searchParams.set('maxFiles', String(input.maxFiles ?? 2000));
  endpoint.searchParams.set('maxBytes', String(input.maxBytes ?? 512 * 1024 * 1024));
  const response = await fetch(endpoint, { headers: { authorization: `Bearer ${token}` } });
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`WORKER_FILE_MANIFEST_FAILED_${response.status}: ${body.slice(0, 500)}`);
  }
  return await response.json() as WorkerProjectManifest;
}

/** Download raw bytes from Worker-local persistent storage. */
export async function downloadWorkerProjectFile(input: {
  authority: WorkerFileAuthority;
  actorUserId: number;
}): Promise<Buffer> {
  const token = await resolveWorkbenchWorkerTransportToken(input.authority.workerId, input.actorUserId);
  if (!token) throw new Error('WORKER_FILE_AUTHORITY_TOKEN_MISSING');
  const endpoint = new URL(`/v1/files/${encodeURIComponent(input.authority.projectId)}/content`, input.authority.workerBaseUrl);
  endpoint.searchParams.set('path', input.authority.relativePath);
  const response = await fetch(endpoint, { headers: { authorization: `Bearer ${token}` } });
  if (!response.ok) throw new Error(`WORKER_FILE_DOWNLOAD_FAILED_${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}

/** Read a file from the Worker-local persistent workspace. */
export async function readWorkerProjectFile(input: {
  authority: WorkerFileAuthority;
  actorUserId: number;
}): Promise<WorkerReadFileResult> {
  const { language, binary } = languageFor(input.authority.relativePath);
  if (binary) {
    const content = (await downloadWorkerProjectFile(input)).toString('base64');
    return { content, language, encoding: 'base64' };
  }
  const command = `node -e ${shellQuote(`
const fs = require('fs');
const path = require('path');
const rel = process.argv[1];
const binary = process.argv[2] === '1';
if (!rel || path.isAbsolute(rel) || rel.split('/').includes('..')) process.exit(2);
const file = path.resolve(process.cwd(), rel);
if (!(file === process.cwd() || file.startsWith(process.cwd() + path.sep))) process.exit(2);
const data = fs.readFileSync(file);
process.stdout.write(binary ? data.toString('base64') : data.toString('utf8'));
`)} ${shellQuote(input.authority.relativePath)} ${binary ? '1' : '0'}`;
  const content = await runWorkerFileCommand({ authority: input.authority, actorUserId: input.actorUserId, command });
  return { content, language };
}

/** Test existence from the Worker-local persistent workspace. */
export async function workerProjectFileExists(input: {
  authority: WorkerFileAuthority;
  actorUserId: number;
}): Promise<boolean> {
  const command = `test -e ${shellQuote(input.authority.relativePath)}`;
  try {
    await runWorkerFileCommand({ authority: input.authority, actorUserId: input.actorUserId, command, timeoutSec: 5 });
    return true;
  } catch {
    return false;
  }
}

/** Stream one staged binary file into Worker-local persistent storage. */
export async function uploadWorkerProjectFile(input: {
  authority: WorkerFileAuthority;
  actorUserId: number;
  sourcePath: string;
  sizeBytes: number;
}): Promise<void> {
  if (!Number.isSafeInteger(input.sizeBytes) || input.sizeBytes < 0 || input.sizeBytes > 200 * 1024 * 1024) {
    throw new Error('WORKER_FILE_UPLOAD_SIZE_INVALID');
  }
  const token = await resolveWorkbenchWorkerTransportToken(input.authority.workerId, input.actorUserId);
  if (!token) throw new Error('WORKER_FILE_AUTHORITY_TOKEN_MISSING');
  const endpoint = new URL(`/v1/files/${encodeURIComponent(input.authority.projectId)}/content`, input.authority.workerBaseUrl);
  endpoint.searchParams.set('path', input.authority.relativePath);
  const response = await fetch(endpoint, {
    method: 'PUT',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/octet-stream',
      'content-length': String(input.sizeBytes),
    },
    body: fs.createReadStream(input.sourcePath) as any,
    duplex: 'half',
  } as RequestInit & { duplex: 'half' });
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`WORKER_FILE_UPLOAD_FAILED_${response.status}: ${body.slice(0, 500)}`);
  }
}

/** Create or replace a UTF-8 file in Worker-local persistent storage. */
export async function writeWorkerProjectFile(input: {
  authority: WorkerFileAuthority;
  actorUserId: number;
  content: string;
  exclusive?: boolean;
}): Promise<void> {
  const encoded = Buffer.from(input.content, 'utf8').toString('base64');
  const command = `node -e ${shellQuote(`
const fs = require('fs');
const path = require('path');
const rel = process.argv[1];
const content = Buffer.from(process.argv[2], 'base64');
const exclusive = process.argv[3] === '1';
if (!rel || rel === '.' || path.isAbsolute(rel) || rel.split('/').includes('..')) process.exit(2);
const root = process.cwd();
const target = path.resolve(root, rel);
if (!target.startsWith(root + path.sep)) process.exit(2);
fs.mkdirSync(path.dirname(target), { recursive: true });
fs.writeFileSync(target, content, { flag: exclusive ? 'wx' : 'w' });
`)} ${shellQuote(input.authority.relativePath)} ${shellQuote(encoded)} ${input.exclusive ? '1' : '0'}`;
  await runWorkerFileCommand({ authority: input.authority, actorUserId: input.actorUserId, command });
}

/** Create one directory tree in Worker-local persistent storage. */
export async function createWorkerProjectDirectory(input: {
  authority: WorkerFileAuthority;
  actorUserId: number;
  exclusive?: boolean;
}): Promise<void> {
  const command = `node -e ${shellQuote(`
const fs = require('fs');
const path = require('path');
const rel = process.argv[1];
const exclusive = process.argv[2] === '1';
if (!rel || rel === '.' || path.isAbsolute(rel) || rel.split('/').includes('..')) process.exit(2);
const root = process.cwd();
const target = path.resolve(root, rel);
if (!target.startsWith(root + path.sep)) process.exit(2);
if (exclusive && fs.existsSync(target)) process.exit(17);
fs.mkdirSync(target, { recursive: true });
`)} ${shellQuote(input.authority.relativePath)} ${input.exclusive ? '1' : '0'}`;
  await runWorkerFileCommand({ authority: input.authority, actorUserId: input.actorUserId, command });
}

/** Delete one file or directory from Worker-local persistent storage. */
export async function deleteWorkerProjectEntry(input: {
  authority: WorkerFileAuthority;
  actorUserId: number;
}): Promise<void> {
  const command = `node -e ${shellQuote(`
const fs = require('fs');
const path = require('path');
const rel = process.argv[1];
if (!rel || rel === '.' || path.isAbsolute(rel) || rel.split('/').includes('..')) process.exit(2);
const root = process.cwd();
const target = path.resolve(root, rel);
if (!target.startsWith(root + path.sep)) process.exit(2);
if (!fs.existsSync(target)) process.exit(44);
fs.rmSync(target, { recursive: true, force: false });
`)} ${shellQuote(input.authority.relativePath)}`;
  await runWorkerFileCommand({ authority: input.authority, actorUserId: input.actorUserId, command });
}

/** Rename one entry within the same Worker Project authority. */
export async function renameWorkerProjectEntry(input: {
  authority: WorkerFileAuthority;
  actorUserId: number;
  newHostPath: string;
}): Promise<void> {
  const destination = relativeWorkerPath(input.authority, input.newHostPath);
  const command = `node -e ${shellQuote(`
const fs = require('fs');
const path = require('path');
const sourceRel = process.argv[1];
const targetRel = process.argv[2];
const root = process.cwd();
const safe = (rel) => rel && rel !== '.' && !path.isAbsolute(rel) && !rel.split('/').includes('..');
if (!safe(sourceRel) || !safe(targetRel)) process.exit(2);
const source = path.resolve(root, sourceRel);
const target = path.resolve(root, targetRel);
if (!source.startsWith(root + path.sep) || !target.startsWith(root + path.sep)) process.exit(2);
if (!fs.existsSync(source)) process.exit(44);
if (fs.existsSync(target)) process.exit(17);
fs.mkdirSync(path.dirname(target), { recursive: true });
fs.renameSync(source, target);
`)} ${shellQuote(input.authority.relativePath)} ${shellQuote(destination)}`;
  await runWorkerFileCommand({ authority: input.authority, actorUserId: input.actorUserId, command });
}

/** Copy one entry within the same Worker Project, choosing a collision-free target name. */
export async function copyWorkerProjectEntry(input: {
  authority: WorkerFileAuthority;
  actorUserId: number;
  targetDirHostPath: string;
}): Promise<{ targetPath: string }> {
  const targetDir = relativeWorkerPath(input.authority, input.targetDirHostPath);
  const command = `node -e ${shellQuote(`
const fs = require('fs');
const path = require('path');
const sourceRel = process.argv[1];
const targetDirRel = process.argv[2];
const root = process.cwd();
const safe = (rel) => rel && !path.isAbsolute(rel) && !rel.split('/').includes('..');
if (!safe(sourceRel) || !safe(targetDirRel)) process.exit(2);
const source = path.resolve(root, sourceRel);
const targetDir = targetDirRel === '.' ? root : path.resolve(root, targetDirRel);
if (!source.startsWith(root + path.sep) || !(targetDir === root || targetDir.startsWith(root + path.sep))) process.exit(2);
if (!fs.existsSync(source) || !fs.statSync(targetDir).isDirectory()) process.exit(44);
const sourceName = path.basename(source);
const ext = path.extname(sourceName);
const stem = ext ? sourceName.slice(0, -ext.length) : sourceName;
let target = path.join(targetDir, sourceName);
for (let i = 1; fs.existsSync(target) && i <= 1000; i++) {
  const suffix = i === 1 ? ' copy' : ' copy ' + i;
  target = path.join(targetDir, stem + suffix + ext);
}
if (fs.existsSync(target)) process.exit(17);
fs.cpSync(source, target, { recursive: true, errorOnExist: true, force: false });
process.stdout.write(path.relative(root, target).split(path.sep).join('/'));
`)} ${shellQuote(input.authority.relativePath)} ${shellQuote(targetDir)}`;
  const relativeTarget = (await runWorkerFileCommand({ authority: input.authority, actorUserId: input.actorUserId, command })).trim();
  return { targetPath: path.resolve(input.authority.projectRoot, ...relativeTarget.split('/')) };
}

/** List one directory from Worker-local persistent workspace, returning host-shaped paths. */
export async function listWorkerProjectDirectory(input: {
  authority: WorkerFileAuthority;
  actorUserId: number;
  showHidden?: boolean;
}): Promise<WorkerFileTreeEntry[]> {
  const showHidden = input.showHidden ? '1' : '0';
  const command = `node -e ${shellQuote(`
const fs = require('fs');
const path = require('path');
const rel = process.argv[1];
const showHidden = process.argv[2] === '1';
if (!rel || path.isAbsolute(rel) || rel.split('/').includes('..')) process.exit(2);
const root = process.cwd();
const target = rel === '.' ? root : path.resolve(root, rel);
if (!(target === root || target.startsWith(root + path.sep))) process.exit(2);
const alwaysHidden = new Set(['.git', 'node_modules', 'dist', 'build', '.venv', '__pycache__']);
const rows = fs.readdirSync(target, { withFileTypes: true }).filter((entry) => {
  if (alwaysHidden.has(entry.name)) return false;
  if (!showHidden && entry.name.startsWith('.')) return false;
  return true;
}).map((entry) => {
  const fullPath = path.join(target, entry.name);
  const stat = fs.lstatSync(fullPath);
  const row = { name: entry.name, isDirectory: entry.isDirectory(), modified: stat.mtime.toISOString() };
  if (!entry.isDirectory()) {
    row.size = stat.size;
    row.extension = path.extname(entry.name).slice(1);
  }
  return row;
});
rows.sort((a, b) => (a.isDirectory === b.isDirectory ? a.name.localeCompare(b.name) : a.isDirectory ? -1 : 1));
console.log(JSON.stringify(rows));
`)} ${shellQuote(input.authority.relativePath)} ${showHidden}`;
  const stdout = await runWorkerFileCommand({ authority: input.authority, actorUserId: input.actorUserId, command });
  const rows = JSON.parse(stdout) as Array<Omit<WorkerFileTreeEntry, 'path'>>;
  const hostDir = path.resolve(input.authority.projectRoot, input.authority.relativePath === '.' ? '' : input.authority.relativePath);
  return rows.map(row => ({ ...row, path: path.join(hostDir, row.name) }));
}

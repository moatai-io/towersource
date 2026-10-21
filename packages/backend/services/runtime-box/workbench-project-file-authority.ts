/**
 * Owns: Project file authority seam for Worker-first Projects.
 * Public API: resolve authority and read/write/mkdir/delete/rename/copy/list/exists via Worker root.
 *
 * HTTP file APIs still authorize against the host-shaped Project path, then apply the
 * same relative operation to Worker-local persistent storage when workstation_mode=true.
 */

import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { query } from '../../db/pg-repo.js';
import { resolveProjectWorkspaceTarget } from '../project-environment/project-workspace-authority.js';
import { resolveProjectEnvironmentDeploymentId } from '../project-environment/project-environment-deployment.js';
import { getPersistedWorkbenchWorker } from '../execution/worker/worker-repository.js';
import { resolveWorkbenchWorkerTransportToken } from '../execution/worker/worker-transport-credentials.js';
import { createRemoteWorkbenchHttpTransport } from '../execution/worker/worker-http-transport.js';
import { ProjectStorage } from './project-storage.js';
import { selectRegisteredProjectRoot, type RegisteredProjectRoot, type ExpectedProjectRoot } from '../project-environment/project-root-selection.js';

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

type WorkstationProjectRow = RegisteredProjectRoot;

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
  traversalError?: string;
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

/** Enforce the shared Project namespace for official host-shaped mutations.
 * Returns undefined outside a registered Project so workspace/admin paths retain
 * their existing policy. Managed/private Project namespaces require dedicated APIs.
 */
export async function assertProjectSharedMutationForHostPath(hostPath: string): Promise<{ projectId: string; projectRoot: string; relativePath: string } | undefined> {
  const rows = await query<WorkstationProjectRow>(
    'SELECT id AS project_id, root_path, archived, lifecycle_status FROM projects ORDER BY length(root_path) DESC, id',
  );
  const resolved = path.resolve(hostPath);
  const row = selectRegisteredProjectRoot(rows, resolved);
  if (!row) return undefined;
  const projectRoot = path.resolve(row.root_path!);
  const relativePath = toPosixRelative(projectRoot, resolved);
  if (relativePath === '.') throw new Error('PROJECT_STORAGE_ROOT_MUTATION_DENIED');
  new ProjectStorage(projectRoot).assertMutation(relativePath, 'shared');
  return { projectId: row.project_id, projectRoot, relativePath };
}

/** Project-scoped callers must pass expected identity; path-only callers require
 * one active identity at the deepest boundary. Retired nested roots remain barriers. */
export async function resolveWorkerFileAuthorityForHostPath(hostPath: string, expected?: ExpectedProjectRoot): Promise<WorkerFileAuthority | undefined> {
  const deploymentId = resolveProjectEnvironmentDeploymentId();
  const rows = await query<WorkstationProjectRow>(
    'SELECT id AS project_id, root_path, archived, lifecycle_status FROM projects ORDER BY length(root_path) DESC, id',
  );
  const resolved = path.resolve(hostPath);
  const row = selectRegisteredProjectRoot(rows, resolved, expected);
  if (!row) return undefined;
  const binding = await resolveProjectWorkspaceTarget(row.project_id, deploymentId);
  if (!binding?.workstationMode) return undefined;
  if (!binding.defaultWorkerId) throw new Error('WORKER_FILE_AUTHORITY_BINDING_INCOMPLETE');

  // Preserve fail-closed Worker storage: never broaden scope or fall back to host.
  const worker = await getPersistedWorkbenchWorker(binding.defaultWorkerId).catch(() => {
    throw new Error('WORKER_FILE_AUTHORITY_LOOKUP_FAILED');
  });
  if (!worker || worker.status !== 'healthy') throw new Error('WORKER_FILE_AUTHORITY_UNAVAILABLE');
  if (worker.deploymentId !== deploymentId) throw new Error('WORKER_FILE_AUTHORITY_DEPLOYMENT_MISMATCH');
  if (!worker.projectIds.includes(row.project_id)) throw new Error('WORKER_FILE_AUTHORITY_SCOPE_MISMATCH');
  return {
    projectId: row.project_id,
    projectRoot: path.resolve(row.root_path!),
    relativePath: toPosixRelative(row.root_path!, resolved),
    workerId: worker.workerId,
    workerBaseUrl: worker.baseUrl,
  };
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
      actorUserId: input.actorUserId,
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

/** Open a raw Worker file response without buffering it in Tower. */
export async function openWorkerProjectFileStream(input: {
  authority: WorkerFileAuthority;
  actorUserId: number;
  range?: string;
  method?: 'GET' | 'HEAD';
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
}): Promise<Response> {
  const token = await resolveWorkbenchWorkerTransportToken(input.authority.workerId, input.actorUserId);
  if (!token) throw new Error('WORKER_FILE_AUTHORITY_TOKEN_MISSING');
  const endpoint = new URL(`/v1/files/${encodeURIComponent(input.authority.projectId)}/content`, input.authority.workerBaseUrl);
  endpoint.searchParams.set('path', input.authority.relativePath);
  let response: Response;
  try {
    response = await (input.fetchImpl || fetch)(endpoint, {
      method: input.method || 'GET',
      headers: {
        authorization: `Bearer ${token}`,
        ...(input.range ? { range: input.range } : {}),
      },
      signal: input.signal,
    });
  } catch (error) {
    throw new Error(`WORKER_FILE_STREAM_FAILED: ${(error as Error).message}`);
  }
  if (![200, 206, 416].includes(response.status)) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error(`WORKER_FILE_STREAM_FAILED: HTTP ${response.status}`);
  }
  return response;
}

/** Metadata-only query; unsupported Workers must be upgraded, never downloaded as fallback. */
export async function statWorkerProjectFile(input: { authority: WorkerFileAuthority; actorUserId: number }): Promise<{ sizeBytes: number; version: string }> {
  const response = await openWorkerProjectFileStream({ ...input, method: 'HEAD' });
  const length = response.headers.get('content-length');
  const version = response.headers.get('x-tower-file-version');
  if (response.status !== 200 || !length || !/^\d+$/.test(length) || !version || !Number.isSafeInteger(Number(length))) {
    await response.body?.cancel();
    throw new Error('WORKER_FILE_METADATA_UNSUPPORTED');
  }
  return { sizeBytes: Number(length), version };
}

/** Prefix-only read: the total file size is not the probe budget. */
export async function readWorkerProjectFileProbe(input: { authority: WorkerFileAuthority; actorUserId: number; maxBytes: number }): Promise<Buffer> {
  if (!Number.isSafeInteger(input.maxBytes) || input.maxBytes < 1 || input.maxBytes > 1024 * 1024) throw new Error('WORKER_FILE_PROBE_LIMIT_INVALID');
  const response = await openWorkerProjectFileStream({ ...input, range: `bytes=0-${input.maxBytes - 1}` });
  if (response.status === 416 && response.headers.get('content-range') === 'bytes */0') {
    await response.body?.cancel(); return Buffer.alloc(0);
  }
  const range = /^bytes 0-(\d+)\/(\d+)$/.exec(response.headers.get('content-range') || '');
  const end = range ? Number(range[1]) : -1;
  const total = range ? Number(range[2]) : -1;
  if (response.status !== 206 || !range || !Number.isSafeInteger(end) || !Number.isSafeInteger(total)
      || end < 0 || end >= input.maxBytes || total <= end || end !== Math.min(input.maxBytes, total) - 1 || !response.body) {
    await response.body?.cancel(); throw new Error('WORKER_FILE_PROBE_RANGE_INVALID');
  }
  const reader = response.body.getReader();
  const chunks: Buffer[] = []; let size = 0;
  try {
    while (true) {
      const next = await reader.read(); if (next.done) break;
      size += next.value.byteLength;
      if (size > input.maxBytes || size > end + 1) { await reader.cancel(); throw new Error('WORKER_FILE_PROBE_SIZE_LIMIT'); }
      chunks.push(Buffer.from(next.value));
    }
  } finally { reader.releaseLock(); }
  if (size !== end + 1) throw new Error('WORKER_FILE_PROBE_TRUNCATED');
  return Buffer.concat(chunks, size);
}

/** Download raw bytes from Worker-local persistent storage. */
export async function downloadWorkerProjectFile(input: {
  authority: WorkerFileAuthority;
  actorUserId: number;
  maxBytes?: number;
}): Promise<Buffer> {
  const token = await resolveWorkbenchWorkerTransportToken(input.authority.workerId, input.actorUserId);
  if (!token) throw new Error('WORKER_FILE_AUTHORITY_TOKEN_MISSING');
  const endpoint = new URL(`/v1/files/${encodeURIComponent(input.authority.projectId)}/content`, input.authority.workerBaseUrl);
  endpoint.searchParams.set('path', input.authority.relativePath);
  const response = await fetch(endpoint, { headers: { authorization: `Bearer ${token}` } });
  if (!response.ok) throw new Error(`WORKER_FILE_DOWNLOAD_FAILED_${response.status}`);
  if (input.maxBytes === undefined) return Buffer.from(await response.arrayBuffer());
  const reader = response.body?.getReader();
  if (!reader) throw new Error('WORKER_FILE_DOWNLOAD_EMPTY_BODY');
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > input.maxBytes) {
        await reader.cancel();
        throw new Error('WORKER_FILE_DOWNLOAD_SIZE_LIMIT');
      }
      chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks, total);
  } finally { reader.releaseLock(); }
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
  exclusive?: boolean;
}): Promise<void> {
  if (!Number.isSafeInteger(input.sizeBytes) || input.sizeBytes < 0 || input.sizeBytes > 200 * 1024 * 1024) {
    throw new Error('WORKER_FILE_UPLOAD_SIZE_INVALID');
  }
  const token = await resolveWorkbenchWorkerTransportToken(input.authority.workerId, input.actorUserId);
  if (!token) throw new Error('WORKER_FILE_AUTHORITY_TOKEN_MISSING');
  const endpoint = new URL(`/v1/files/${encodeURIComponent(input.authority.projectId)}/content`, input.authority.workerBaseUrl);
  endpoint.searchParams.set('path', input.authority.relativePath);
  if (input.exclusive) endpoint.searchParams.set('exclusive', '1');
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
    const error = new Error(`WORKER_FILE_UPLOAD_FAILED_${response.status}: ${body.slice(0, 500)}`) as Error & { code?: string };
    if (response.status === 409) error.code = 'EEXIST';
    throw error;
  }
}

/** UTF-8 data travels through the file endpoint, never execution JSON. */
async function transferWorkerText(input: { authority: WorkerFileAuthority; actorUserId: number;
  content: string; mode: 'exclusive' | 'replace' | 'cas'; expectedContent?: string }): Promise<void> {
  const bytes = Buffer.from(input.content, 'utf8');
  const maxBytes = input.mode === 'cas' ? 1024 * 1024 : 100 * 1024 * 1024;
  if (bytes.length > maxBytes || (input.expectedContent !== undefined && Buffer.byteLength(input.expectedContent) > 1024 * 1024)) throw new Error('WORKER_TEXT_WRITE_SIZE_LIMIT');
  const token = await resolveWorkbenchWorkerTransportToken(input.authority.workerId, input.actorUserId);
  if (!token) throw new Error('WORKER_FILE_AUTHORITY_TOKEN_MISSING');
  const endpoint = new URL(`/v1/files/${encodeURIComponent(input.authority.projectId)}/content`, input.authority.workerBaseUrl);
  endpoint.searchParams.set('path', input.authority.relativePath);
  const headers = { authorization: `Bearer ${token}` };
  // Older upload handlers ignore unknown params. Check before ANY mutation.
  const capability = await fetch(endpoint, { method: 'HEAD', headers, signal: AbortSignal.timeout(30_000) });
  await capability.body?.cancel();
  if (![200, 404].includes(capability.status) || capability.headers.get('x-tower-text-write') !== 'v1') throw new Error('WORKER_TEXT_WRITE_PROTOCOL_UNSUPPORTED');
  endpoint.searchParams.set('text-mode', input.mode);
  const response = await fetch(endpoint, { method: 'PUT',
    headers: { ...headers, 'content-type': 'text/plain; charset=utf-8',
      ...(input.expectedContent !== undefined ? { 'x-tower-expected-sha256': createHash('sha256').update(input.expectedContent, 'utf8').digest('hex') } : {}) },
    body: new Uint8Array(bytes), signal: AbortSignal.timeout(60_000),
  });
  if (response.status === 409) {
    await response.body?.cancel();
    if (input.mode === 'exclusive') throw Object.assign(new Error('WORKER_FILE_UPLOAD_EXISTS'), { code: 'EEXIST' });
    throw new Error('SCOPED_EDIT_STALE_SOURCE');
  }
  if (!response.ok) { await response.body?.cancel(); throw new Error(`WORKER_TEXT_WRITE_FAILED: HTTP ${response.status}`); }
  const receipt = await response.json() as { written?: boolean; bytes?: number; textWriteVersion?: number };
  if (receipt.written !== true || receipt.bytes !== bytes.length || receipt.textWriteVersion !== 1) throw new Error('WORKER_TEXT_WRITE_RECEIPT_INVALID');
}

export async function writeWorkerProjectFile(input: { authority: WorkerFileAuthority; actorUserId: number;
  content: string; exclusive?: boolean }): Promise<void> {
  await transferWorkerText({ ...input, mode: input.exclusive ? 'exclusive' : 'replace' });
}

/** A fixed-size snapshot hash replaces embedded expected contents. */
export async function compareAndSwapWorkerProjectFile(input: { authority: WorkerFileAuthority; actorUserId: number;
  expectedContent: string; content: string }): Promise<void> {
  await transferWorkerText({ ...input, mode: 'cas' });
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
}).flatMap((entry) => {
  const fullPath = path.join(target, entry.name);
  let stat;
  try { stat = fs.lstatSync(fullPath); } catch (error) {
    if (!['EACCES', 'EPERM', 'ENOENT'].includes(error.code)) throw error;
    return [{ name: entry.name, isDirectory: entry.isDirectory(), traversalError: error.code }];
  }
  const row = { name: entry.name, isDirectory: entry.isDirectory(), modified: stat.mtime.toISOString() };
  if (!entry.isDirectory()) {
    row.size = stat.size;
    row.extension = path.extname(entry.name).slice(1);
  }
  return [row];
});
rows.sort((a, b) => (a.isDirectory === b.isDirectory ? a.name.localeCompare(b.name) : a.isDirectory ? -1 : 1));
console.log(JSON.stringify(rows));
`)} ${shellQuote(input.authority.relativePath)} ${showHidden}`;
  const stdout = await runWorkerFileCommand({ authority: input.authority, actorUserId: input.actorUserId, command });
  const rows = JSON.parse(stdout) as Array<Omit<WorkerFileTreeEntry, 'path'>>;
  const hostDir = path.resolve(input.authority.projectRoot, input.authority.relativePath === '.' ? '' : input.authority.relativePath);
  return rows.map(row => ({ ...row, path: path.join(hostDir, row.name) }));
}

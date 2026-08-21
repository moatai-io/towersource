/**
 * Owns: Minimal HTTP Worker for Remote Workbench Job dogfood with run-scoped Credentials.
 * Public API: createRemoteWorkbenchWorkerServer.
 *
 * Project ids resolve through a server-owned allowlist. Requests cannot select arbitrary
 * host paths, pass environment values, or start Services. The response is NDJSON so logs
 * stream before one terminal ExecResult event.
 */

import { createHash, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { URL } from 'node:url';
import type { ExecResult, RuntimeContext } from './types.js';
import type {
  RemoteWorkbenchArtifactManifestEntry,
  RemoteWorkbenchExecutionResult,
  RemoteWorkbenchJobSpec,
} from './workbench-remote-job-runner.js';

const MAX_OUTPUT = 1_000_000;

export interface RemoteWorkbenchWorkerServerOptions {
  workerId: string;
  token: string;
  projects: Record<string, string>;
  /** Operator-owned host roots projected at fixed /workspace paths. Requests cannot add mounts. */
  projections?: Record<string, string>;
  /** Non-secret commit attribution for this dedicated Tower development Workstation only. */
  operatorGitIdentity?: { name: string; email: string };
}

type WorkerEvent =
  | { type: 'stdout' | 'stderr'; chunk: string }
  | { type: 'result'; result: RemoteWorkbenchExecutionResult }
  | { type: 'error'; code: string; message: string };

function authorized(header: string | undefined, token: string): boolean {
  const supplied = header?.startsWith('Bearer ') ? header.slice(7) : '';
  const a = Buffer.from(supplied);
  const b = Buffer.from(token);
  return a.length === b.length && a.length > 0 && timingSafeEqual(a, b);
}

function jsonLine(response: http.ServerResponse, event: WorkerEvent): void {
  response.write(`${JSON.stringify(event)}\n`);
}

async function readJson(request: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.from(chunk);
    size += buffer.length;
    if (size > 64_000) throw new Error('request body too large');
    chunks.push(buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

interface WorkerProjectManifestEntry {
  path: string;
  type: 'file' | 'directory';
  sizeBytes?: number;
  modified: string;
  sha256?: string;
}

async function collectProjectSubtreeManifest(input: {
  projectRoot: string;
  relativePath: string;
  maxFiles: number;
  maxBytes: number;
}): Promise<{ entries: WorkerProjectManifestEntry[]; fileCount: number; totalBytes: number }> {
  const target = resolveProjectFile(input.projectRoot, input.relativePath);
  const targetStat = await fs.stat(target);
  if (!targetStat.isDirectory()) throw new Error('manifest target is not a directory');
  const projectRoot = path.resolve(input.projectRoot);
  const entries: WorkerProjectManifestEntry[] = [];
  let fileCount = 0;
  let totalBytes = 0;
  const walk = async (dir: string): Promise<void> => {
    const children = await fs.readdir(dir, { withFileTypes: true });
    children.sort((a, b) => a.name.localeCompare(b.name));
    for (const child of children) {
      if (child.name === '.git' || child.name === 'node_modules' || child.name === '.tower-run-credentials') continue;
      const fullPath = path.join(dir, child.name);
      const stat = await fs.lstat(fullPath);
      if (stat.isSymbolicLink()) continue;
      const relative = path.relative(projectRoot, fullPath).split(path.sep).join('/');
      if (stat.isDirectory()) {
        entries.push({ path: relative, type: 'directory', modified: stat.mtime.toISOString() });
        await walk(fullPath);
        continue;
      }
      if (!stat.isFile()) continue;
      fileCount += 1;
      totalBytes += stat.size;
      if (fileCount > input.maxFiles) throw new Error('manifest file limit exceeded');
      if (totalBytes > input.maxBytes) throw new Error('manifest byte limit exceeded');
      const content = await fs.readFile(fullPath);
      entries.push({
        path: relative,
        type: 'file',
        sizeBytes: stat.size,
        modified: stat.mtime.toISOString(),
        sha256: createHash('sha256').update(content).digest('hex'),
      });
    }
  };
  await walk(target);
  return { entries, fileCount, totalBytes };
}

async function streamProjectFileDownload(input: {
  request: http.IncomingMessage;
  response: http.ServerResponse;
  projectRoot: string;
  relativePath: string;
}): Promise<void> {
  const target = resolveProjectFile(input.projectRoot, input.relativePath);
  const stat = await fs.stat(target);
  if (!stat.isFile()) throw new Error('download target is not a file');
  input.response.statusCode = 200;
  input.response.setHeader('content-type', 'application/octet-stream');
  input.response.setHeader('content-length', String(stat.size));
  const stream = (await import('node:fs')).createReadStream(target);
  stream.on('error', error => input.response.destroy(error));
  stream.pipe(input.response);
}

async function receiveProjectFileUpload(input: {
  request: http.IncomingMessage;
  response: http.ServerResponse;
  projectRoot: string;
  relativePath: string;
}): Promise<void> {
  const target = resolveProjectFile(input.projectRoot, input.relativePath);
  const expected = Number(input.request.headers['content-length']);
  if (!Number.isSafeInteger(expected) || expected < 0 || expected > 200 * 1024 * 1024) throw new Error('invalid upload content length');
  await fs.mkdir(path.dirname(target), { recursive: true });
  const temp = `${target}.tower-worker-upload-${process.pid}-${Date.now()}.tmp`;
  const handle = await fs.open(temp, 'wx', 0o600);
  let received = 0;
  try {
    for await (const chunk of input.request) {
      const buffer = Buffer.from(chunk);
      received += buffer.length;
      if (received > expected || received > 200 * 1024 * 1024) throw new Error('upload size exceeded');
      await handle.write(buffer);
    }
    await handle.close();
    if (received !== expected) throw new Error('upload content length mismatch');
    await fs.rename(temp, target);
    input.response.setHeader('content-type', 'application/json; charset=utf-8');
    input.response.end(JSON.stringify({ ok: true, sizeBytes: received }));
  } catch (error) {
    await handle.close().catch(() => {});
    await fs.rm(temp, { force: true });
    throw error;
  }
}

function validSpec(value: unknown): value is RemoteWorkbenchJobSpec {
  if (!value || typeof value !== 'object') return false;
  const spec = value as Record<string, unknown>;
  return Number.isSafeInteger(spec.jobId)
    && typeof spec.projectId === 'string'
    && (spec.sessionId === undefined || (typeof spec.sessionId === 'string' && /^[0-9a-fA-F-]{36}$/.test(spec.sessionId)))
    && (spec.workspaceId === undefined || (typeof spec.workspaceId === 'string' && /^[a-zA-Z0-9._-]{1,120}$/.test(spec.workspaceId)))
    && typeof spec.command === 'string'
    && spec.command.trim().length > 0
    && (spec.cwd === undefined || typeof spec.cwd === 'string')
    && (spec.timeoutSec === undefined || (Number.isInteger(spec.timeoutSec) && Number(spec.timeoutSec) >= 1 && Number(spec.timeoutSec) <= 3600))
    && Array.isArray(spec.environmentKeys)
    && spec.environmentKeys.every(key => typeof key === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(key))
    && (spec.artifacts === undefined || (Array.isArray(spec.artifacts) && spec.artifacts.every(item => {
      if (!item || typeof item !== 'object') return false;
      const artifact = item as Record<string, unknown>;
      return typeof artifact.path === 'string' && artifact.path.length > 0;
    })));
}

function resolveWorkspaceRoot(projectRoot: string, workspaceId?: string): string {
  const root = path.resolve(projectRoot);
  if (!workspaceId) return root;
  const workspaceRoot = path.resolve(root, '.tower-remote-jobs', workspaceId);
  if (!workspaceRoot.startsWith(`${root}${path.sep}`)) throw new Error('workspace escapes project root');
  return workspaceRoot;
}

function resolveCwd(projectRoot: string, requested?: string, projections: Record<string, string> = {}): string {
  const root = path.resolve(projectRoot);
  if (!requested || requested === '/workspace') return root;
  if (!requested.startsWith('/workspace/')) throw new Error('cwd must use a registered /workspace path');
  const projection = Object.entries(projections)
    .sort(([a], [b]) => b.length - a.length)
    .find(([target]) => requested === target || requested.startsWith(`${target}/`));
  if (projection) {
    const [target, source] = projection;
    const sourceRoot = path.resolve(source);
    const suffix = requested.slice(target.length).replace(/^\/+/, '');
    const resolved = path.resolve(sourceRoot, suffix);
    if (resolved !== sourceRoot && !resolved.startsWith(`${sourceRoot}${path.sep}`)) throw new Error('cwd escapes registered projection');
    return resolved;
  }
  const resolved = path.resolve(root, requested.slice('/workspace/'.length));
  if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) throw new Error('cwd escapes project root');
  return resolved;
}

function resolveProjectFile(projectRoot: string, requested: string): string {
  if (path.isAbsolute(requested) || requested.includes('\0')) throw new Error('artifact path must be project-relative');
  const root = path.resolve(projectRoot);
  const resolved = path.resolve(root, requested);
  if (resolved === root || !resolved.startsWith(`${root}${path.sep}`)) throw new Error('artifact path escapes project root');
  return resolved;
}

async function collectArtifactManifest(
  projectRoot: string,
  spec: RemoteWorkbenchJobSpec,
): Promise<RemoteWorkbenchArtifactManifestEntry[]> {
  const manifest: RemoteWorkbenchArtifactManifestEntry[] = [];
  const seen = new Set<string>();
  for (const requested of spec.artifacts ?? []) {
    if (seen.has(requested.path)) continue;
    seen.add(requested.path);
    const filePath = resolveProjectFile(projectRoot, requested.path);
    const stat = await fs.stat(filePath);
    if (!stat.isFile()) throw new Error(`artifact is not a regular file: ${requested.path}`);
    const content = await fs.readFile(filePath);
    manifest.push({
      path: requested.path,
      sizeBytes: stat.size,
      sha256: createHash('sha256').update(content).digest('hex'),
    });
  }
  return manifest;
}

function runtimeContext(spec: RemoteWorkbenchJobSpec, cwd: string, projectRoot: string, projections: Record<string, string>): RuntimeContext {
  const projection = Object.entries(projections)
    .sort(([, a], [, b]) => path.resolve(b).length - path.resolve(a).length)
    .find(([, source]) => cwd === path.resolve(source) || cwd.startsWith(`${path.resolve(source)}${path.sep}`));
  const logicalCwd = projection
    ? `${projection[0]}${cwd === path.resolve(projection[1]) ? '' : `/${path.relative(path.resolve(projection[1]), cwd).split(path.sep).join('/')}`}`
    : cwd === projectRoot ? '/workspace' : `/workspace/${path.relative(projectRoot, cwd).split(path.sep).join('/')}`;
  return {
    runtime: 'workbench-worker',
    workstation: {
      shell: 'native',
      persistent_home: true,
      host_tools: 'available',
      default_scope: 'current-project',
      guidance: 'This is the Project Workstation native shell. Start in the current Project and normally keep work there; use host tools or leave the Project directory when the task requires it. Warn before broad host changes and confirm destructive or external actions.',
    },
    project_id: spec.projectId,
    project_name: spec.projectId,
    cwd: logicalCwd,
    mount: 'project rw',
    services_running: [],
    box_limits: { memory_mb: 0, cpu: 0, idle_stop_minutes: 0 },
    credential_env: {
      injected: spec.environmentKeys.map(envName => ({ credential_id: 'run-scoped', env_name: envName })),
      materialized_files: [], skipped_existing: [], skipped: [], suppressed: false,
    },
  };
}

function redact(value: string, secrets: string[]): string {
  return secrets.reduce((text, secret) => secret ? text.split(secret).join('[REDACTED]') : text, value);
}

async function materializeRemoteGws(projectRoot: string, credentials: Record<string, string>): Promise<{ env: Record<string, string>; cleanup(): Promise<void> }> {
  const encoded = credentials.TOWER_REMOTE_GWS_CONFIG_B64;
  if (!encoded) return { env: {}, cleanup: async () => {} };
  const userId = credentials.TOWER_REMOTE_GWS_USER_ID;
  if (!userId || !/^\d+$/.test(userId)) throw new Error('remote GWS user id is invalid');
  const credentialRoot = path.resolve(projectRoot, '.tower-run-credentials');
  await fs.mkdir(credentialRoot, { recursive: true });
  const home = await fs.mkdtemp(path.join(credentialRoot, 'gws-'));
  const configRoot = path.join(home, '.config');
  const archive = path.join(home, 'gws-config.tar.gz');
  await fs.mkdir(configRoot, { recursive: true });
  await fs.writeFile(archive, Buffer.from(encoded, 'base64'), { mode: 0o600 });
  const unpack = spawn('tar', ['-xzf', archive, '-C', configRoot], { stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = '';
  unpack.stderr.on('data', chunk => { stderr += String(chunk); });
  const exitCode = await new Promise<number>((resolve, reject) => {
    unpack.once('error', reject);
    unpack.once('close', code => resolve(code ?? 1));
  });
  await fs.rm(archive, { force: true });
  if (exitCode !== 0) {
    await fs.rm(home, { recursive: true, force: true });
    throw new Error(`remote GWS config unpack failed: ${stderr.slice(0, 300)}`);
  }
  const gwsDir = path.join(configRoot, 'gws');
  const legacyCredentials = path.join(gwsDir, 'credentials.json');
  const userDir = path.join(gwsDir, 'users', userId);
  const userCredentials = path.join(userDir, 'credentials.json');
  try {
    await fs.access(legacyCredentials);
    try { await fs.access(userCredentials); }
    catch {
      await fs.mkdir(userDir, { recursive: true });
      await fs.copyFile(legacyCredentials, userCredentials);
      await fs.chmod(userCredentials, 0o600);
    }
  } catch {}
  return {
    env: { HOME: home, GWS_CONFIG_HOME: gwsDir },
    cleanup: () => fs.rm(home, { recursive: true, force: true }),
  };
}

function parseServiceProxyPath(requestUrl: string | undefined): { projectId: string; port: number; subPath: string } | undefined {
  const parsed = new URL(requestUrl || '/', 'http://worker.local');
  const match = /^\/v1\/services\/([^/]+)\/(\d{1,5})(\/.*)?$/.exec(parsed.pathname);
  if (!match) return undefined;
  const port = Number(match[2]);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('service port out of range');
  return { projectId: decodeURIComponent(match[1]), port, subPath: `${match[3] || '/'}${parsed.search}` };
}

function proxyHeaders(headers: http.IncomingHttpHeaders): http.OutgoingHttpHeaders {
  const next = { ...headers };
  delete next.authorization;
  delete next.host;
  delete next.connection;
  delete next['content-length'];
  next['x-tower-worker-proxy'] = '1';
  return next;
}

function proxyWorkerService(request: http.IncomingMessage, response: http.ServerResponse, target: { port: number; subPath: string }): void {
  const upstream = http.request({
    hostname: '127.0.0.1',
    port: target.port,
    path: target.subPath,
    method: request.method,
    headers: proxyHeaders(request.headers),
  }, upstreamResponse => {
    response.statusCode = upstreamResponse.statusCode || 502;
    for (const [key, value] of Object.entries(upstreamResponse.headers)) {
      if (value !== undefined) response.setHeader(key, value as string | string[]);
    }
    upstreamResponse.pipe(response);
  });
  upstream.on('error', error => {
    if (!response.headersSent) {
      response.statusCode = 502;
      response.setHeader('content-type', 'application/json; charset=utf-8');
      response.end(JSON.stringify({ error: 'WORKER_SERVICE_PROXY_FAILED', message: error.message }));
    } else {
      response.end();
    }
  });
  request.pipe(upstream);
}

async function executeRun(
  request: http.IncomingMessage,
  response: http.ServerResponse,
  spec: RemoteWorkbenchJobSpec,
  projectRoot: string,
  credentials: Record<string, string>,
  projections: Record<string, string> = {},
  operatorGitIdentity?: { name: string; email: string },
): Promise<void> {
  const cwd = resolveCwd(projectRoot, spec.cwd, projections);
  const started = Date.now();
  let stdout = '';
  let stderr = '';
  let timedOut = false;
  let cancelled = false;
  let cancellationSignal: 'SIGTERM' | 'SIGKILL' | undefined;
  const secretValues = Object.values(credentials);
  const gws = await materializeRemoteGws(projectRoot, credentials);
  const processCredentials = { ...credentials };
  delete processCredentials.TOWER_REMOTE_GWS_CONFIG_B64;
  delete processCredentials.TOWER_REMOTE_GWS_USER_ID;
  if (processCredentials.SSL_CERT_FILE) {
    try { await fs.access(processCredentials.SSL_CERT_FILE); }
    catch { delete processCredentials.SSL_CERT_FILE; }
  }
  const workerPath = process.env.PATH || '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin';
  const inheritedEnv: NodeJS.ProcessEnv = {};
  for (const key of ['LANG', 'LC_ALL', 'LC_CTYPE', 'TERM', 'COLORTERM', 'TZ', 'TMPDIR', 'SSL_CERT_FILE'] as const) {
    const value = process.env[key];
    if (value) inheritedEnv[key] = value;
  }
  const commandEnv: NodeJS.ProcessEnv = {
    ...inheritedEnv,
    PATH: workerPath,
    HOME: process.env.HOME || projectRoot,
    LANG: inheritedEnv.LANG || 'C.UTF-8',
    TOWER_REMOTE_WORKER: '1',
    TOWER_WORKSTATION_SHELL: 'native',
    TOWER_PROJECT_ROOT: projectRoot,
    ...processCredentials,
    ...(spec.sessionId ? { TOWER_SESSION_ID: spec.sessionId } : {}),
    ...(operatorGitIdentity ? {
      GIT_AUTHOR_NAME: operatorGitIdentity.name,
      GIT_AUTHOR_EMAIL: operatorGitIdentity.email,
      GIT_COMMITTER_NAME: operatorGitIdentity.name,
      GIT_COMMITTER_EMAIL: operatorGitIdentity.email,
    } : {}),
    ...gws.env,
  };
  const child = spawn('setsid', ['--wait', 'sh', '-c', spec.command], {
    cwd,
    env: commandEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const stop = () => {
    if (child.exitCode !== null || child.pid == null) return;
    cancelled = true;
    cancellationSignal = 'SIGTERM';
    try { process.kill(-child.pid, 'SIGTERM'); } catch {}
    setTimeout(() => {
      try {
        process.kill(-child.pid!, 'SIGKILL');
        cancellationSignal = 'SIGKILL';
      } catch {}
    }, 500).unref();
  };
  request.socket.on('close', stop);
  const timeout = setTimeout(() => { timedOut = true; stop(); }, (spec.timeoutSec ?? 60) * 1000);
  timeout.unref();

  child.stdout.on('data', chunk => {
    const text = redact(String(chunk), secretValues);
    stdout = (stdout + text).slice(0, MAX_OUTPUT);
    jsonLine(response, { type: 'stdout', chunk: text });
  });
  child.stderr.on('data', chunk => {
    const text = redact(String(chunk), secretValues);
    stderr = (stderr + text).slice(0, MAX_OUTPUT);
    jsonLine(response, { type: 'stderr', chunk: text });
  });

  const exitCode = await new Promise<number>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => resolve(code ?? (signal === 'SIGKILL' ? 137 : 143)));
  }).finally(async () => {
    clearTimeout(timeout);
    request.socket.off('close', stop);
    await gws.cleanup();
  });

  if (!response.writableEnded && !response.destroyed) {
    const execResult: ExecResult = {
      exit_code: timedOut ? 124 : exitCode,
      stdout,
      stderr,
      duration_ms: Date.now() - started,
      timed_out: timedOut,
      oom_killed: !cancelled && exitCode === 137,
      runtime_context: runtimeContext(spec, cwd, projectRoot, projections),
    };
    const artifacts = execResult.exit_code === 0 ? await collectArtifactManifest(projectRoot, spec) : [];
    jsonLine(response, {
      type: 'result',
      result: {
        execResult,
        artifacts,
        cancellation: {
          requested: cancelled,
          processGroupExited: true,
          ...(cancellationSignal ? { signal: cancellationSignal } : {}),
        },
      },
    });
    response.end();
  }
}

/** Create a narrow Worker server; caller owns listen/close lifecycle and token distribution. */
export function createRemoteWorkbenchWorkerServer(options: RemoteWorkbenchWorkerServerOptions): http.Server {
  if (!options.token) throw new Error('Remote Worker token is required');
  return http.createServer(async (request, response) => {
    if (request.method === 'GET' && request.url === '/health') {
      response.setHeader('content-type', 'application/x-ndjson; charset=utf-8');
      response.end(`${JSON.stringify({ ok: true, workerId: options.workerId })}\n`);
      return;
    }
    if (!authorized(request.headers.authorization, options.token)) {
      response.statusCode = 401;
      response.setHeader('content-type', 'application/x-ndjson; charset=utf-8');
      jsonLine(response, { type: 'error', code: 'UNAUTHORIZED', message: 'valid Worker bearer token required' });
      response.end();
      return;
    }

    const parsedUrl = new URL(request.url || '/', 'http://worker.local');
    const manifestMatch = /^\/v1\/files\/([^/]+)\/manifest$/.exec(parsedUrl.pathname);
    if (request.method === 'GET' && manifestMatch) {
      const projectId = decodeURIComponent(manifestMatch[1]);
      const projectRoot = options.projects[projectId];
      const relativePath = parsedUrl.searchParams.get('path') || '';
      const maxFiles = Math.max(1, Math.min(Number(parsedUrl.searchParams.get('maxFiles')) || 2000, 10_000));
      const maxBytes = Math.max(1, Math.min(Number(parsedUrl.searchParams.get('maxBytes')) || 512 * 1024 * 1024, 2 * 1024 * 1024 * 1024));
      if (!projectRoot) {
        response.statusCode = 403;
        response.end(JSON.stringify({ error: 'WORKER_PROJECT_NOT_ALLOWLISTED' }));
        return;
      }
      try {
        const manifest = await collectProjectSubtreeManifest({ projectRoot, relativePath, maxFiles, maxBytes });
        response.setHeader('content-type', 'application/json; charset=utf-8');
        response.end(JSON.stringify(manifest));
      } catch (error) {
        response.statusCode = 400;
        response.setHeader('content-type', 'application/json; charset=utf-8');
        response.end(JSON.stringify({ error: 'WORKER_FILE_MANIFEST_FAILED', message: (error as Error).message }));
      }
      return;
    }

    const uploadMatch = /^\/v1\/files\/([^/]+)\/content$/.exec(parsedUrl.pathname);
    if (request.method === 'GET' && uploadMatch) {
      const projectId = decodeURIComponent(uploadMatch[1]);
      const projectRoot = options.projects[projectId];
      const relativePath = parsedUrl.searchParams.get('path') || '';
      if (!projectRoot) {
        response.statusCode = 403;
        response.end(JSON.stringify({ error: 'WORKER_PROJECT_NOT_ALLOWLISTED' }));
        return;
      }
      try {
        await streamProjectFileDownload({ request, response, projectRoot, relativePath });
      } catch (error) {
        response.statusCode = 404;
        response.setHeader('content-type', 'application/json; charset=utf-8');
        response.end(JSON.stringify({ error: 'WORKER_FILE_DOWNLOAD_FAILED', message: (error as Error).message }));
      }
      return;
    }
    if (request.method === 'PUT' && uploadMatch) {
      const projectId = decodeURIComponent(uploadMatch[1]);
      const projectRoot = options.projects[projectId];
      const relativePath = parsedUrl.searchParams.get('path') || '';
      if (!projectRoot) {
        response.statusCode = 403;
        response.end(JSON.stringify({ error: 'WORKER_PROJECT_NOT_ALLOWLISTED' }));
        return;
      }
      try {
        await receiveProjectFileUpload({ request, response, projectRoot, relativePath });
      } catch (error) {
        response.statusCode = 400;
        response.setHeader('content-type', 'application/json; charset=utf-8');
        response.end(JSON.stringify({ error: 'WORKER_FILE_UPLOAD_FAILED', message: (error as Error).message }));
      }
      return;
    }

    const serviceTarget = parseServiceProxyPath(request.url);
    if (serviceTarget) {
      if (!options.projects[serviceTarget.projectId]) {
        response.statusCode = 403;
        response.setHeader('content-type', 'application/json; charset=utf-8');
        response.end(JSON.stringify({ error: 'WORKER_PROJECT_NOT_ALLOWLISTED' }));
        return;
      }
      proxyWorkerService(request, response, serviceTarget);
      return;
    }

    response.setHeader('content-type', 'application/x-ndjson; charset=utf-8');
    if (request.method !== 'POST' || request.url !== '/v1/runs') {
      response.statusCode = 404;
      jsonLine(response, { type: 'error', code: 'NOT_FOUND', message: 'route not found' });
      response.end();
      return;
    }
    try {
      const body = await readJson(request) as { spec?: unknown; credentials?: unknown };
      if (!validSpec(body.spec)) throw new Error('invalid Remote Job spec');
      const credentials = body.credentials === undefined ? {} : body.credentials;
      if (!credentials || typeof credentials !== 'object' || Array.isArray(credentials)) throw new Error('invalid run-scoped Credentials');
      const entries = Object.entries(credentials as Record<string, unknown>);
      if (entries.some(([key, value]) => !/^[A-Z][A-Z0-9_]{0,63}$/.test(key) || typeof value !== 'string' || !value)) throw new Error('invalid run-scoped Credentials');
      const credentialKeys = entries.map(([key]) => key).sort();
      if (JSON.stringify(credentialKeys) !== JSON.stringify([...body.spec.environmentKeys].sort())) throw new Error('Credential key scope mismatch');
      const projectRoot = options.projects[body.spec.projectId];
      if (!projectRoot) throw new Error('project is not allowlisted on this Worker');
      const workspaceRoot = resolveWorkspaceRoot(projectRoot, body.spec.workspaceId);
      const workspaceStat = await fs.stat(workspaceRoot);
      if (!workspaceStat.isDirectory()) throw new Error('prepared workspace is not a directory');
      response.statusCode = 200;
      await executeRun(request, response, body.spec, workspaceRoot, credentials as Record<string, string>, options.projections, options.operatorGitIdentity);
    } catch (error) {
      if (!response.headersSent) response.statusCode = 400;
      if (!response.writableEnded && !response.destroyed) {
        jsonLine(response, { type: 'error', code: 'INVALID_RUN', message: (error as Error).message });
        response.end();
      }
    }
  });
}

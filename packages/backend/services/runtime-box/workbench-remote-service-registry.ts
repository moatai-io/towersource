/**
 * Owns: Remote Worker backed managed Service rows in runtime_box_services.
 * Public API: registerAndStartRemoteWorkerService, readRemoteWorkerServiceLogs,
 *             stopRemoteWorkerService.
 * See: packages/backend/services/runtime-box/README.md.
 */

import { randomBytes } from 'node:crypto';
import { execute } from '../../db/pg-repo.js';
import { queryServiceOne, queryServices } from './runtime-box-row-repository.js';
import { RuntimeBoxError } from './runtime-box-manager.js';
import type { ServiceRegisterRequest, ServiceRow } from './types.js';
import type { RemoteWorkbenchWorkerTransport } from './workbench-remote-job-runner.js';

function makePreviewToken(): string {
  return randomBytes(16).toString('hex');
}

function makeWorkerPreviewUrl(input: { workerId: string; projectId: string; port: number }): string {
  return `/api/workbench-workers/preview/${encodeURIComponent(input.workerId)}/${encodeURIComponent(input.projectId)}/${input.port}/`;
}

function normalizeWorkerCwd(rawCwd: string | null | undefined): string {
  const cwd = rawCwd?.trim() || '/workspace';
  if (cwd !== '/workspace' && !cwd.startsWith('/workspace/')) {
    throw new RuntimeBoxError(`worker service cwd boundary violation: "${rawCwd}" must be /workspace or below`);
  }
  return cwd;
}

function shellSingleQuoted(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function servicePaths(serviceId: number, serviceName: string) {
  const safeName = serviceName.replace(/[^a-z0-9-]/g, '-').slice(0, 64) || 'service';
  return {
    safeName,
    pidPath: `.worker-service/pids/service-${serviceId}.pid`,
    logPath: `.worker-service/logs/service-${serviceId}-${safeName}.log`,
  };
}

async function runWorkerControl(input: {
  transport: RemoteWorkbenchWorkerTransport;
  projectId: string;
  command: string;
  cwd?: string;
  timeoutSec?: number;
}): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const result = await input.transport.execute({
    spec: {
      jobId: 900_000_000 + Math.floor(Math.random() * 99_999_999),
      projectId: input.projectId,
      command: input.command,
      cwd: input.cwd,
      timeoutSec: input.timeoutSec ?? 30,
      workbenchRevision: null,
      environmentKeys: [],
    },
    credentials: {},
    signal: new AbortController().signal,
    onStdout: () => {},
    onStderr: () => {},
  });
  return {
    stdout: result.execResult.stdout,
    stderr: result.execResult.stderr,
    exitCode: result.execResult.exit_code,
  };
}

/** Register or update a remote Worker service row, then start the service on the Worker. */
export async function registerAndStartRemoteWorkerService(input: {
  request: ServiceRegisterRequest;
  workerId: string;
  transport: RemoteWorkbenchWorkerTransport;
}): Promise<ServiceRow> {
  const cwd = normalizeWorkerCwd(input.request.cwd);
  const now = new Date();
  const ttlHours = input.request.ttlHours ?? 2;
  const expiresAt = input.request.pinned ? null : new Date(now.getTime() + ttlHours * 60 * 60 * 1000);
  const reviewAfter = input.request.pinned ? new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000) : null;
  const previewToken = input.request.internalPort ? makePreviewToken() : null;
  const externalUrl = input.request.internalPort ? makeWorkerPreviewUrl({
    workerId: input.workerId,
    projectId: input.request.projectId,
    port: input.request.internalPort,
  }) : null;

  const rows = await queryServices(
    `INSERT INTO runtime_box_services
       (box_id, runner_kind, worker_id, project_id, name, display_name, command, cwd,
        internal_port, host_port, external_url, preview_token, visibility, pinned, purpose,
        owner_user_id, ttl_hours, review_after,
        status, started_at, stopped_at, expires_at, created_by,
        process_pid, log_path, last_error)
     VALUES (NULL, 'remote-worker', $1, $2, $3, $4, $5, $6,
             $7, NULL, $8, $9, $10, $11, $12,
             $13, $14, $15,
             'pending', NULL, NULL, $16, $17,
             NULL, NULL, NULL)
     ON CONFLICT (project_id, worker_id, name) WHERE runner_kind = 'remote-worker'
     DO UPDATE SET
       command = EXCLUDED.command,
       cwd = EXCLUDED.cwd,
       internal_port = EXCLUDED.internal_port,
       external_url = COALESCE(EXCLUDED.external_url, runtime_box_services.external_url),
       preview_token = COALESCE(EXCLUDED.preview_token, runtime_box_services.preview_token),
       visibility = EXCLUDED.visibility,
       status = 'pending',
       stopped_at = NULL,
       expires_at = EXCLUDED.expires_at,
       pinned = EXCLUDED.pinned,
       purpose = EXCLUDED.purpose,
       ttl_hours = EXCLUDED.ttl_hours,
       review_after = EXCLUDED.review_after,
       last_error = NULL
     RETURNING *`,
    [
      input.workerId,
      input.request.projectId,
      input.request.name,
      input.request.displayName ?? null,
      input.request.command,
      cwd,
      input.request.internalPort ?? null,
      externalUrl,
      previewToken,
      input.request.visibility ?? 'project-internal',
      input.request.pinned ?? false,
      input.request.purpose ?? null,
      input.request.userId,
      ttlHours,
      reviewAfter,
      expiresAt,
      input.request.userId,
    ],
  );
  const service = rows[0];
  const paths = servicePaths(service.id, service.name);
  const startScript = [
    'set -eu',
    'mkdir -p .worker-service/logs .worker-service/pids',
    `LOG_PATH=${shellSingleQuoted(paths.logPath)}`,
    `PID_PATH=${shellSingleQuoted(paths.pidPath)}`,
    'if [ -f "$PID_PATH" ]; then',
    '  OLD_PID=$(cat "$PID_PATH" 2>/dev/null || true)',
    '  if [ -n "$OLD_PID" ] && kill -0 "$OLD_PID" 2>/dev/null; then',
    '    kill -TERM "$OLD_PID" 2>/dev/null || true',
    '    sleep 0.5',
    '  fi',
    'fi',
    `printf '[%s] starting: %s\\n' "$(date -Is)" ${shellSingleQuoted(input.request.command)} >> "$LOG_PATH"`,
    `nohup sh -c ${shellSingleQuoted(input.request.command)} >> "$LOG_PATH" 2>&1 < /dev/null &`,
    'PID=$!',
    'echo "$PID" > "$PID_PATH"',
    'sleep 0.5',
    'if ! kill -0 "$PID" 2>/dev/null; then',
    '  printf "[%s] process exited immediately\\n" "$(date -Is)" >> "$LOG_PATH"',
    '  tail -n 40 "$LOG_PATH" >&2 || true',
    '  exit 2',
    'fi',
    'printf "%s\\t%s\\n" "$PID" "$LOG_PATH"',
  ].join('\n');

  const result = await runWorkerControl({
    transport: input.transport,
    projectId: input.request.projectId,
    cwd,
    command: startScript,
    timeoutSec: 30,
  });

  if (result.exitCode !== 0) {
    await execute(
      `UPDATE runtime_box_services
          SET status = 'error', last_error = $2, stopped_at = now(), process_pid = NULL
        WHERE id = $1`,
      [service.id, `worker service start failed: ${result.stderr || result.stdout}`.slice(0, 2000)],
    );
    throw new RuntimeBoxError(`worker service ${service.name} start failed: ${(result.stderr || result.stdout).slice(0, 1000)}`);
  }

  const [pidRaw, logPathRaw] = result.stdout.trim().split(/\s+/, 2);
  const processPid = Number(pidRaw);
  if (!Number.isInteger(processPid) || processPid <= 0 || !logPathRaw) {
    throw new RuntimeBoxError(`worker service ${service.name} start result parse failed: ${result.stdout.trim()}`);
  }

  const updated = await queryServices(
    `UPDATE runtime_box_services
        SET status = 'running', process_pid = $2, log_path = $3,
            started_at = now(), stopped_at = NULL, last_active_at = now(), last_error = NULL
      WHERE id = $1
      RETURNING *`,
    [service.id, processPid, logPathRaw],
  );
  return updated[0];
}

/** Tail logs for a remote Worker service. */
export async function readRemoteWorkerServiceLogs(input: {
  service: ServiceRow;
  transport: RemoteWorkbenchWorkerTransport;
  tail?: number;
}): Promise<string> {
  const safeTail = Math.max(1, Math.min(Math.floor(input.tail ?? 100), 5000));
  if (!input.service.log_path) return '(service has no log_path yet)';
  const result = await runWorkerControl({
    transport: input.transport,
    projectId: input.service.project_id,
    cwd: input.service.cwd,
    command: `test -f ${shellSingleQuoted(input.service.log_path)} || { echo "(log file not found: ${input.service.log_path})"; exit 0; }; tail -n ${safeTail} ${shellSingleQuoted(input.service.log_path)}`,
    timeoutSec: 15,
  });
  if (result.exitCode !== 0) throw new RuntimeBoxError(`worker service ${input.service.name} logs failed: ${(result.stderr || result.stdout).slice(0, 1000)}`);
  return result.stdout || '(no logs)';
}

/** Stop a remote Worker service by tracked PID and mark the row stopped. */
export async function stopRemoteWorkerService(input: {
  service: ServiceRow;
  transport: RemoteWorkbenchWorkerTransport;
}): Promise<void> {
  if (input.service.process_pid) {
    await runWorkerControl({
      transport: input.transport,
      projectId: input.service.project_id,
      cwd: input.service.cwd,
      command: `PID=${Number(input.service.process_pid)}; if kill -0 "$PID" 2>/dev/null; then kill -TERM "$PID" 2>/dev/null || true; sleep 0.5; kill -0 "$PID" 2>/dev/null && kill -KILL "$PID" 2>/dev/null || true; fi`,
      timeoutSec: 15,
    });
  }
  await execute(
    `UPDATE runtime_box_services
       SET status = 'stopped', stopped_at = now(), process_pid = NULL
     WHERE id = $1`,
    [input.service.id],
  );
}

/** Lookup a remote Worker service row. */
export async function getRemoteWorkerService(serviceId: number): Promise<ServiceRow | undefined> {
  const service = await queryServiceOne('SELECT * FROM runtime_box_services WHERE id = $1', [serviceId]);
  return service?.runner_kind === 'remote-worker' ? service : undefined;
}

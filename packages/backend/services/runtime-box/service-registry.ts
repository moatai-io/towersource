/**
 * service-registry.ts — Project Runtime Box 서비스 레지스트리 + v1 프로세스 supervision.
 *
 * Owns: Box 안 장기 실행 서비스의 등록·조회·start/stop/logs·pin·TTL 만료.
 * Public API: registerService, startServiceProcess, readServiceLogs, getService,
 *             listServices, stopService, pinService, expireStaleServices.
 * See README.md.
 *
 * 결정: workspace/decisions/2026-06-01-project-runtime-plane-devbox-services.md §Service Registry
 */

import { randomBytes } from 'crypto';
import { spawn } from 'child_process';
import path from 'path';
import { config } from '../../config.js';
import { execute, queryOne } from '../../db/pg-repo.js';
import { queryBoxOne, queryServiceOne, queryServices } from './runtime-box-row-repository.js';
import type { BoxRow, ServiceRow, ServiceRegisterRequest } from './types.js';
import { BOX_WORKDIR, RuntimeBoxError } from './runtime-box-manager.js';
import {
  assertRuntimeBoxLifecycleLockHeld,
  tryWithRuntimeBoxLifecycleLock,
  withRuntimeBoxLifecycleLock,
  type RuntimeBoxLifecycleLockHeld,
} from './runtime-box-lifecycle-lock.js';
import { withWorkbenchToolPath } from './workbench-tools.js';
import { getPersistedWorkbenchWorker } from '../execution/worker/worker-repository.js';
import { resolveWorkbenchWorkerTransportToken } from '../execution/worker/worker-transport-credentials.js';
import { createRemoteWorkbenchHttpTransport } from '../execution/worker/worker-http-transport.js';
import { readRemoteWorkerServiceLogs, stopRemoteWorkerService } from './workbench-remote-service-registry.js';
import type { RemoteWorkbenchWorkerTransport } from '../execution/remote-job-runner.js';
import { resolveProjectEnvironmentDeploymentId } from '../project-environment/project-environment-deployment.js';
import { listProjectWorkspaceAuthorities } from '../project-environment/project-workspace-authority.js';

// ── Docker exec helper ───────────────────────────────────────────────────

async function spawnDockerCmd(
  args: string[],
  opts: { timeoutMs?: number } = {},
): Promise<{ stdout: string; stderr: string; exitCode: number; timedOut: boolean }> {
  const dockerBin = config.runtimeBox.dockerBin;
  const MAX_OUTPUT = 1_048_576;

  return new Promise((resolve) => {
    let timedOut = false;
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let stdoutLen = 0;
    let stderrLen = 0;

    let proc: ReturnType<typeof spawn>;
    try {
      proc = spawn(dockerBin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (spawnErr) {
      resolve({ stdout: '', stderr: (spawnErr as Error).message, exitCode: -1, timedOut: false });
      return;
    }

    proc.stdout?.on('data', (chunk: Buffer) => {
      if (stdoutLen < MAX_OUTPUT) {
        stdoutChunks.push(chunk);
        stdoutLen += chunk.length;
      }
    });
    proc.stderr?.on('data', (chunk: Buffer) => {
      if (stderrLen < MAX_OUTPUT) {
        stderrChunks.push(chunk);
        stderrLen += chunk.length;
      }
    });

    let timer: ReturnType<typeof setTimeout> | null = null;
    if (opts.timeoutMs) {
      timer = setTimeout(() => {
        timedOut = true;
        proc.kill('SIGKILL');
      }, opts.timeoutMs);
    }

    proc.on('error', (err) => {
      if (timer) clearTimeout(timer);
      const code = (err as NodeJS.ErrnoException).code;
      const msg = code === 'ENOENT'
        ? `Docker binary "${dockerBin}" not found. Is Docker installed and in PATH?`
        : err.message;
      resolve({ stdout: '', stderr: msg, exitCode: -1, timedOut: false });
    });

    proc.on('close', (code) => {
      if (timer) clearTimeout(timer);
      resolve({
        stdout: stdoutChunks.length > 0 ? Buffer.concat(stdoutChunks).toString('utf8').slice(0, MAX_OUTPUT) : '',
        stderr: stderrChunks.length > 0 ? Buffer.concat(stderrChunks).toString('utf8').slice(0, MAX_OUTPUT) : '',
        exitCode: code ?? -1,
        timedOut,
      });
    });
  });
}

function containerRefForBox(box: Pick<BoxRow, 'id' | 'container_id'>): string {
  return box.container_id || `tower-box-${box.id}`;
}

function normalizeBoxCwd(rawCwd: string | null | undefined): string {
  const cwd = path.posix.normalize(rawCwd || BOX_WORKDIR);
  if (cwd !== BOX_WORKDIR && !cwd.startsWith(BOX_WORKDIR + '/')) {
    throw new RuntimeBoxError(`service cwd 경계 위반: "${rawCwd}" 는 "${BOX_WORKDIR}" 또는 그 하위여야 함`);
  }
  return cwd;
}

function safeServiceName(name: string): string {
  return name.replace(/[^a-z0-9-]/g, '-').slice(0, 64) || 'service';
}

function makePreviewToken(): string {
  return randomBytes(16).toString('hex');
}

function makePreviewUrl(token: string): string {
  // Same-origin path. Dev/prod hosts differ (desk-dev vs desk/prod), so using
  // config.publicUrl here can point a dev session at prod. The frontend/chat can
  // resolve this path against the current browser origin.
  return `/api/runtime-box/preview/${token}/`;
}

export async function remoteServiceTransport(
  svc: ServiceRow,
  actorUserId?: number,
  dependencies: {
    getWorker: typeof getPersistedWorkbenchWorker;
    listAuthorities: typeof listProjectWorkspaceAuthorities;
    deploymentId: string;
    resolveToken: typeof resolveWorkbenchWorkerTransportToken;
    readProjectRoot(projectId: string): Promise<string | undefined>;
    createTransport: typeof createRemoteWorkbenchHttpTransport;
  } = {
    getWorker: getPersistedWorkbenchWorker,
    listAuthorities: listProjectWorkspaceAuthorities,
    deploymentId: resolveProjectEnvironmentDeploymentId(),
    resolveToken: resolveWorkbenchWorkerTransportToken,
    readProjectRoot: async projectId => (await queryOne<{ root_path: string }>('SELECT root_path FROM projects WHERE id=$1', [projectId]))?.root_path,
    createTransport: createRemoteWorkbenchHttpTransport,
  },
): Promise<RemoteWorkbenchWorkerTransport> {
  if (svc.runner_kind !== 'remote-worker' || !svc.worker_id) throw new RuntimeBoxError(`service ${svc.id} is not a remote Worker service`);
  const worker = await dependencies.getWorker(svc.worker_id, { staleAfterMs: 300_000 });
  if (!worker) throw new RuntimeBoxError(`worker ${svc.worker_id} is unavailable for service ${svc.id}`);
  const authority = (await dependencies.listAuthorities(dependencies.deploymentId))
    .find(row => row.project_id === svc.project_id && row.deployment_id === dependencies.deploymentId);
  const canonicalReady = authority?.storage_kind === 'host' && authority.worker_id === null && authority.state === 'ready';
  if (!canonicalReady && !worker.projectIds.includes(svc.project_id)) {
    throw new RuntimeBoxError(`worker ${svc.worker_id} is unavailable for service ${svc.id}`);
  }
  const userId = actorUserId ?? svc.owner_user_id ?? svc.created_by ?? 1;
  const token = await dependencies.resolveToken(svc.worker_id, userId);
  if (!token) throw new RuntimeBoxError(`worker ${svc.worker_id} transport credential is not configured`);
  const projectRoot = canonicalReady ? await dependencies.readProjectRoot(svc.project_id) : undefined;
  if (canonicalReady && !projectRoot) throw new RuntimeBoxError(`canonical Project root is unavailable for service ${svc.id}`);
  return dependencies.createTransport({ workerId: worker.workerId, baseUrl: worker.baseUrl, token, projectRoot });
}

// ── 서비스 등록 ───────────────────────────────────────────────────────────

/**
 * Box 안에서 실행할 장기 서비스를 등록한다.
 * 이미 같은 name 이 있으면 command/port/TTL metadata 를 갱신하고 status=pending 으로 되돌린다.
 * 실제 프로세스 시작은 startServiceProcess() 가 담당한다.
 */
export async function registerService(req: ServiceRegisterRequest): Promise<ServiceRow> {
  return withRuntimeBoxLifecycleLock(req.boxId, held => registerServiceWithLifecycleLockHeld(req, held));
}

async function registerServiceWithLifecycleLockHeld(
  req: ServiceRegisterRequest,
  held: RuntimeBoxLifecycleLockHeld,
): Promise<ServiceRow> {
  assertRuntimeBoxLifecycleLockHeld(held, req.boxId);
  const box = await queryBoxOne('SELECT * FROM project_runtime_boxes WHERE id = $1', [req.boxId]);
  if (!box) throw new RuntimeBoxError(`box ${req.boxId} not found`);
  if (box.project_id !== req.projectId) {
    throw new RuntimeBoxError(`box ${req.boxId} does not belong to project ${req.projectId}`);
  }

  const now = new Date();
  const ttlHours = req.ttlHours ?? 2;
  const expiresAt = new Date(now.getTime() + ttlHours * 60 * 60 * 1000);

  // pinned=true 이면 TTL 대신 review_after 7일 설정
  const reviewAfter = req.pinned
    ? new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000)
    : null;

  const previewToken = req.internalPort ? makePreviewToken() : null;
  const externalUrl = previewToken ? makePreviewUrl(previewToken) : null;

  const rows = await queryServices(
    `INSERT INTO runtime_box_services
       (box_id, project_id, name, display_name, command, cwd,
        internal_port, host_port, external_url, preview_token, visibility, pinned, purpose,
        owner_user_id, ttl_hours, review_after,
        status, started_at, stopped_at, expires_at, created_by,
        process_pid, log_path, last_error)
     VALUES ($1, $2, $3, $4, $5, $6, $7, NULL, $8, $9, $10, $11, $12, $13, $14, $15,
             'pending', NULL, NULL, $16, $17, NULL, NULL, NULL)
     ON CONFLICT (box_id, name)
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
      req.boxId, req.projectId, req.name, req.displayName ?? null,
      req.command, normalizeBoxCwd(req.cwd),
      req.internalPort ?? null,
      externalUrl,
      previewToken,
      req.visibility ?? 'project-internal',
      req.pinned ?? false,
      req.purpose ?? null,
      req.userId,
      ttlHours,
      reviewAfter,
      expiresAt,
      req.userId,
    ],
  );

  return rows[0];
}

// ── 서비스 조회 ───────────────────────────────────────────────────────────

/** Box 안의 특정 서비스 조회. */
export async function getService(boxId: number, name: string): Promise<ServiceRow | undefined> {
  return queryServiceOne(
    'SELECT * FROM runtime_box_services WHERE box_id = $1 AND name = $2',
    [boxId, name],
  );
}

/** 프로젝트의 모든 서비스 목록 (AI-readable). */
export async function listServices(projectId: string, opts?: {
  statusFilter?: string[];
}): Promise<ServiceRow[]> {
  const statusFilter = opts?.statusFilter ?? ['running', 'pending'];
  const placeholders = statusFilter.map((_, i) => `$${i + 2}`).join(', ');

  return queryServices(
    `SELECT * FROM runtime_box_services
     WHERE project_id = $1 AND status IN (${placeholders})
     ORDER BY started_at DESC NULLS LAST`,
    [projectId, ...statusFilter],
  );
}

/** 서비스 레지스트리 요약 (AI 에게 보여주는 포맷). */
export function formatServiceList(services: ServiceRow[]): string {
  if (services.length === 0) {
    return '실행 중인 서비스 없음. Runtime Box 자체는 idle-stop 시각까지 warm 상태로 남아 사용자 실행 슬롯을 점유할 수 있습니다.';
  }

  return services.map(s => {
    const port = s.internal_port ? `:${s.internal_port}` : '';
    const pin = s.pinned ? ' [PINNED]' : '';
    const url = s.external_url ? ` → ${s.external_url}` : '';
    const pid = s.process_pid ? ` pid=${s.process_pid}` : '';
    const log = s.log_path ? ` log=${s.log_path}` : '';
    const runner = s.runner_kind === 'remote-worker' ? ` worker=${s.worker_id}` : ' runtime-box';
    return `  #${s.id} ${s.name}${port} (${s.status}${pid}${runner})${pin}${url}${log} — ${s.command}`;
  }).join('\n');
}

// ── 프로세스 supervision ────────────────────────────────────────────────

async function stopServiceProcessIfNeeded(svc: ServiceRow, box: BoxRow): Promise<void> {
  if (!svc.process_pid) return;
  const script = [
    'set +e',
    'PID="$SERVICE_PID"',
    'if kill -0 "$PID" 2>/dev/null; then',
    '  # Services are started in a new process group via setsid. Kill the group first',
    '  # so npm/vite/python children do not survive after the tracked shell exits.',
    '  kill -TERM "-$PID" 2>/dev/null || kill -TERM "$PID" 2>/dev/null || true',
    '  for i in 1 2 3 4 5 6 7 8 9 10; do',
    '    kill -0 "$PID" 2>/dev/null || exit 0',
    '    sleep 0.2',
    '  done',
    '  kill -KILL "-$PID" 2>/dev/null || kill -KILL "$PID" 2>/dev/null || true',
    'fi',
  ].join('\n');
  await spawnDockerCmd([
    'exec',
    '-e', `SERVICE_PID=${svc.process_pid}`,
    containerRefForBox(box),
    'sh', '-lc', script,
  ], { timeoutMs: 10_000 });
}

/**
 * 등록된 서비스를 Runtime Box 컨테이너 안에서 실제 장기 프로세스로 시작한다.
 * stdout/stderr 는 /workspace/.runtime-box/logs/service-<id>-<name>.log 에 저장된다.
 */
export async function startServiceProcess(serviceId: number): Promise<ServiceRow> {
  const candidate = await queryServiceOne(
    'SELECT * FROM runtime_box_services WHERE id = $1',
    [serviceId],
  );
  if (!candidate) throw new RuntimeBoxError(`service ${serviceId} not found`);
  if (candidate.box_id == null) throw new RuntimeBoxError(`service ${serviceId} has no Runtime Box owner`);
  return withRuntimeBoxLifecycleLock(candidate.box_id, held =>
    startServiceProcessWithLifecycleLockHeld(serviceId, candidate.box_id!, held));
}

async function startServiceProcessWithLifecycleLockHeld(
  serviceId: number,
  expectedBoxId: number,
  held: RuntimeBoxLifecycleLockHeld,
): Promise<ServiceRow> {
  assertRuntimeBoxLifecycleLockHeld(held, expectedBoxId);
  const svc = await queryServiceOne('SELECT * FROM runtime_box_services WHERE id = $1', [serviceId]);
  if (!svc) throw new RuntimeBoxError(`service ${serviceId} not found`);
  if (svc.box_id !== expectedBoxId) throw new RuntimeBoxError(`service ${serviceId} changed Runtime Box ownership`);

  const box = await queryBoxOne('SELECT * FROM project_runtime_boxes WHERE id = $1', [svc.box_id]);
  if (!box || box.status !== 'running') {
    throw new RuntimeBoxError(`box ${svc.box_id} is not running; call ensureRunning() before startServiceProcess()`);
  }

  await stopServiceProcessIfNeeded(svc, box);

  const cwd = normalizeBoxCwd(svc.cwd);
  const name = safeServiceName(svc.name);
  const commandB64 = Buffer.from(svc.command, 'utf8').toString('base64');
  const workbenchPath = withWorkbenchToolPath(undefined);
  const script = [
    'set -eu',
    'mkdir -p .runtime-box/logs .runtime-box/pids',
    'LOG_PATH="$PWD/.runtime-box/logs/service-${SERVICE_ID}-${SERVICE_NAME}.log"',
    'PID_PATH="$PWD/.runtime-box/pids/service-${SERVICE_ID}.pid"',
    'CMD=$(printf %s "$SERVICE_CMD_B64" | base64 -d)',
    'printf "[%s] starting: %s\\n" "$(date -Is)" "$CMD" >> "$LOG_PATH"',
    // Avoid a second login shell here: `sh -lc` may replace the PATH even when
    // docker exec supplied it. The outer control shell has already established
    // the service environment, so a non-login command shell preserves it.
    'nohup setsid env PATH="$SERVICE_PATH" sh -c "$CMD" >> "$LOG_PATH" 2>&1 < /dev/null &',
    'PID=$!',
    'echo "$PID" > "$PID_PATH"',
    'sleep 0.3',
    'if ! kill -0 "$PID" 2>/dev/null; then',
    '  printf "[%s] process exited immediately\\n" "$(date -Is)" >> "$LOG_PATH"',
    '  tail -n 40 "$LOG_PATH" >&2 || true',
    '  exit 2',
    'fi',
    'printf "%s\\t%s\\n" "$PID" "$LOG_PATH"',
  ].join('\n');

  const previewEnv = svc.external_url
    ? [
        '-e', `TOWER_RUNTIME_BOX_PREVIEW_URL=${svc.external_url}`,
        '-e', `TOWER_RUNTIME_BOX_PREVIEW_BASE=${svc.external_url}`,
      ]
    : [];

  const result = await spawnDockerCmd([
    'exec', '-w', cwd,
    '-e', `SERVICE_ID=${svc.id}`,
    '-e', `SERVICE_NAME=${name}`,
    '-e', `SERVICE_CMD_B64=${commandB64}`,
    '-e', `SERVICE_PATH=${workbenchPath}`,
    '-e', `PATH=${workbenchPath}`,
    ...previewEnv,
    containerRefForBox(box),
    'sh', '-lc', script,
  ], { timeoutMs: 15_000 });

  if (result.exitCode !== 0) {
    await execute(
      `UPDATE runtime_box_services
          SET status = 'error', last_error = $2, stopped_at = now(), process_pid = NULL
        WHERE id = $1`,
      [serviceId, `service start failed: ${result.stderr || result.stdout}`.slice(0, 2000)],
    );
    throw new RuntimeBoxError(`service ${svc.name} start 실패: ${(result.stderr || result.stdout).slice(0, 1000)}`);
  }

  const [pidRaw, logPathRaw] = result.stdout.trim().split(/\s+/, 2);
  const processPid = Number(pidRaw);
  if (!Number.isInteger(processPid) || processPid <= 0 || !logPathRaw) {
    throw new RuntimeBoxError(`service ${svc.name} start 결과 파싱 실패: ${result.stdout.trim()}`);
  }

  const rows = await queryServices(
    `UPDATE runtime_box_services
        SET status = 'running', process_pid = $2, log_path = $3,
            started_at = now(), stopped_at = NULL, last_active_at = now(), last_error = NULL
      WHERE id = $1
      RETURNING *`,
    [serviceId, processPid, logPathRaw],
  );
  return rows[0];
}

export interface RuntimeBoxPreviewTarget {
  service: ServiceRow;
  box: BoxRow;
  targetBaseUrl: string;
}

/** preview_token 으로 현재 service 의 container IP/port proxy target 을 조회. */
export async function getPreviewTargetByToken(token: string): Promise<RuntimeBoxPreviewTarget | undefined> {
  const svc = await queryServiceOne(
    `SELECT * FROM runtime_box_services
     WHERE preview_token = $1
       AND status = 'running'
       AND internal_port IS NOT NULL`,
    [token],
  );
  if (!svc) return undefined;

  const box = await queryBoxOne('SELECT * FROM project_runtime_boxes WHERE id = $1', [svc.box_id]);
  if (!box || box.status !== 'running') return undefined;

  const result = await spawnDockerCmd([
    'inspect',
    '-f', '{{range.NetworkSettings.Networks}}{{.IPAddress}}{{end}}',
    containerRefForBox(box),
  ], { timeoutMs: 5_000 });
  if (result.exitCode !== 0) {
    throw new RuntimeBoxError(`preview target inspect 실패: ${(result.stderr || result.stdout).slice(0, 500)}`);
  }
  const ip = result.stdout.trim();
  if (!/^\d+\.\d+\.\d+\.\d+$/.test(ip)) {
    throw new RuntimeBoxError(`preview target IP 확인 실패: ${ip || '(empty)'}`);
  }

  return {
    service: svc,
    box,
    targetBaseUrl: `http://${ip}:${svc.internal_port}`,
  };
}

/** service_logs tool 구현: Runtime Box 안 로그 파일 tail. */
export async function readServiceLogs(serviceId: number, tail = 100, actorUserId?: number): Promise<string> {
  const svc = await queryServiceOne('SELECT * FROM runtime_box_services WHERE id = $1', [serviceId]);
  if (!svc) throw new RuntimeBoxError(`service ${serviceId} not found`);
  if (svc.runner_kind === 'remote-worker') {
    const effectiveActorUserId = actorUserId ?? svc.created_by;
    if (!effectiveActorUserId) throw new RuntimeBoxError('Remote Worker service logs require actor attribution');
    return readRemoteWorkerServiceLogs({ service: svc, actorUserId: effectiveActorUserId, transport: await remoteServiceTransport(svc, effectiveActorUserId), tail });
  }
  if (!svc.log_path) return '(service has no log_path yet)';
  if (svc.box_id == null) return '(Runtime Box service has no box_id)';

  const box = await queryBoxOne('SELECT * FROM project_runtime_boxes WHERE id = $1', [svc.box_id]);
  if (!box || box.status !== 'running') return '(Runtime Box is not running; logs are unavailable until the box starts)';

  const safeTail = Math.max(1, Math.min(Math.floor(tail), 5000));
  const script = [
    'set -eu',
    'test -f "$LOG_PATH" || { echo "(log file not found: $LOG_PATH)"; exit 0; }',
    'tail -n "$TAIL_LINES" "$LOG_PATH"',
  ].join('\n');
  const result = await spawnDockerCmd([
    'exec',
    '-e', `LOG_PATH=${svc.log_path}`,
    '-e', `TAIL_LINES=${safeTail}`,
    containerRefForBox(box),
    'sh', '-lc', script,
  ], { timeoutMs: 10_000 });

  if (result.exitCode !== 0) {
    throw new RuntimeBoxError(`service ${svc.name} logs 읽기 실패: ${(result.stderr || result.stdout).slice(0, 1000)}`);
  }
  return result.stdout || '(no logs)';
}

// ── Reconcile ────────────────────────────────────────────────────────────

async function isServiceProcessAlive(svc: ServiceRow, box: BoxRow): Promise<boolean> {
  if (!svc.process_pid) return false;
  const result = await spawnDockerCmd([
    'exec',
    '-e', `SERVICE_PID=${svc.process_pid}`,
    containerRefForBox(box),
    'sh', '-lc', 'STAT=$(ps -o stat= -p "$SERVICE_PID" 2>/dev/null | tr -d " ") || exit 1; test -n "$STAT" && case "$STAT" in *Z*) exit 2;; *) exit 0;; esac',
  ], { timeoutMs: 5_000 });
  return result.exitCode === 0;
}

/** DB running 서비스와 실제 container process 상태를 맞춘다. */
export async function reconcileRuntimeBoxServices(): Promise<number> {
  let changed = 0;
  const services = await queryServices(
    `SELECT * FROM runtime_box_services
     WHERE status IN ('running', 'pending')`,
  );

  for (const candidate of services) {
    if (candidate.runner_kind === 'remote-worker' || candidate.box_id == null) continue;
    const attempt = await tryWithRuntimeBoxLifecycleLock(candidate.box_id, async held => {
      assertRuntimeBoxLifecycleLockHeld(held, candidate.box_id!);
      const svc = await queryServiceOne('SELECT * FROM runtime_box_services WHERE id = $1', [candidate.id]);
      if (!svc || svc.box_id !== candidate.box_id || !['running', 'pending'].includes(svc.status)) return;
      const box = await queryBoxOne('SELECT * FROM project_runtime_boxes WHERE id = $1', [svc.box_id]);
      if (!box || box.status !== 'running') {
        const result = await execute(
          `UPDATE runtime_box_services
             SET status = 'stopped', process_pid = NULL,
                 stopped_at = COALESCE(stopped_at, now()),
                 last_error = COALESCE(last_error, 'reconcile: parent box is not running')
           WHERE id = $1 AND status IN ('running', 'pending')`,
          [svc.id],
        );
        if (result.changes > 0) changed += 1;
        return;
      }

      if (svc.status === 'pending') {
        const result = await execute(
          `UPDATE runtime_box_services
             SET status = 'error', process_pid = NULL,
                 stopped_at = COALESCE(stopped_at, now()),
                 last_error = COALESCE(last_error, 'reconcile: service remained pending')
           WHERE id = $1 AND status = 'pending'
             AND created_at < now() - interval '2 minutes'`,
          [svc.id],
        );
        if (result.changes > 0) changed += 1;
        return;
      }

      const alive = await isServiceProcessAlive(svc, box);
      if (alive) return;
      const result = await execute(
        `UPDATE runtime_box_services
           SET status = 'stopped', process_pid = NULL,
               stopped_at = COALESCE(stopped_at, now()),
               last_error = COALESCE(last_error, 'reconcile: process is no longer running')
         WHERE id = $1 AND status = 'running' AND process_pid IS NOT DISTINCT FROM $2`,
        [svc.id, svc.process_pid],
      );
      if (result.changes > 0) changed += 1;
    });
    if (!attempt.acquired) continue;
  }

  return changed;
}

// ── 서비스 제어 ───────────────────────────────────────────────────────────

/** 개별 서비스 stop. */
export async function stopService(serviceId: number, actorUserId?: number): Promise<void> {
  const candidate = await queryServiceOne(
    'SELECT * FROM runtime_box_services WHERE id = $1',
    [serviceId],
  );
  if (!candidate) throw new RuntimeBoxError(`service ${serviceId} not found`);
  if (candidate.runner_kind === 'remote-worker') {
    const effectiveActorUserId = actorUserId ?? candidate.created_by;
    if (!effectiveActorUserId) throw new RuntimeBoxError('Remote Worker service stop requires actor attribution');
    return stopRemoteWorkerService({ service: candidate, actorUserId: effectiveActorUserId, transport: await remoteServiceTransport(candidate, effectiveActorUserId) });
  }
  if (candidate.box_id == null) throw new RuntimeBoxError(`service ${serviceId} has no Runtime Box owner`);
  return withRuntimeBoxLifecycleLock(candidate.box_id, held =>
    stopServiceWithLifecycleLockHeld(serviceId, candidate.box_id!, held));
}

async function stopServiceWithLifecycleLockHeld(
  serviceId: number,
  expectedBoxId: number,
  held: RuntimeBoxLifecycleLockHeld,
): Promise<void> {
  assertRuntimeBoxLifecycleLockHeld(held, expectedBoxId);
  const svc = await queryServiceOne(
    'SELECT * FROM runtime_box_services WHERE id = $1',
    [serviceId],
  );
  if (svc == null) throw new RuntimeBoxError(`service ${serviceId} not found`);
  if (svc.box_id !== expectedBoxId) throw new RuntimeBoxError(`service ${serviceId} changed Runtime Box ownership`);
  if (svc.status === 'stopped') return;

  const box = await queryBoxOne('SELECT * FROM project_runtime_boxes WHERE id = $1', [svc.box_id]);
  if (box && box.status === 'running') {
    await stopServiceProcessIfNeeded(svc, box);
  }

  await execute(
    `UPDATE runtime_box_services
       SET status = 'stopped', stopped_at = now(), process_pid = NULL
     WHERE id = $1`,
    [serviceId],
  );
}

/** 서비스 pin. owner/purpose 필수. */
export async function pinService(
  serviceId: number,
  purpose: string,
  reviewAfterDays = 7,
): Promise<ServiceRow> {
  if (!purpose.trim()) {
    throw new RuntimeBoxError('pinned service 에는 purpose (사용 목적) 가 필수입니다.');
  }

  const reviewAfter = new Date(Date.now() + reviewAfterDays * 24 * 60 * 60 * 1000);

  const candidate = await queryServiceOne(
    'SELECT * FROM runtime_box_services WHERE id = $1',
    [serviceId],
  );
  if (!candidate) throw new RuntimeBoxError(`service ${serviceId} not found`);
  const rows = await queryServices(
    `UPDATE runtime_box_services
       SET pinned = true, purpose = $2, review_after = $3,
           expires_at = NULL
     WHERE id = $1
     RETURNING *`,
    [serviceId, purpose, reviewAfter],
  );
  if (rows.length !== 1) throw new RuntimeBoxError(`service ${serviceId} not found`);
  return rows[0];
}

// ── TTL / idle 만료 처리 ─────────────────────────────────────────────────

/** expires_at 이 지난 unpinned 서비스를 'expired' 로 마킹하고 실행 중이면 stop. */
export async function expireStaleServices(): Promise<number> {
  const stale = await queryServices(
    `SELECT * FROM runtime_box_services
     WHERE status = 'running'
       AND pinned = false
       AND expires_at < now()`,
  );
  let expired = 0;
  for (const candidate of stale) {
    if (candidate.runner_kind === 'remote-worker' || candidate.box_id == null) {
      await stopService(candidate.id);
      const result = await execute(
        `UPDATE runtime_box_services
           SET status = 'expired', stopped_at = COALESCE(stopped_at, now()), process_pid = NULL
         WHERE id = $1 AND pinned = false`,
        [candidate.id],
      );
      if (result.changes > 0) expired += 1;
      continue;
    }
    const attempt = await tryWithRuntimeBoxLifecycleLock(candidate.box_id, async held => {
      assertRuntimeBoxLifecycleLockHeld(held, candidate.box_id!);
      const svc = await queryServiceOne('SELECT * FROM runtime_box_services WHERE id = $1', [candidate.id]);
      if (!svc || svc.box_id !== candidate.box_id) return;
      if (svc.status !== 'running' || svc.pinned || !svc.expires_at || new Date(svc.expires_at).getTime() >= Date.now()) return;

      const box = await queryBoxOne('SELECT * FROM project_runtime_boxes WHERE id = $1', [svc.box_id]);
      if (box?.status === 'running') await stopServiceProcessIfNeeded(svc, box);
      const result = await execute(
        `UPDATE runtime_box_services
           SET status = 'expired', stopped_at = now(), process_pid = NULL
         WHERE id = $1 AND status = 'running' AND pinned = false AND expires_at < now()`,
        [svc.id],
      );
      if (result.changes > 0) expired += 1;
    });
    if (!attempt.acquired) continue;
  }
  return expired;
}

/** review_after 가 지난 pinned 서비스 목록 반환 (운영자 확인용). */
export async function listOverdueReviews(): Promise<ServiceRow[]> {
  return queryServices(
    `SELECT * FROM runtime_box_services
     WHERE pinned = true AND status = 'running'
       AND review_after < now()
     ORDER BY review_after`,
  );
}

// ── 호스트 포트 할당 ─────────────────────────────────────────────────────

/** 서비스 ID 기반으로 호스트 포트 자동 할당. Preview proxy 는 future phase. */
export function calcHostPort(serviceId: number): number {
  return 60000 + (serviceId % 5000);
}

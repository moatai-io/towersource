/**
 * sandbox-tools.ts — Phase 2a-1 본체.
 *
 * Long-running internal containers (며칠 도는 미니 백엔드, 워커, 크롤러).
 * Mode A/B 의 일회성 (`sandbox.run` + `--rm`) 와 별개로, `--restart=unless-stopped` +
 * `expires_at` 기반 라이프사이클.
 *
 * 결정:
 *   workspace/decisions/2026-04-29-execution-sandbox-q13-tool-start-api.md
 *   workspace/decisions/2026-05-02-execution-sandbox-q18-public-tools.md (visibility)
 *   workspace/decisions/2026-05-06-execution-sandbox-q19-port-allocation.md (host_port)
 *
 * Phase 2a-1 (이 파일):
 *   - visibility='private' 만 동작 (외부 호출 X, docker exec 으로만)
 *   - 4 도구: start / stop / list / logs
 *   - 호스트 포트 자동: 40000 + (id % 20000)
 *   - 글로벌 cap: 10 (전체) + 3 (사용자당)
 *   - 만료 cron: hourly setInterval (다음 sub-phase 에서 분리 가능)
 *
 * Phase 2a-2 (후속):
 *   - visibility='auth-required' (nginx + /api/auth/check)
 *   - delete / renew tool
 *
 * Phase 2a-3 (후속):
 *   - visibility='unlisted' / 'public'
 *   - rate limit (limit_req_zone)
 *
 * Phase 2a-4 (후속):
 *   - secrets (Q12 secret_store + grants)
 */

import { sshExec, startSshTunnel, stopSshTunnel } from './sandbox-ssh.js';
import { config } from '../../config.js';
import { getPgPool, isPgEnabled } from '../../db/pg.js';
import { spawn } from 'child_process';
import { existsSync, createReadStream } from 'fs';
import { stat, rm } from 'fs/promises';
import * as pathLib from 'path';
import { SandboxDeniedError, type SandboxRuntime } from './sandbox.js';
import { assertSandboxWorkspaceAllowed } from './sandbox-acl.js';
import {
  provisionTool,
  deprovisionTool,
  buildToolSlug,
  checkSlugConflict,
  assertNginxBootstrap,
} from './sandbox-nginx.js';

// ── 타입 ─────────────────────────────────────────────────────────────────

export type ToolVisibility = 'private' | 'auth-required' | 'unlisted' | 'public';
export type ToolStatus = 'pending' | 'running' | 'stopped' | 'error' | 'expired';

export interface SandboxToolStartRequest {
  userId: number;
  name: string;                        // 사용자당 unique
  runtime: SandboxRuntime;
  workspace_path: string;              // 'projects/foo' (workspace 기준)
  entrypoint: string;                  // 'python main.py' or 'uvicorn main:app --host 0.0.0.0 --port 8000'
  port?: number;                       // 컨테이너 내부 포트 (없으면 워커)
  cpu_limit?: number;                  // default 0.25
  memory_mb?: number;                  // default 256
  expires_in_days?: number;            // default 7, max 30
  env?: Record<string, string>;        // 평문 env (감사 로그)
  visibility?: ToolVisibility;         // Phase 2a-1 은 'private' 만
  /**
   * D15 host_mounts — `/opt/sandbox-tools/<name>/` 호스트 도구를 컨테이너에 ro mount.
   * 결정: workspace/decisions/2026-05-11-sandbox-binary-tool-policy.md
   * 검증·규칙은 sandbox.ts SandboxRunRequest.host_mounts 와 동일.
   */
  host_mounts?: string[];
}

export interface InternalToolRow {
  id: number;
  owner_user_id: number;
  name: string;
  workspace_path: string;
  entrypoint: string;
  runtime: string;
  image: string;
  cpu_limit: string;                   // numeric → string
  memory_mb: number;
  port: number | null;
  host_port: number | null;
  visibility: ToolVisibility;
  proxy_subdomain: string | null;
  slug_suffix: string | null;
  container_id: string | null;
  status: ToolStatus;
  restart_policy: string | null;
  created_at: string;
  started_at: string | null;
  stopped_at: string | null;
  expires_at: string;
  last_renewed_at: string | null;
  cpu_seconds_total: string;
  peak_memory_mb: number | null;
  restart_count: number;
  last_error: string | null;
  env_plain: Record<string, string>;
  secrets_used: string[];
}

export interface SandboxToolStartResult {
  tool_id: number;
  container_id: string;
  status: ToolStatus;
  expires_at: string;
  host_port: number | null;
  url?: string;                         // visibility != 'private' 일 때만
}

// ── runtime → image (sandbox.ts 에서 동일 매핑 — 중복 회피 위해 import 했지만 typed re-declare) ──
const RUNTIME_IMAGE: Record<SandboxRuntime, string> = {
  python:        'python:3.12-slim',
  'python-data': 'tower-sandbox-python:3.12-data',
  'python-web':  'tower-sandbox-python:3.12-web',
  // D15 Track A
  'python-tools':'tower-sandbox-python:3.12-tools',
  node:          'node:20-slim',
  'node-utils':  'tower-sandbox-node:20-utils',
  bash:          'python:3.12-slim',
};

// ── 글로벌 cap ────────────────────────────────────────────────────────────
const MAX_RUNNING_TOTAL = 10;
const MAX_RUNNING_PER_USER = 3;
const DEFAULT_EXPIRES_DAYS = 7;
const MAX_EXPIRES_DAYS = 30;

// ── 4계층 토글 (sandbox.ts 와 동일) ───────────────────────────────────────
async function assertSandboxAllowed(userId: number): Promise<void> {
  if (!config.sandbox.enabled) {
    throw new SandboxDeniedError('disabled by ENABLE_SANDBOX');
  }
  if (!config.sandbox.vmHost) {
    throw new SandboxDeniedError('EXECUTION_VM_HOST not configured');
  }
  if (!isPgEnabled()) {
    throw new SandboxDeniedError('postgres not initialized');
  }
  const pool = getPgPool();
  const { rows } = await pool.query<{ sandbox_enabled: boolean }>(
    'SELECT sandbox_enabled FROM users WHERE id = $1',
    [userId],
  );
  if (rows.length === 0) throw new SandboxDeniedError(`user ${userId} not found`);
  if (!rows[0].sandbox_enabled) {
    throw new SandboxDeniedError(`user ${userId} sandbox not enabled by admin`);
  }
}

// Mode C (tool start) workspace_path 검사는 sandbox-acl.ts 의 assertSandboxWorkspaceAllowed 로 이전 (2026-05-12).
// admin/operator 무제한 + 멤버는 prefix 화이트리스트 + 자기가 멤버인 프로젝트만.
// 결정: workspace/decisions/2026-05-12-sandbox-member-project-membership.md

async function assertToolCapsOk(userId: number): Promise<void> {
  const pool = getPgPool();
  const totalQ = await pool.query<{ active: string }>(
    `SELECT COUNT(*)::text AS active FROM internal_tools WHERE status IN ('pending','running')`,
  );
  if (parseInt(totalQ.rows[0].active, 10) >= MAX_RUNNING_TOTAL) {
    throw new SandboxDeniedError(`global tool cap reached (${totalQ.rows[0].active}/${MAX_RUNNING_TOTAL})`);
  }
  const userQ = await pool.query<{ active: string }>(
    `SELECT COUNT(*)::text AS active FROM internal_tools
     WHERE owner_user_id = $1 AND status IN ('pending','running')`,
    [userId],
  );
  if (parseInt(userQ.rows[0].active, 10) >= MAX_RUNNING_PER_USER) {
    throw new SandboxDeniedError(
      `per-user tool cap reached (${userQ.rows[0].active}/${MAX_RUNNING_PER_USER})`,
    );
  }
}

// ── 호스트 포트 할당 (Q19 작업 가설) ──────────────────────────────────────
function allocHostPort(toolId: number): number {
  return 40000 + (toolId % 20000);
}

// ── workspace mount (영속, ~/sandbox-tools/<id>/) ──────────────────
async function prepareToolMount(
  toolId: number,
  workspacePath: string,
): Promise<{ remote_source: string; remote_scratch: string }> {
  const wsRoot = config.workspaceRoot;
  const abs = pathLib.resolve(wsRoot, workspacePath);
  if (!abs.startsWith(wsRoot + pathLib.sep) && abs !== wsRoot) {
    throw new SandboxDeniedError(`workspace_path traversal: ${workspacePath}`);
  }
  if (!existsSync(abs)) {
    throw new SandboxDeniedError(`workspace_path not found: ${workspacePath}`);
  }

  const tarPath = `/tmp/tower-tool-${toolId}.tar.gz`;
  await new Promise<void>((resolve, reject) => {
    const proc = spawn('tar', ['-czf', tarPath, '-C', abs, '.'], { stdio: 'ignore' });
    proc.on('exit', (c) => (c === 0 ? resolve() : reject(new Error(`tar exit ${c}`))));
    proc.on('error', reject);
  });

  const tarStat = await stat(tarPath);
  const MAX_TAR_BYTES = 50 * 1024 * 1024;
  if (tarStat.size > MAX_TAR_BYTES) {
    await rm(tarPath, { force: true });
    throw new SandboxDeniedError(`workspace too large: ${tarStat.size} > ${MAX_TAR_BYTES}`);
  }

  // 영속 경로 — sibling VM 의 ~/sandbox-tools/<id>/
  // docker -v 는 절대경로 요구 → $HOME 으로 ssh remote shell 이 expand 하도록 명시.
  // (Q19 후속 정리 시 /var/lib/sandbox-tools 로 옮길 후보)
  const remoteRoot = `\$HOME/sandbox-tools/${toolId}`;
  const remoteSource = `${remoteRoot}/source`;
  const remoteScratch = `${remoteRoot}/scratch`;

  const cfg = config.sandbox;
  const userHost = cfg.vmHost.includes('@') ? cfg.vmHost : `${cfg.vmUser}@${cfg.vmHost}`;
  await new Promise<void>((resolve, reject) => {
    const proc = spawn('ssh', [
      '-o', `ConnectTimeout=${cfg.sshTimeoutSec}`,
      '-o', 'BatchMode=yes',
      '-o', 'StrictHostKeyChecking=accept-new',
      userHost,
      // sudo 없이 사용자 홈 외에 쓰기 — execution VM 의 tower-user 이 ~/sandbox-tools 에 owner 권한 가져야.
      // 일단 mkdir -p 가 되는 영역으로 fallback: ~/sandbox-tools/<id>/
      // rm -rf <source>/* — tool_restart 시 멱등 갱신. tar 가 added/modified 만 덮어쓰고
      //                     deleted 파일은 stale 로 남는 문제 회피. scratch 는 보존.
      `mkdir -p ${remoteSource} ${remoteScratch} && rm -rf ${remoteSource}/* ${remoteSource}/.[!.]* 2>/dev/null; tar -xzf - -C ${remoteSource}`,
    ]);
    createReadStream(tarPath).pipe(proc.stdin);
    proc.on('exit', (c: number | null) => (c === 0 ? resolve() : reject(new Error(`ssh tar -xz exit ${c}`))));
    proc.on('error', reject);
  });
  await rm(tarPath, { force: true });

  return { remote_source: remoteSource, remote_scratch: remoteScratch };
}

async function cleanupToolMount(toolId: number): Promise<void> {
  try {
    await sshExec({
      command: `rm -rf \$HOME/sandbox-tools/${toolId}`,
      timeout_ms: 10_000,
    });
  } catch {
    // best-effort
  }
}

// ── 핵심: sandboxToolStart() ─────────────────────────────────────────────
export async function sandboxToolStart(req: SandboxToolStartRequest): Promise<SandboxToolStartResult> {
  // 0. validation
  if (!req.name || !/^[a-z0-9][a-z0-9-]{0,31}$/.test(req.name)) {
    throw new SandboxDeniedError(
      `invalid name "${req.name}" — lowercase a-z 0-9 - only, 1-32 chars, start with alnum`,
    );
  }
  if (!req.workspace_path || !req.entrypoint) {
    throw new SandboxDeniedError('workspace_path + entrypoint both required');
  }
  if (req.port !== undefined && (req.port < 1 || req.port > 65535)) {
    throw new SandboxDeniedError(`invalid port ${req.port}`);
  }

  const visibility: ToolVisibility = req.visibility ?? 'private';
  // 4단계 모두 활성 (Phase 2a-3 완성).
  // public 게이트 (AskUserQuestion binary 확인) 는 PreToolUse hook 책임 — 이 함수에 도달 시 통과 가정.
  // 결정: workspace/decisions/2026-05-13-execution-sandbox-phase2a3-unlisted-public.md

  // 외부 호출 받는 visibility 는 컨테이너 internal port 필수
  if (visibility !== 'private' && req.port === undefined) {
    throw new SandboxDeniedError(
      `visibility="${visibility}" requires \`port\` (container internal port) — workers without port must use visibility="private"`,
    );
  }

  // slug_suffix — unlisted 만. visibility 변경 시 재사용 가능하게 한 번 만들고 DB 에 박음.
  // hex regex import 안 함 — crypto.randomBytes 직접.
  let slugSuffix: string | null = null;
  if (visibility === 'unlisted') {
    const { randomBytes } = await import('crypto');
    slugSuffix = randomBytes(3).toString('hex'); // 6자 hex
  }

  // 외부 노출 visibility (auth-required/unlisted/public) 는 nginx 부트스트랩 + slug 충돌 사전 검사
  if (visibility !== 'private') {
    assertNginxBootstrap();
    // owner username 가져와서 slug 미리 만들고 충돌 검사
    const userQ = await getPgPool().query<{ username: string }>(
      'SELECT username FROM users WHERE id = $1',
      [req.userId],
    );
    if (userQ.rows.length === 0) throw new SandboxDeniedError(`user ${req.userId} not found`);
    const slugPreview = buildToolSlug(userQ.rows[0].username, req.name, visibility, slugSuffix);
    checkSlugConflict(slugPreview);
  }

  const expiresInDays = Math.min(
    Math.max(req.expires_in_days ?? DEFAULT_EXPIRES_DAYS, 1),
    MAX_EXPIRES_DAYS,
  );
  const cpuLimit = Math.min(Math.max(req.cpu_limit ?? 0.25, 0.05), 1.0);
  const memoryMb = Math.min(Math.max(req.memory_mb ?? 256, 64), 1024);

  // 1. 4계층 + cap (workspace_path 검사는 sandbox-acl.ts — admin/operator 무제한, 멤버는 자기 프로젝트만)
  await assertSandboxAllowed(req.userId);
  await assertSandboxWorkspaceAllowed(req.userId, req.workspace_path);
  await assertToolCapsOk(req.userId);

  // 2. DB row INSERT (status='pending') — UNIQUE (owner_user_id, name) 가드
  const pool = getPgPool();
  const variant = RUNTIME_IMAGE[req.runtime];
  if (!variant) throw new SandboxDeniedError(`unknown runtime: ${req.runtime}`);

  const insertRes = await pool.query<{ id: number; expires_at: string }>(
    `INSERT INTO internal_tools
       (owner_user_id, name, workspace_path, entrypoint, runtime, image,
        cpu_limit, memory_mb, port, visibility, slug_suffix, env_plain,
        expires_at, status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,
             now() + ($13 || ' days')::interval, 'pending')
     ON CONFLICT (owner_user_id, name) DO NOTHING
     RETURNING id, expires_at`,
    [
      req.userId, req.name, req.workspace_path, req.entrypoint,
      req.runtime, variant,
      cpuLimit, memoryMb, req.port ?? null,
      visibility,
      slugSuffix,
      JSON.stringify(req.env ?? {}),
      expiresInDays,
    ],
  );
  if (insertRes.rows.length === 0) {
    throw new SandboxDeniedError(
      `tool name "${req.name}" already exists for this user — choose a different name or stop the existing one`,
    );
  }
  const toolId = insertRes.rows[0].id;
  const expiresAt = insertRes.rows[0].expires_at;
  const hostPort = req.port ? allocHostPort(toolId) : null;

  // host_port UPDATE
  if (hostPort !== null) {
    await pool.query('UPDATE internal_tools SET host_port = $1 WHERE id = $2', [hostPort, toolId]);
  }

  let containerId = '';
  try {
    // 3. workspace mount
    const mount = await prepareToolMount(toolId, req.workspace_path);

    // 4. docker run -d  —  long-running (--restart=unless-stopped)
    //    private:        호스트 포트 publish X, docker exec 으로만
    //    auth-required:  --publish <sibling_vm_internal_ip>:host_port:port — Tower 본체 nginx 가 그 포트로 proxy
    const containerName = `tower-tool-${toolId}`;
    const dockerArgs: string[] = [
      'docker', 'run', '-d',
      '--restart', 'unless-stopped',
      '--memory', `${memoryMb}m`,
      '--cpus', String(cpuLimit),
      '--pids-limit', '200',
      '--name', containerName,
      '-v', `${mount.remote_source}:/workspace:ro`,
      '-v', `${mount.remote_scratch}:/scratch:rw`,
      '-w', '/workspace',
    ];

    // D15 host_mounts — /opt/sandbox-tools/<name> → /opt/<name>:ro
    // 결정: workspace/decisions/2026-05-11-sandbox-binary-tool-policy.md
    if (req.host_mounts && req.host_mounts.length > 0) {
      const HOST_MOUNT_RE = /^[a-z][a-z0-9_-]{0,63}$/;
      if (req.host_mounts.length > 8) {
        throw new Error(`host_mounts: too many (max 8, got ${req.host_mounts.length})`);
      }
      for (const name of req.host_mounts) {
        if (!HOST_MOUNT_RE.test(name)) {
          throw new Error(`host_mounts: invalid name '${name}'`);
        }
        dockerArgs.push('-v', `/opt/sandbox-tools/${name}:/opt/${name}:ro`);
      }
    }

    if (visibility !== 'private' && req.port !== undefined && hostPort !== null) {
      // 127.0.0.1 only publish — sibling VM 외부 노출 0.
      // 본체 nginx → 본체 127.0.0.1:hostPort → ssh tunnel → sibling 127.0.0.1:hostPort → 컨테이너.
      // 결정: workspace/decisions/2026-05-07-execution-sandbox-q14a-nginx-mvp.md (보안 모델)
      // Phase 2a-3 — auth-required/unlisted/public 모두 동일 모델
      dockerArgs.push('--publish', `127.0.0.1:${hostPort}:${req.port}`);
    }

    // env_plain
    for (const [k, v] of Object.entries(req.env ?? {})) {
      // 안전한 env 키만 (대문자, 숫자, 밑줄)
      if (/^[A-Z_][A-Z0-9_]{0,63}$/.test(k)) {
        dockerArgs.push('-e', `${k}=${v}`);
      }
    }

    dockerArgs.push(variant);
    dockerArgs.push('sh', '-c', `'${req.entrypoint.replace(/'/g, "'\\''")}'`);

    let stdoutBuf = '';
    let stderrBuf = '';
    const result = await sshExec({
      command: dockerArgs.join(' '),
      timeout_ms: 30_000,
      onStdout: (c) => { stdoutBuf = (stdoutBuf + c).slice(-65536); },
      onStderr: (c) => { stderrBuf = (stderrBuf + c).slice(-65536); },
    });

    if (result.exit_code !== 0) {
      throw new Error(
        `docker run failed (exit ${result.exit_code}): ${stdoutBuf}${stderrBuf}`,
      );
    }

    // docker run -d 는 stdout 으로 container ID 출력
    containerId = stdoutBuf.trim().slice(0, 64);
    if (!containerId) {
      // fallback — docker ps 로 이름 매칭 lookup
      let psOut = '';
      await sshExec({
        command: `docker ps -q --filter name=${containerName}`,
        timeout_ms: 10_000,
        onStdout: (c) => { psOut += c; },
      });
      containerId = psOut.trim();
    }

    await pool.query(
      `UPDATE internal_tools
         SET status = 'running',
             container_id = $1,
             started_at = now()
       WHERE id = $2`,
      [containerId, toolId],
    );
  } catch (e) {
    const msg = (e as Error).message;
    await pool.query(
      `UPDATE internal_tools SET status = 'error', last_error = $1 WHERE id = $2`,
      [msg.slice(0, 4000), toolId],
    );
    await cleanupToolMount(toolId);
    throw new SandboxDeniedError(`tool start failed: ${msg}`);
  }

  // 5. 외부 노출 visibility (auth-required/unlisted/public) — ssh tunnel + nginx server block + reload
  let url: string | undefined;
  if (visibility !== 'private' && hostPort !== null && req.port !== undefined) {
    try {
      // 5a. SSH tunnel — 본체 127.0.0.1:hostPort → sibling 127.0.0.1:hostPort
      await startSshTunnel(toolId, hostPort);

      // 5b. nginx config — upstream = 127.0.0.1:hostPort (본체 localhost via tunnel)
      const ownerQ = await pool.query<{ username: string }>(
        'SELECT username FROM users WHERE id = $1', [req.userId],
      );
      const ownerUsername = ownerQ.rows[0]?.username ?? `user-${req.userId}`;
      const provisioned = await provisionTool({
        id: toolId,
        owner_username: ownerUsername,
        name: req.name,
        port: req.port,
        host_port: hostPort,
        visibility,
        slug_suffix: slugSuffix,
      });
      url = provisioned.url;
      await pool.query(
        'UPDATE internal_tools SET proxy_subdomain = $1 WHERE id = $2',
        [provisioned.slug, toolId],
      );
    } catch (e) {
      // 실패 — tunnel 정리 + 컨테이너는 일단 그대로 (재시도 가능)
      stopSshTunnel(toolId);
      const msg = `${visibility} provision failed: ${(e as Error).message}`;
      await pool.query(
        'UPDATE internal_tools SET last_error = $1 WHERE id = $2',
        [msg.slice(0, 4000), toolId],
      );
      throw new SandboxDeniedError(msg);
    }
  }

  return {
    tool_id: toolId,
    container_id: containerId,
    status: 'running',
    expires_at: expiresAt,
    host_port: hostPort,
    url, // auth-required면 configured SANDBOX_TOOL_BASE_DOMAIN URL, private면 undefined
  };
}

// ── stop ─────────────────────────────────────────────────────────────────
export async function sandboxToolStop(
  toolId: number,
  userId: number,
): Promise<{ ok: boolean; previous_status: ToolStatus }> {
  await assertSandboxAllowed(userId);
  const pool = getPgPool();

  const { rows } = await pool.query<{ owner_user_id: number; container_id: string | null; status: ToolStatus }>(
    'SELECT owner_user_id, container_id, status FROM internal_tools WHERE id = $1',
    [toolId],
  );
  if (rows.length === 0) throw new SandboxDeniedError(`tool ${toolId} not found`);

  // 권한 — owner 또는 admin/operator
  const userRow = await pool.query<{ role: string }>('SELECT role FROM users WHERE id=$1', [userId]);
  const isPriv = userRow.rows[0]?.role === 'admin' || userRow.rows[0]?.role === 'operator';
  if (rows[0].owner_user_id !== userId && !isPriv) {
    throw new SandboxDeniedError(`not the owner of tool ${toolId}`);
  }

  const prevStatus = rows[0].status;
  if (prevStatus === 'stopped' || prevStatus === 'expired') {
    return { ok: true, previous_status: prevStatus };
  }

  // docker stop (best effort) + DB 갱신
  if (rows[0].container_id) {
    await sshExec({
      command: `docker stop ${rows[0].container_id} 2>/dev/null; docker rm ${rows[0].container_id} 2>/dev/null; true`,
      timeout_ms: 30_000,
    });
  }
  // ssh tunnel 종료 (auth-required 였던 도구만)
  stopSshTunnel(toolId);

  // nginx server block 제거 (auth-required/unlisted/public 만 해당 — proxy_subdomain 있으면)
  const nginxQ = await pool.query<{ proxy_subdomain: string | null; visibility: string }>(
    'SELECT proxy_subdomain, visibility FROM internal_tools WHERE id = $1',
    [toolId],
  );
  if (nginxQ.rows[0]?.proxy_subdomain) {
    try {
      await deprovisionTool(nginxQ.rows[0].proxy_subdomain);
    } catch {
      // best-effort — config 파일은 이미 지웠고 reload 실패해도 다음 정상 reload 까지 옛 상태
    }
  }
  await pool.query(
    `UPDATE internal_tools
       SET status = 'stopped', stopped_at = now(), proxy_subdomain = NULL
     WHERE id = $1`,
    [toolId],
  );
  await cleanupToolMount(toolId);

  return { ok: true, previous_status: prevStatus };
}

// ── list ────────────────────────────────────────────────────────────────
export async function sandboxToolList(opts: {
  userId: number;
  ownerOnly?: boolean;
}): Promise<InternalToolRow[]> {
  await assertSandboxAllowed(opts.userId);
  const pool = getPgPool();

  const userRow = await pool.query<{ role: string }>('SELECT role FROM users WHERE id=$1', [opts.userId]);
  const isPriv = userRow.rows[0]?.role === 'admin' || userRow.rows[0]?.role === 'operator';
  const ownerOnly = opts.ownerOnly !== false; // default true

  const sql = (ownerOnly || !isPriv)
    ? `SELECT * FROM internal_tools WHERE owner_user_id = $1 ORDER BY created_at DESC LIMIT 100`
    : `SELECT * FROM internal_tools ORDER BY created_at DESC LIMIT 100`;
  const params = (ownerOnly || !isPriv) ? [opts.userId] : [];

  const { rows } = await pool.query<InternalToolRow>(sql, params);
  return rows;
}

// ── logs ────────────────────────────────────────────────────────────────
export async function sandboxToolLogs(
  toolId: number,
  userId: number,
  opts?: { tail?: number },
): Promise<string> {
  await assertSandboxAllowed(userId);
  const pool = getPgPool();

  const { rows } = await pool.query<{ owner_user_id: number; container_id: string | null }>(
    'SELECT owner_user_id, container_id FROM internal_tools WHERE id = $1',
    [toolId],
  );
  if (rows.length === 0) throw new SandboxDeniedError(`tool ${toolId} not found`);

  const userRow = await pool.query<{ role: string }>('SELECT role FROM users WHERE id=$1', [userId]);
  const isPriv = userRow.rows[0]?.role === 'admin' || userRow.rows[0]?.role === 'operator';
  if (rows[0].owner_user_id !== userId && !isPriv) {
    throw new SandboxDeniedError(`not the owner of tool ${toolId}`);
  }
  if (!rows[0].container_id) return '(container not started yet)';

  const tail = Math.min(Math.max(opts?.tail ?? 200, 1), 5000);
  let buf = '';
  await sshExec({
    command: `docker logs --tail ${tail} ${rows[0].container_id} 2>&1`,
    timeout_ms: 30_000,
    onStdout: (c) => { buf = (buf + c).slice(-1_000_000); },
  });
  return buf || '(no output)';
}

// ── 만료 cron — hourly setInterval (Phase 2a-1 의 단순 버전) ─────────────
//   + Tower restart 후 ssh tunnel 복원 (Phase 2a-2)
let cronStarted = false;
let cronTimer: NodeJS.Timeout | undefined;
let tunnelsRestored = false;

async function restoreTunnelsForRunning(): Promise<void> {
  if (tunnelsRestored) return;
  tunnelsRestored = true;
  if (!isPgEnabled()) return;
  const pool = getPgPool();
  try {
    const { rows } = await pool.query<{ id: number; host_port: number | null; visibility: string }>(
      `SELECT id, host_port, visibility FROM internal_tools
       WHERE status = 'running'
         AND visibility IN ('auth-required', 'unlisted', 'public')
         AND host_port IS NOT NULL`,
    );
    for (const r of rows) {
      try {
        await startSshTunnel(r.id, r.host_port!);
        console.log(`[sandbox-tools] restored ssh tunnel for tool ${r.id} on port ${r.host_port}`);
      } catch (e) {
        console.warn(`[sandbox-tools] tunnel restore failed for tool ${r.id}:`, (e as Error).message);
      }
    }
  } catch (e) {
    console.warn('[sandbox-tools] tunnel restore query failed:', (e as Error).message);
  }
}

export function startToolExpirationCron(): void {
  if (cronStarted) return;
  cronStarted = true;
  const HOUR = 60 * 60 * 1000;
  const tick = async () => {
    if (!isPgEnabled()) return;
    // 첫 tick 에 tunnel 복원
    await restoreTunnelsForRunning();
    const pool = getPgPool();
    try {
      const { rows } = await pool.query<{ id: number; container_id: string | null }>(
        `SELECT id, container_id FROM internal_tools
         WHERE status = 'running' AND expires_at < now()`,
      );
      for (const r of rows) {
        stopSshTunnel(r.id);
        if (r.container_id) {
          try {
            await sshExec({
              command: `docker stop ${r.container_id} 2>/dev/null; docker rm ${r.container_id} 2>/dev/null; true`,
              timeout_ms: 30_000,
            });
          } catch {
            // best effort
          }
        }
        await pool.query(
          `UPDATE internal_tools SET status = 'expired', stopped_at = now() WHERE id = $1`,
          [r.id],
        );
        await cleanupToolMount(r.id);
        console.log(`[sandbox-tools] expired tool ${r.id}`);
      }
    } catch (e) {
      console.error('[sandbox-tools] cron tick failed:', (e as Error).message);
    }
  };
  // 시작 직후 한번 + 매 시간
  tick().catch(() => {});
  cronTimer = setInterval(tick, HOUR);
  cronTimer.unref();
}

export function stopToolExpirationCron(): void {
  if (cronTimer) clearInterval(cronTimer);
  cronStarted = false;
}

// ── restart ─────────────────────────────────────────────────────────────
/**
 * Owner / admin / operator 의 docker restart. 컨테이너는 유지 (host_port, url, secrets,
 * nginx config 모두 그대로). workspace mount 재마운트로 새 코드 픽업.
 *
 * 사용 흐름:
 *   1. 사용자가 workspace 의 코드 파일 편집
 *   2. mcp__sandbox__tool_restart(tool_id)
 *   3. 5초 끊김 후 새 코드로 도는 컨테이너
 *
 * 결정: workspace/decisions/2026-05-13-execution-sandbox-phase2a3-unlisted-public.md
 */
export async function sandboxToolRestart(
  toolId: number,
  userId: number,
): Promise<{
  ok: boolean;
  container_id: string | null;
  restarted_at: string;
  url?: string;
}> {
  await assertSandboxAllowed(userId);
  const pool = getPgPool();

  const { rows } = await pool.query<{
    owner_user_id: number;
    container_id: string | null;
    status: ToolStatus;
    proxy_subdomain: string | null;
    visibility: string;
    workspace_path: string;
  }>(
    `SELECT owner_user_id, container_id, status, proxy_subdomain, visibility, workspace_path
     FROM internal_tools WHERE id = $1`,
    [toolId],
  );
  if (rows.length === 0) throw new SandboxDeniedError(`tool ${toolId} not found`);

  // 권한 검사
  const userRow = await pool.query<{ role: string }>('SELECT role FROM users WHERE id=$1', [userId]);
  const isPriv = userRow.rows[0]?.role === 'admin' || userRow.rows[0]?.role === 'operator';
  if (rows[0].owner_user_id !== userId && !isPriv) {
    throw new SandboxDeniedError(`not the owner of tool ${toolId}`);
  }
  if (rows[0].status !== 'running') {
    throw new SandboxDeniedError(
      `tool ${toolId} is ${rows[0].status} — restart requires status='running'. Use tool_start to recreate.`,
    );
  }
  if (!rows[0].container_id) {
    throw new SandboxDeniedError(`tool ${toolId} has no container_id (state inconsistent)`);
  }

  // 1) workspace snapshot 갱신 — sibling VM 의 ~/sandbox-tools/<id>/source/ 를
  //    호스트의 현재 workspace_path 내용으로 교체. 이게 핵심 — docker restart 만
  //    하면 컨테이너 안의 ro mount 는 옛 snapshot 그대로라 새 코드 안 옴.
  //    prepareToolMount 가 멱등 (rm -rf source/* + tar -xzf) 으로 동작.
  try {
    await prepareToolMount(toolId, rows[0].workspace_path);
  } catch (e) {
    const msg = `workspace re-mount failed: ${(e as Error).message}`;
    await pool.query(
      `UPDATE internal_tools SET last_error = $1 WHERE id = $2`,
      [msg.slice(0, 4000), toolId],
    );
    throw new SandboxDeniedError(msg);
  }

  // 2) docker restart — 컨테이너 내 프로세스 (uvicorn 등) 재시작 → 새 코드 픽업.
  let stderrBuf = '';
  const result = await sshExec({
    command: `docker restart ${rows[0].container_id}`,
    timeout_ms: 30_000,
    onStderr: (c) => { stderrBuf = (stderrBuf + c).slice(-16384); },
  });
  if (result.exit_code !== 0) {
    const msg = `docker restart failed (exit ${result.exit_code}): ${stderrBuf}`;
    await pool.query(
      `UPDATE internal_tools SET last_error = $1 WHERE id = $2`,
      [msg.slice(0, 4000), toolId],
    );
    throw new SandboxDeniedError(msg);
  }

  const restartedAt = new Date().toISOString();
  await pool.query(
    `UPDATE internal_tools
       SET restart_count = restart_count + 1,
           last_error = NULL
     WHERE id = $1`,
    [toolId],
  );

  // url 재계산 (사용자에게 보내주기 위해 — DB 의 proxy_subdomain 기반)
  let publicHost = '';
  try {
    publicHost = process.env.PUBLIC_URL ? new URL(process.env.PUBLIC_URL).hostname : '';
  } catch {}
  const baseDomain = process.env.SANDBOX_TOOL_BASE_DOMAIN?.trim() || publicHost;
  if (rows[0].proxy_subdomain && !baseDomain) {
    throw new SandboxDeniedError('SANDBOX_TOOL_BASE_DOMAIN or PUBLIC_URL is required for externally visible sandbox tools');
  }
  const url = rows[0].proxy_subdomain ? `https://${rows[0].proxy_subdomain}.${baseDomain}/` : undefined;

  return {
    ok: true,
    container_id: rows[0].container_id,
    restarted_at: restartedAt,
    url,
  };
}

// ── update visibility ───────────────────────────────────────────────────
/**
 * 운영 중인 도구의 visibility 변경. 컨테이너는 유지, nginx config 만 교체.
 *
 *   private        → 외부 노출 시작 (ssh tunnel + nginx config 신규 작성)
 *   external       → private (ssh tunnel + nginx config 제거)
 *   external ↔ external (auth-required ↔ unlisted ↔ public) — nginx config 교체
 *
 * 주의:
 *   - URL 이 바뀜 (auth-required `<owner>-<name>` ↔ unlisted `<owner>-<name>-<6hex>` ↔ public `<name>`)
 *   - unlisted suffix 는 한 번 생성된 후 영구 보존 — 라운드 트립 시 같은 suffix 재사용
 *   - public 은 owner namespace 없음 → DNS reserved + 충돌 검사 더 엄격
 *   - public 게이트 (AskUserQuestion) 는 PreToolUse hook 책임
 *
 * 결정: workspace/decisions/2026-05-13-execution-sandbox-phase2a3-unlisted-public.md
 */
export async function sandboxToolUpdateVisibility(
  toolId: number,
  userId: number,
  newVisibility: ToolVisibility,
): Promise<{ ok: boolean; old_visibility: ToolVisibility; new_visibility: ToolVisibility; url?: string }> {
  await assertSandboxAllowed(userId);
  const pool = getPgPool();

  const { rows } = await pool.query<{
    owner_user_id: number;
    name: string;
    port: number | null;
    host_port: number | null;
    status: ToolStatus;
    visibility: ToolVisibility;
    proxy_subdomain: string | null;
    slug_suffix: string | null;
  }>(
    `SELECT owner_user_id, name, port, host_port, status, visibility, proxy_subdomain, slug_suffix
     FROM internal_tools WHERE id = $1`,
    [toolId],
  );
  if (rows.length === 0) throw new SandboxDeniedError(`tool ${toolId} not found`);

  const tool = rows[0];

  // 권한 검사
  const userRow = await pool.query<{ role: string }>('SELECT role FROM users WHERE id=$1', [userId]);
  const isPriv = userRow.rows[0]?.role === 'admin' || userRow.rows[0]?.role === 'operator';
  if (tool.owner_user_id !== userId && !isPriv) {
    throw new SandboxDeniedError(`not the owner of tool ${toolId}`);
  }
  if (tool.status !== 'running') {
    throw new SandboxDeniedError(`tool ${toolId} is ${tool.status} — update_visibility requires status='running'`);
  }
  if (tool.visibility === newVisibility) {
    let publicHost = '';
    try {
      publicHost = process.env.PUBLIC_URL ? new URL(process.env.PUBLIC_URL).hostname : '';
    } catch {}
    const baseDomain = process.env.SANDBOX_TOOL_BASE_DOMAIN?.trim() || publicHost;
    if (tool.proxy_subdomain && !baseDomain) {
      throw new SandboxDeniedError('SANDBOX_TOOL_BASE_DOMAIN or PUBLIC_URL is required for externally visible sandbox tools');
    }
    return {
      ok: true,
      old_visibility: tool.visibility,
      new_visibility: newVisibility,
      url: tool.proxy_subdomain ? `https://${tool.proxy_subdomain}.${baseDomain}/` : undefined,
    };
  }
  // 외부 노출이 되려면 port 필수
  if (newVisibility !== 'private' && tool.port === null) {
    throw new SandboxDeniedError(
      `cannot expose tool ${toolId} without port (was started as worker without --port)`,
    );
  }
  // 외부 노출 visibility 면 nginx 부트스트랩 확인
  if (newVisibility !== 'private') {
    assertNginxBootstrap();
  }

  // slug_suffix — unlisted 면 (저장된 게 있으면 재사용, 없으면 새로 생성)
  let nextSuffix = tool.slug_suffix;
  if (newVisibility === 'unlisted' && !nextSuffix) {
    const { randomBytes } = await import('crypto');
    nextSuffix = randomBytes(3).toString('hex');
  }
  // private/auth-required/public 으로 갈 때 suffix 그대로 DB 에 두기 (라운드 트립 시 재사용).
  // 단, 새 nginx config 빌드 시엔 newVisibility 의 규칙을 따른다.

  // owner username
  const ownerQ = await pool.query<{ username: string }>('SELECT username FROM users WHERE id = $1', [tool.owner_user_id]);
  const ownerUsername = ownerQ.rows[0]?.username ?? `user-${tool.owner_user_id}`;

  // 1. 기존 nginx config 제거 (있으면)
  if (tool.proxy_subdomain) {
    try {
      await deprovisionTool(tool.proxy_subdomain);
    } catch {
      // best-effort
    }
  }

  let newSlug: string | null = null;
  let url: string | undefined;

  if (newVisibility === 'private') {
    // 외부 노출 종료 — ssh tunnel 만 닫고 끝
    stopSshTunnel(toolId);
  } else {
    // 외부 노출 — ssh tunnel 보장 + 새 nginx config 작성
    if (!tool.host_port) {
      throw new SandboxDeniedError(`tool ${toolId} missing host_port (state inconsistent)`);
    }
    try {
      // tunnel 이 이미 떠있을 수 있고 (auth-required → unlisted 같은 케이스) restart 도 안전
      await startSshTunnel(toolId, tool.host_port);
      const provisioned = await provisionTool({
        id: toolId,
        owner_username: ownerUsername,
        name: tool.name,
        port: tool.port!,
        host_port: tool.host_port,
        visibility: newVisibility,
        slug_suffix: nextSuffix,
      });
      newSlug = provisioned.slug;
      url = provisioned.url;
    } catch (e) {
      // 실패 — old visibility 로 복구 시도
      const msg = `update_visibility failed: ${(e as Error).message}`;
      if (tool.visibility !== 'private' && tool.host_port) {
        try {
          await provisionTool({
            id: toolId,
            owner_username: ownerUsername,
            name: tool.name,
            port: tool.port!,
            host_port: tool.host_port,
            visibility: tool.visibility,
            slug_suffix: tool.slug_suffix,
          });
        } catch {
          // double failure — DB 만 정확히 갱신
        }
      }
      await pool.query(
        'UPDATE internal_tools SET last_error = $1 WHERE id = $2',
        [msg.slice(0, 4000), toolId],
      );
      throw new SandboxDeniedError(msg);
    }
  }

  // DB 갱신
  await pool.query(
    `UPDATE internal_tools
       SET visibility = $1,
           proxy_subdomain = $2,
           slug_suffix = $3,
           last_error = NULL
     WHERE id = $4`,
    [newVisibility, newSlug, nextSuffix, toolId],
  );

  return {
    ok: true,
    old_visibility: tool.visibility,
    new_visibility: newVisibility,
    url,
  };
}

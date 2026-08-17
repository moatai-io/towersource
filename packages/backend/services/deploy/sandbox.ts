/**
 * sandbox.ts — Phase 1b 본체.
 *
 * MCP 어댑터(`mcp/sandbox-server.ts`)가 받은 호출을 여기로 위임.
 * 이 파일이 4계층 토글·동시 실행 cap·DB 감사·ssh exec 오케스트레이션을 묶어 처리.
 *
 * 결정:
 *   workspace/decisions/2026-04-24-execution-sandbox-scope.md (D1~D8)
 *   workspace/decisions/2026-04-28-execution-sandbox-d1-revisited.md (절충)
 *   workspace/decisions/2026-04-28-execution-sandbox-q4-package-scope.md
 *
 * Phase:
 *   현재 (Phase 1b) — 일회성 --rm + 사전 설치 이미지 + --network none
 *   향후 (Phase 2)  — internal_tools 별도 함수 (sandbox-tools.ts)
 *
 * Phase 1 PoC (mcp/sandbox-server.ts) 의 인라인 ssh+docker 호출 코드는
 * 이 파일이 본격 구현되면 이쪽으로 옮겨오고, mcp 어댑터는 얇아진다.
 */

import { createHash } from 'crypto';
import { sshExec } from './sandbox-ssh.js';
import { config } from '../../config.js';
import { getPgPool, isPgEnabled } from '../../db/pg.js';
import { assertSandboxWorkspaceAllowed } from './sandbox-acl.js';

// ── 입출력 타입 ──────────────────────────────────────────────────────────

export type SandboxRuntime = 'python' | 'python-data' | 'python-web' | 'python-tools' | 'node' | 'node-utils' | 'bash';

/**
 * 두 실행 모드 (D11 Source vs Execution):
 *   - Mode A — 인라인: code 직접. workspace 없음.
 *   - Mode B — 파일 실행: workspace_path 폴더를 ro mount + entrypoint 실행 (Phase 1c).
 * Mode B 가 활성되려면 workspace_path + entrypoint 둘 다 있어야 함. 둘 중 하나만이면 Mode A 로 fallback (validation error).
 */
export interface SandboxRunRequest {
  userId: number;
  sessionId?: string;
  runtime: SandboxRuntime;
  /** Mode A: 직접 실행할 코드. Mode B 일 때는 무시. */
  code?: string;
  /** Mode B: workspace 기준 상대 경로 (e.g. 'projects/foo'). 있으면 entrypoint 도 필수. */
  workspace_path?: string;
  /** Mode B: 컨테이너 안 working dir(/workspace) 기준 명령 (e.g. 'python main.py'). */
  entrypoint?: string;
  timeout_sec?: number;     // default 60, max 300
  stdin?: string;           // 미사용 (Phase 1c 후반)
  /**
   * Q12 secrets — 컨테이너에 ENV 로 주입할 secret 이름 목록 (값 X).
   * 예: ['OPENAI_API_KEY', 'SLACK_BOT_TOKEN']
   * sandbox.ts 가 secret-store 에서 평문 복호 후 remote --env-file 로 주입한다.
   * 값은 ssh/docker command line, stdout/stderr, 감사 로그에 남기지 않는다.
   * 권한 없으면 SecretAccessDeniedError 가 그대로 throw 되어 호출자에 전파.
   * 감사 로그(sandbox_runs.secrets_used)엔 *이름만* 영속.
   * 결정: workspace/decisions/2026-04-29-execution-sandbox-q12-secrets.md
   */
  secrets?: string[];
  /**
   * D10 outbound 화이트리스트 — true 면 sandbox-proxy (squid) 통한 외부 호출 허용.
   *   - 기본 false → --network none (외부 차단, 가장 안전)
   *   - true → --network sandbox-net + HTTP_PROXY/HTTPS_PROXY ENV
   *           squid 가 Tier 1 화이트리스트 (pypi/npm/github GET) 만 통과
   *           그 외 도메인 = 403, POST/PUT/DELETE = 403
   * 감사 로그(sandbox_runs.allow_outbound)에 영속.
   * 결정: workspace/decisions/2026-04-28-execution-sandbox-d10-outbound-allowlist.md
   */
  allow_outbound?: boolean;
  /**
   * D15 host_mounts — sandbox VM 호스트의 `/opt/sandbox-tools/<name>/` 을 컨테이너에
   *   `/opt/<name>:ro` 로 read-only mount. 큰/드문 third-party binary 도구용 (QCAD,
   *   Blender 등). 흔한 도구 (FFmpeg, LibreOffice, Tesseract 등) 는 `runtime:'python-tools'`.
   * - 항목 형식: ^[a-z][a-z0-9_-]{0,63}$ — `/opt/sandbox-tools/<name>` 존재 필수
   * - traversal 금지: `/`, `..`, 절대경로 거부
   * - mode 고정: 항상 `:ro` (사용자 컨테이너가 호스트 도구 변조 불가)
   * - 설치 권한: admin + operator (별도 `~/workspace/scripts/sandbox-tool-install.sh`)
   * 결정: workspace/decisions/2026-05-11-sandbox-binary-tool-policy.md
   */
  host_mounts?: string[];
}

export interface SandboxRunResult {
  run_id: number;
  mode: 'inline' | 'workspace';
  exit_code: number;
  stdout: string;           // last 1MB
  stderr: string;           // last 1MB
  duration_ms: number;
  oom_killed: boolean;
  timed_out: boolean;
  scratch_files: Array<{ name: string; size: number; mime: string; download_url: string }>;
}

// ── runtime → image 매핑 (Q4 Phase 1) ───────────────────────────────────

const RUNTIME_IMAGE: Record<SandboxRuntime, { image: string; cmd: 'python' | 'node' | 'bash' }> = {
  python:        { image: 'python:3.12-slim',                  cmd: 'python' },
  // Phase 1b 끝 무렵 빌드:
  'python-data': { image: 'tower-sandbox-python:3.12-data',    cmd: 'python' },
  // 2026-05-05 빌드 (3 VM): demo-org 의 FastAPI dogfooding 결과 — 백엔드 표준.
  // fastapi, uvicorn[standard], httpx, pydantic, requests.
  // 결정: workspace/decisions/2026-04-28-execution-sandbox-q4-package-scope.md
  'python-web':  { image: 'tower-sandbox-python:3.12-web',     cmd: 'python' },
  // D15 Track A — 흔한 binary 도구 (FFmpeg, LibreOffice, Tesseract, Pandoc, GS, ImageMagick + 한글 폰트)
  // 결정: workspace/decisions/2026-05-11-sandbox-binary-tool-policy.md
  'python-tools':{ image: 'tower-sandbox-python:3.12-tools',   cmd: 'python' },
  node:          { image: 'node:20-slim',                      cmd: 'node' },
  // Phase 1b 끝 무렵 빌드:
  'node-utils':  { image: 'tower-sandbox-node:20-utils',       cmd: 'node' },
  bash:          { image: 'python:3.12-slim',                  cmd: 'bash' },
};

// ── 4계층 토글 enforcement ──────────────────────────────────────────────

export class SandboxDeniedError extends Error {
  constructor(public reason: string) {
    super(`sandbox denied: ${reason}`);
    this.name = 'SandboxDeniedError';
  }
}

/**
 * 4계층 토글 (D8):
 *   1. 서버  — config.sandbox.enabled (.env)
 *   2. 프로필 — config.towerRole === 'full' (Phase 5 통과 전까지)
 *   3. 사용자 — users.sandbox_enabled
 *   4. 세션  — 호출 자체로 자동 충족
 */
async function assertSandboxAllowed(userId: number): Promise<void> {
  // 1. 서버 토글
  if (!config.sandbox.enabled) {
    throw new SandboxDeniedError('disabled by ENABLE_SANDBOX');
  }
  // 2. 인프라 — Phase 5 (D12, 2026-05-04) 부터 모든 프로필이 형제 sandbox VM 보유.
  //    standalone 운영자는 자기 인프라를 가져오는 모델 — vmHost 가 비면 비활성.
  //    결정: workspace/decisions/2026-05-02-execution-sandbox-d12-sibling-sandbox-mandatory.md
  if (!config.sandbox.vmHost) {
    throw new SandboxDeniedError('EXECUTION_VM_HOST not configured');
  }
  // 3. 사용자
  if (!isPgEnabled()) {
    throw new SandboxDeniedError('postgres not initialized');
  }
  const pool = getPgPool();
  const { rows } = await pool.query<{ sandbox_enabled: boolean }>(
    'SELECT sandbox_enabled FROM users WHERE id = $1',
    [userId],
  );
  if (rows.length === 0) {
    throw new SandboxDeniedError(`user ${userId} not found`);
  }
  if (!rows[0].sandbox_enabled) {
    throw new SandboxDeniedError(`user ${userId} sandbox not enabled by admin`);
  }
}

/**
 * 동시 실행 cap (사용자당 기본 2개).
 * `sandbox_runs.finished_at IS NULL` 인 행 카운트.
 */
async function assertConcurrencyOk(userId: number, cap = 2): Promise<void> {
  const pool = getPgPool();
  const { rows } = await pool.query<{ active: string }>(
    `SELECT COUNT(*)::text AS active FROM sandbox_runs
     WHERE user_id = $1 AND finished_at IS NULL`,
    [userId],
  );
  const active = parseInt(rows[0].active, 10);
  if (active >= cap) {
    throw new SandboxDeniedError(`concurrent limit reached (${active}/${cap})`);
  }
}

/**
 * 글로벌 동시 실행 cap (실험 VM 전체 — B1ms 기준 8 권장).
 * 모든 사용자 누적. 멤버 권한 확장 시 본체/실험 VM 자원 압박 방어.
 * config.sandbox.globalConcurrencyCap (env: SANDBOX_GLOBAL_CONCURRENCY_CAP).
 */
async function assertGlobalConcurrencyOk(): Promise<void> {
  const pool = getPgPool();
  const cap = config.sandbox.globalConcurrencyCap;
  const { rows } = await pool.query<{ active: string }>(
    `SELECT COUNT(*)::text AS active FROM sandbox_runs WHERE finished_at IS NULL`,
  );
  const active = parseInt(rows[0].active, 10);
  if (active >= cap) {
    throw new SandboxDeniedError(`global concurrent limit reached (${active}/${cap})`);
  }
}

// Mode B (workspace mount) workspace_path 검사는 sandbox-acl.ts 로 이전 (2026-05-12).
// admin/operator 무제한 + 멤버는 prefix 화이트리스트 + 자기가 멤버인 프로젝트만.
// 결정: workspace/decisions/2026-05-12-sandbox-member-project-membership.md

// ── DB 헬퍼 ──────────────────────────────────────────────────────────────

async function createSandboxRunRow(req: SandboxRunRequest): Promise<number> {
  const pool = getPgPool();
  // Mode A 는 code, Mode B 는 entrypoint + workspace_path 를 명령 식별자로.
  const cmdString = req.code ?? `${req.workspace_path ?? ''}::${req.entrypoint ?? ''}`;
  const codeHash = createHash('sha256').update(cmdString, 'utf8').digest('hex');
  const codeText = cmdString.length <= 8192 ? cmdString : null;
  const codeSize = Buffer.byteLength(cmdString, 'utf8');
  const timeout = Math.min(Math.max(req.timeout_sec ?? 60, 1), 300);

  const { rows } = await pool.query<{ id: number }>(
    `INSERT INTO sandbox_runs
       (user_id, session_id, runtime, command_hash, command_text, command_size, timeout_sec)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING id`,
    [req.userId, req.sessionId ?? null, req.runtime, codeHash, codeText, codeSize, timeout],
  );
  return rows[0].id;
}

interface FinalizeArgs {
  runId: number;
  exitCode: number;
  durationMs: number;
  oomKilled: boolean;
  timedOut: boolean;
  stdoutBytes: number;
  stderrBytes: number;
  errorText?: string;
  scratchFiles?: Array<{ name: string; size: number; mime: string; download_url: string }>;
  /** Q12 — secret 이름 배열 (값 X). 감사 로그용. */
  secretsUsed?: string[];
}

async function finalizeSandboxRun(args: FinalizeArgs): Promise<void> {
  const pool = getPgPool();
  await pool.query(
    `UPDATE sandbox_runs
       SET finished_at  = now(),
           duration_ms  = $2,
           exit_code    = $3,
           oom_killed   = $4,
           timed_out    = $5,
           stdout_bytes = $6,
           stderr_bytes = $7,
           error_text   = $8,
           scratch_files = $9::jsonb,
           secrets_used  = $10::jsonb
     WHERE id = $1`,
    [
      args.runId,
      args.durationMs,
      args.exitCode,
      args.oomKilled,
      args.timedOut,
      args.stdoutBytes,
      args.stderrBytes,
      args.errorText ?? null,
      JSON.stringify(args.scratchFiles ?? []),
      JSON.stringify(args.secretsUsed ?? []),
    ],
  );
}

// ── Mode B helpers — workspace mount + scratch 회수 ──────────────────────

import { spawn } from 'child_process';
import { existsSync, createReadStream, createWriteStream } from 'fs';
import { mkdir, stat, rm } from 'fs/promises';
import * as pathLib from 'path';

const SECRET_ENV_VALUE_RE = /^[^\0\r\n]*$/;

function remoteShellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function redactSecretText(text: string | undefined, secretEnvMap: Record<string, string>): string {
  if (!text) return text ?? '';
  let out = text;
  const entries = Object.entries(secretEnvMap)
    .filter(([, value]) => value.length >= 4)
    .sort((a, b) => b[1].length - a[1].length);
  for (const [name, value] of entries) {
    out = out.replace(new RegExp(escapeRegExp(value), 'g'), `[REDACTED_SECRET:${name}]`);
  }
  return out;
}

function sandboxUserHost(): string {
  const cfg = config.sandbox;
  return cfg.vmHost.includes('@') ? cfg.vmHost : `${cfg.vmUser}@${cfg.vmHost}`;
}

function sandboxSshBaseArgs(): string[] {
  const cfg = config.sandbox;
  return [
    '-o', `ConnectTimeout=${cfg.sshTimeoutSec}`,
    '-o', 'BatchMode=yes',
    '-o', 'StrictHostKeyChecking=accept-new',
    sandboxUserHost(),
  ];
}

async function prepareRemoteSecretEnvFile(runId: number, secretEnvMap: Record<string, string>): Promise<string | undefined> {
  const entries = Object.entries(secretEnvMap);
  if (entries.length === 0) return undefined;

  const remoteDir = `/tmp/sandbox-secrets/${runId}`;
  const remoteEnvFile = `${remoteDir}/env`;
  const lines: string[] = [];
  for (const [name, value] of entries) {
    if (!SECRET_ENV_VALUE_RE.test(value)) {
      throw new SandboxDeniedError(`secret ${name} contains newline or NUL; sandbox env materialization requires single-line secrets`);
    }
    lines.push(`${name}=${value}`);
  }
  const envFileContent = `${lines.join('\n')}\n`;

  await new Promise<void>((resolve, reject) => {
    const proc = spawn('ssh', [
      ...sandboxSshBaseArgs(),
      `umask 077 && mkdir -p ${remoteShellQuote(remoteDir)} && cat > ${remoteShellQuote(remoteEnvFile)}`,
    ], { stdio: ['pipe', 'ignore', 'pipe'] });
    let stderr = '';
    proc.stderr.on('data', (chunk) => { stderr = (stderr + chunk.toString()).slice(-4096); });
    proc.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`secret env upload failed: ssh exit ${code}: ${stderr}`))));
    proc.on('error', reject);
    proc.stdin.end(envFileContent, 'utf8');
  });

  return remoteEnvFile;
}

async function cleanupRemoteSecretEnvFile(runId: number): Promise<void> {
  try {
    await sshExec({
      command: `rm -rf ${remoteShellQuote(`/tmp/sandbox-secrets/${runId}`)}`,
      timeout_ms: 10_000,
    });
  } catch {
    // best-effort
  }
}

/**
 * 본체의 workspace/<workspace_path> 를 tar.gz 로 만들어 ssh 로 실험 VM 의
 * /tmp/sandbox-mounts/<runId>/source/ 에 풀어 놓고, 빈 scratch 디렉토리도 만든다.
 *
 * 보안:
 *   - workspace_path 는 path traversal 방어 (../ 거부)
 *   - 본체 workspace 루트 외부 접근 거부
 *   - tar 크기 cap (기본 50MB) — 큰 폴더 방어
 */
async function prepareWorkspaceMount(req: SandboxRunRequest, runId: number): Promise<{
  remote_source: string;
  remote_scratch: string;
  source_size_bytes: number;
}> {
  const wsRoot = config.workspaceRoot;
  const rel = req.workspace_path!;

  // path traversal 검증
  const abs = pathLib.resolve(wsRoot, rel);
  if (!abs.startsWith(wsRoot + pathLib.sep) && abs !== wsRoot) {
    throw new SandboxDeniedError(`workspace_path traversal: ${rel}`);
  }
  if (!existsSync(abs)) {
    throw new SandboxDeniedError(`workspace_path not found: ${rel}`);
  }

  // 본체에서 tar.gz 만들기 — *폴더 내용만* 압축 (구조 포함 X).
  // 그래야 컨테이너에서 /workspace/main.py 가 곧장 보임.
  const tarPath = `/tmp/tower-sandbox-${runId}.tar.gz`;
  await new Promise<void>((resolve, reject) => {
    const proc = spawn('tar', ['-czf', tarPath, '-C', abs, '.'], { stdio: 'ignore' });
    proc.on('exit', (c) => (c === 0 ? resolve() : reject(new Error(`tar exit ${c}`))));
    proc.on('error', reject);
  });

  const tarStat = await stat(tarPath);
  const MAX_TAR_BYTES = 50 * 1024 * 1024;
  if (tarStat.size > MAX_TAR_BYTES) {
    await rm(tarPath, { force: true });
    throw new SandboxDeniedError(`workspace_path too large: ${tarStat.size} > ${MAX_TAR_BYTES}`);
  }

  // 실험 VM 에 ssh 로 보내고 풀기 (mkdir + tar 한 번에)
  const remoteRoot = `/tmp/sandbox-mounts/${runId}`;
  const remoteSource = `${remoteRoot}/source`;
  const remoteScratch = `${remoteRoot}/scratch`;

  // 1) tar 전송 — scp 대신 ssh stdin 으로 (BatchMode, alias 동일 사용)
  await new Promise<void>((resolve, reject) => {
    const cfg = config.sandbox;
    const userHost = cfg.vmHost.includes('@') ? cfg.vmHost : `${cfg.vmUser}@${cfg.vmHost}`;
    const sshArgs = [
      '-o', `ConnectTimeout=${cfg.sshTimeoutSec}`,
      '-o', 'BatchMode=yes',
      '-o', 'StrictHostKeyChecking=accept-new',
      userHost,
      `mkdir -p ${remoteSource} ${remoteScratch} && tar -xzf - -C ${remoteSource}`,
    ];
    const proc = spawn('ssh', sshArgs);
    createReadStream(tarPath).pipe(proc.stdin);
    proc.on('exit', (c: number | null) => (c === 0 ? resolve() : reject(new Error(`ssh tar -xz exit ${c}`))));
    proc.on('error', reject);
  });

  await rm(tarPath, { force: true });

  return { remote_source: remoteSource, remote_scratch: remoteScratch, source_size_bytes: tarStat.size };
}

/**
 * 컨테이너 종료 후 실험 VM 의 /scratch 에 남긴 파일을 본체로 회수.
 * workspace/<user>/.sandbox/runs/<run_id>/ 로 옮긴다.
 */
async function recoverScratch(
  req: SandboxRunRequest,
  runId: number,
  remoteScratch: string,
): Promise<Array<{ name: string; size: number; mime: string; download_url: string }>> {
  const wsRoot = config.workspaceRoot;
  const username = await getUsername(req.userId);
  const localScratch = pathLib.join(wsRoot, username, '.sandbox', 'runs', String(runId));
  await mkdir(localScratch, { recursive: true });

  // 실험 VM 의 /scratch/ 가 비어있는지 먼저 확인 (빈 tar 거부 회피)
  const checkResult = await sshExec({
    command: `find ${remoteScratch} -mindepth 1 -maxdepth 5 -type f | head -1`,
    timeout_ms: 10_000,
  });
  if (checkResult.exit_code !== 0) return [];

  // ssh tar -cz | tar -xz 로 한 번에 회수
  const tarPath = pathLib.join('/tmp', `tower-scratch-${runId}.tar.gz`);
  const cfg = config.sandbox;
  const userHost = cfg.vmHost.includes('@') ? cfg.vmHost : `${cfg.vmUser}@${cfg.vmHost}`;

  let scratched = false;
  try {
    await new Promise<void>((resolve, reject) => {
      const out = createWriteStream(tarPath);
      const proc = spawn('ssh', [
        '-o', `ConnectTimeout=${cfg.sshTimeoutSec}`,
        '-o', 'BatchMode=yes',
        '-o', 'StrictHostKeyChecking=accept-new',
        userHost,
        `tar -czf - -C ${remoteScratch} . 2>/dev/null || true`,
      ]);
      proc.stdout.pipe(out);
      proc.on('exit', (c: number | null) => (c === 0 ? resolve() : reject(new Error(`ssh tar -cz exit ${c}`))));
      proc.on('error', reject);
    });

    // 본체에서 tar 풀기
    await new Promise<void>((resolve, reject) => {
      const proc = spawn('tar', ['-xzf', tarPath, '-C', localScratch], { stdio: 'ignore' });
      proc.on('exit', (c) => (c === 0 ? resolve() : reject(new Error(`tar -xz exit ${c}`))));
      proc.on('error', reject);
    });
    scratched = true;
  } catch {
    // 빈 디렉토리 등은 정상 — silent
  } finally {
    await rm(tarPath, { force: true });
  }

  if (!scratched) return [];

  // 회수된 파일 목록 + 메타 (재귀, 동기 — race 회피).
  const out: Array<{ name: string; size: number; mime: string; download_url: string }> = [];
  const fsSync = await import('fs');
  function walkSync(dir: string, prefix: string) {
    let entries: import('fs').Dirent[];
    try {
      entries = fsSync.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      const full = pathLib.join(dir, ent.name);
      const rel = prefix ? `${prefix}/${ent.name}` : ent.name;
      if (ent.isDirectory()) {
        walkSync(full, rel);
      } else if (ent.isFile()) {
        const st = fsSync.statSync(full);
        out.push({
          name: rel,
          size: st.size,
          mime: guessMime(rel),
          download_url: `/api/sandbox/runs/${runId}/files/${encodeURIComponent(rel)}`,
        });
      }
    }
  }
  walkSync(localScratch, '');
  return out;
}

async function getUsername(userId: number): Promise<string> {
  const pool = getPgPool();
  const { rows } = await pool.query<{ username: string }>('SELECT username FROM users WHERE id=$1', [userId]);
  return rows[0]?.username ?? `user-${userId}`;
}

function guessMime(name: string): string {
  const ext = name.toLowerCase().split('.').pop() ?? '';
  const map: Record<string, string> = {
    png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', svg: 'image/svg+xml',
    webp: 'image/webp', gif: 'image/gif',
    json: 'application/json', csv: 'text/csv', txt: 'text/plain', md: 'text/markdown',
    html: 'text/html', xml: 'text/xml',
    pdf: 'application/pdf',
  };
  return map[ext] ?? 'application/octet-stream';
}

async function cleanupRemoteMount(runId: number): Promise<void> {
  try {
    await sshExec({
      command: `rm -rf /tmp/sandbox-mounts/${runId}`,
      timeout_ms: 10_000,
    });
  } catch {
    // best-effort
  }
}

// ── 핵심: sandboxRun() ──────────────────────────────────────────────────

/**
 * 한 번의 격리 실행. 끝나면 결과 + 감사 로그 반환.
 * Mode A (code) 또는 Mode B (workspace_path + entrypoint).
 * 호출자(MCP server)가 try/catch 로 감싸서 SandboxDeniedError 등을 응답.
 */
export async function sandboxRun(req: SandboxRunRequest): Promise<SandboxRunResult> {
  // 0. 모드 결정 + validation
  const isModeB = !!req.workspace_path && !!req.entrypoint;
  const isModeA = !!req.code;
  if (!isModeA && !isModeB) {
    throw new SandboxDeniedError('either `code` (Mode A) or `workspace_path`+`entrypoint` (Mode B) required');
  }
  if (isModeA && isModeB) {
    throw new SandboxDeniedError('cannot use `code` and `workspace_path` together — choose one mode');
  }

  // 1. 4계층 토글 + 동시 실행 cap (사용자별 + 글로벌)
  await assertSandboxAllowed(req.userId);
  await assertConcurrencyOk(req.userId);
  await assertGlobalConcurrencyOk();

  // 1b. Mode B 면 workspace_path 권한 검증
  //     (admin/operator 무제한, member 는 prefix + 자기 멤버 프로젝트만 — sandbox-acl.ts)
  if (isModeB) {
    await assertSandboxWorkspaceAllowed(req.userId, req.workspace_path!);
  }

  // 1c. Q12 secrets — 권한 확인 + 평문 복호 (값은 docker 호출 직전까지 메모리에만)
  //     ACL 거부 시 SecretAccessDeniedError 가 그대로 throw → 호출자(MCP) 에서
  //     'execution_error' 로 응답. DB row 는 INSERT 전 거부라 깨끗.
  const secretEnvMap: Record<string, string> = {};
  const secretsRequested: string[] = req.secrets ?? [];
  if (secretsRequested.length > 0) {
    if (secretsRequested.length > 10) {
      throw new SandboxDeniedError(`too many secrets requested (${secretsRequested.length}, max 10)`);
    }
    const { getSecret } = await import('../secret/secret-store.js');
    for (const name of secretsRequested) {
      // SecretAccessDeniedError throws on miss; deliberate propagation.
      secretEnvMap[name] = await getSecret(name, req.userId);
    }
  }

  // 2. DB row 선행 INSERT (활성 카운트 즉시 반영)
  const runId = await createSandboxRunRow(req);

  const variant = RUNTIME_IMAGE[req.runtime];
  const timeout = Math.min(Math.max(req.timeout_sec ?? 60, 1), 300);

  // 3a. Mode B 면 workspace 마운트 준비
  let remoteSource: string | undefined;
  let remoteScratch: string | undefined;
  if (isModeB) {
    try {
      const mount = await prepareWorkspaceMount(req, runId);
      remoteSource = mount.remote_source;
      remoteScratch = mount.remote_scratch;
    } catch (e) {
      await finalizeSandboxRun({
        runId, exitCode: -1, durationMs: 0,
        oomKilled: false, timedOut: false,
        stdoutBytes: 0, stderrBytes: 0,
        errorText: `mount prep failed: ${(e as Error).message}`,
      });
      throw e;
    }
  }

  // 3b. docker run 명령 빌드
  // D10 outbound: allow_outbound:true 면 sandbox-net 사용 + squid proxy ENV.
  //               기본 false → --network none (가장 안전).
  const networkArgs = req.allow_outbound
    ? ['--network', 'sandbox-net']
    : ['--network', 'none'];

  const dockerArgs: string[] = [
    'timeout',
    '--signal=KILL',
    String(timeout + 5),
    'docker', 'run', '--rm',
    '--memory', '512m',
    '--cpus', '0.5',
    '--pids-limit', '100',
    ...networkArgs,
    '--name', `tower-run-${runId}`,
  ];

  // D15 host_mounts — /opt/sandbox-tools/<name> 을 컨테이너에 /opt/<name>:ro 로 read-only mount.
  // 결정: workspace/decisions/2026-05-11-sandbox-binary-tool-policy.md
  // 검증은 인터페이스 doc 의 규칙 (regex + traversal block + ro 고정) 그대로.
  if (req.host_mounts && req.host_mounts.length > 0) {
    const HOST_MOUNT_RE = /^[a-z][a-z0-9_-]{0,63}$/;
    if (req.host_mounts.length > 8) {
      throw new SandboxDeniedError(`host_mounts: too many (max 8, got ${req.host_mounts.length})`);
    }
    for (const name of req.host_mounts) {
      if (!HOST_MOUNT_RE.test(name)) {
        throw new SandboxDeniedError(`host_mounts: invalid name '${name}' (must match ${HOST_MOUNT_RE.source})`);
      }
      // ro 고정 — 사용자 컨테이너가 호스트 도구 변조 불가.
      // 존재하지 않는 도구면 docker bind mount 가 명확한 에러로 떨어짐.
      dockerArgs.push('-v', `/opt/sandbox-tools/${name}:/opt/${name}:ro`);
    }
  }

  // D10: outbound 활성 시 squid proxy ENV 주입. 컨테이너 안 urllib/requests/curl 등이
  // 자동으로 HTTP_PROXY/HTTPS_PROXY 인지. 화이트리스트 외 도메인 = squid 403.
  if (req.allow_outbound) {
    const proxyUrl = 'http://sandbox-proxy:3128';
    dockerArgs.push('-e', `HTTP_PROXY=${proxyUrl}`);
    dockerArgs.push('-e', `HTTPS_PROXY=${proxyUrl}`);
    dockerArgs.push('-e', `http_proxy=${proxyUrl}`);
    dockerArgs.push('-e', `https_proxy=${proxyUrl}`);
    // RFC1918/localhost 등은 proxy 우회 안 하도록 (그쪽도 squid 가 차단하지만)
    dockerArgs.push('-e', `NO_PROXY=localhost,127.0.0.1`);
  }

  const remoteSecretEnvFile = await prepareRemoteSecretEnvFile(runId, secretEnvMap);
  if (remoteSecretEnvFile) {
    // Q12-2: pass secret values through a remote --env-file instead of embedding
    // KEY=VALUE in the ssh/docker command line. The env file lives on the sibling
    // execution VM with umask 077 and is deleted in finally below.
    dockerArgs.push('--env-file', remoteShellQuote(remoteSecretEnvFile));
  }

  if (isModeB) {
    dockerArgs.push('-v', `${remoteSource}:/workspace:ro`);
    dockerArgs.push('-v', `${remoteScratch}:/scratch:rw`);
    dockerArgs.push('-w', '/workspace');
    dockerArgs.push(variant.image);
    dockerArgs.push('sh', '-c', `'${req.entrypoint!.replace(/'/g, "'\\''")}'`);
  } else {
    // Mode A: base64 + sh -c — 자가 검증된 escaping 패턴
    const codeB64 = Buffer.from(req.code!, 'utf8').toString('base64');
    dockerArgs.push(variant.image);
    dockerArgs.push('sh', '-c', `'echo ${codeB64} | base64 -d | ${variant.cmd}'`);
  }

  const dockerCmd = dockerArgs.join(' ');

  // 4. ssh exec + 결과 캡처 (last 1MB tail)
  let stdoutBuf = '';
  let stderrBuf = '';
  let errorText: string | undefined;
  let exit = -1;
  let durationMs = 0;
  let stdoutSize = 0;
  let stderrSize = 0;
  let timedOut = false;
  let scratchFiles: SandboxRunResult['scratch_files'] = [];

  try {
    const result = await sshExec({
      command: dockerCmd,
      timeout_ms: (timeout + 10) * 1000,
      onStdout: (c) => { stdoutBuf = redactSecretText((stdoutBuf + c).slice(-1_000_000), secretEnvMap); },
      onStderr: (c) => { stderrBuf = redactSecretText((stderrBuf + c).slice(-1_000_000), secretEnvMap); },
    });
    stdoutBuf = redactSecretText(stdoutBuf, secretEnvMap);
    stderrBuf = redactSecretText(stderrBuf, secretEnvMap);
    exit = result.exit_code;
    durationMs = result.duration_ms;
    stdoutSize = Buffer.byteLength(stdoutBuf, 'utf8');
    stderrSize = Buffer.byteLength(stderrBuf, 'utf8');
    timedOut = result.killed_by_timeout || durationMs >= timeout * 1000;

    // 5a. Mode B — scratch 회수
    if (isModeB && remoteScratch) {
      try {
        scratchFiles = await recoverScratch(req, runId, remoteScratch);
      } catch (e) {
        // 회수 실패해도 실행 자체는 성공일 수 있음. errorText 에 누적.
        errorText = `scratch recovery failed: ${(e as Error).message}`;
      }
    }
  } catch (e) {
    errorText = redactSecretText((e as Error).message, secretEnvMap);
    exit = -1;
  } finally {
    if (remoteSecretEnvFile) {
      await cleanupRemoteSecretEnvFile(runId);
    }
    if (isModeB) {
      await cleanupRemoteMount(runId);
    }
  }

  const oomKilled = exit === 137;

  // 5b. DB finalize (scratch_files + secrets_used 같이 영속)
  await finalizeSandboxRun({
    runId,
    exitCode: exit,
    durationMs,
    oomKilled,
    timedOut,
    stdoutBytes: stdoutSize,
    stderrBytes: stderrSize,
    errorText,
    scratchFiles,
    secretsUsed: secretsRequested,
  });

  return {
    run_id: runId,
    mode: isModeB ? 'workspace' : 'inline',
    exit_code: exit,
    stdout: stdoutBuf,
    stderr: stderrBuf,
    duration_ms: durationMs,
    oom_killed: oomKilled,
    timed_out: timedOut,
    scratch_files: [],   // Phase 1c: scratch 회수 구현 후 채워짐
  };
}

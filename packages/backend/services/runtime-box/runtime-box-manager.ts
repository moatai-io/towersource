import { DOWNLOAD_TIMEOUT_MAX_SEC, isManagedDownloadCommand } from '../execution/downloads/download-contract.js';
/**
 * runtime-box-manager.ts — Project Runtime Box 생명주기 관리.
 *
 * Owns: Box 생성·시작·종료·삭제·exec.
 * Public API: getOrCreateBox, ensureRunning, execInBox, execWorkbenchToolMutation,
 *             recreateRuntimeBoxExactWithLocksHeld, execInBoxWithActivityLockHeld,
 *             stopBox,
 *             destroyBox, listRunningBoxes, getBoxByProject,
 *             countRunningBoxes, countRunningBoxesByUser,
 *             assertGlobalBoxBudget, assertUserBoxBudget.
 * See README.md.
 *
 * v1 구현 상태 (2026-06-02):
 *   - DB row 관리 (생성/조회/상태 갱신) 완전 구현.
 *   - Docker backend 구현: docker run / exec / stop (동일 host).
 *   - service_start 프로세스 supervision 은 TODO #4 (v2+).
 *   - Docker 이미지가 없으면 RuntimeBoxError — 서버는 죽지 않음.
 *
 * 결정:
 *   workspace/decisions/2026-06-01-project-runtime-plane-devbox-services.md
 *   workspace/decisions/2026-06-02-project-runtime-box-product-framing.md
 */

import path from 'path';
import fs from 'fs/promises';
import { spawn } from 'child_process';
import { query, queryOne, execute, transaction, withClient } from '../../db/pg-repo.js';
import { queryBoxOne, queryBoxes } from './runtime-box-row-repository.js';
import { getPgPool } from '../../db/pg.js';


import { getProject } from '../pm/project-manager.js';
import { config } from '../../config.js';
import { getLiveRuntimeBoxCapacity } from './runtime-box-capacity.js';
import { withWorkbenchToolPath } from './workbench-tools.js';
import {
  RUNTIME_BOX_EXEC_TIMEOUT_DEFAULT_SEC,
  RUNTIME_BOX_EXEC_TIMEOUT_MAX_SEC,
} from './types.js';
import type {
  BoxRow, BoxStatus, RuntimeProfile,
  ExecRequest, ExecResult, RuntimeContext, ServiceRow,
} from './types.js';
import {
  resolveProjectCredentialSecretValue,
  resolveRuntimeBoxApiKeyEnv,
  resolveRuntimeBoxCredentialFileMaterialization,
} from '../credential-vault/credential-vault-service.js';
import { shouldSuppressCredentialEnv } from '../execution/command-classifier.js';
import { decodeAgentGwsBundle } from './agent-gws-credential-selection.js';
import { requestedCredentialEnvNames } from './workbench-credential-scope.js';
import {
  formatUserRuntimeBoxBudgetError,
  listUserRuntimeBoxOccupancy,
  selectReclaimableRuntimeBox,
} from './runtime-box-reclamation.js';
import {
  assertRuntimeBoxActivityLockHeld,
  tryWithRuntimeBoxActivityLock,
  withRuntimeBoxActivityLock,
  type RuntimeBoxActivityLockHeld,
} from './runtime-box-activity-lock.js';
import {
  assertRuntimeBoxLifecycleLockHeld,
  withRuntimeBoxLifecycleLock,
  type RuntimeBoxLifecycleLockHeld,
} from './runtime-box-lifecycle-lock.js';
import {
  observeRuntimeBoxContainer,
  type DockerInspectResult,
} from './runtime-box-container-observation.js';
import {
  transitionConfirmedStaleRuntime,
} from './runtime-box-confirmed-stale-transition.js';
import {
  buildWorkbenchToolProjectionPlan,
  markWorkbenchToolProjectionRecoveryRequired,
  markWorkbenchToolProjectionUnmounted,
  recordWorkbenchToolProjection,
  runtimeWorkbenchToolDockerMountArgs,
  type WorkbenchToolProjectionPlan,
} from './workbench-tool-projection.js';
import {
  buildRuntimeSkillBindMountPlan,
  projectUsesSkillBindMount,
  runtimeSkillDockerMountArgs,
} from '../skill/runtime-skill-bind-mount.js';

// ── 상수 ─────────────────────────────────────────────────────────────────

const WORKSPACE_ROOT = process.env.WORKSPACE_ROOT || path.join(process.env.HOME || '/home/tower', 'workspace');
const DEFAULT_RUNTIME_PROFILE: RuntimeProfile = 'node22-python313';
const SUPPORTED_RUNTIME_PROFILES = new Set<RuntimeProfile>([
  'node22-python313',
  'operator-tools',
  'python313',
  'node22',
  'custom',
]);

/** Box 컨테이너 내부 작업 디렉토리 (프로젝트 폴더가 여기 mount 됨). */
export const BOX_WORKDIR = '/workspace';

/** Runtime Box memory policy: default 3GB, hard-cap 3GB unless env lowers/raises explicitly. */
function clampBoxMemoryMb(requestedMb: number | undefined): number {
  const defaultMb = Number.isFinite(config.runtimeBox.defaultMemoryMb)
    ? config.runtimeBox.defaultMemoryMb
    : 3072;
  const maxMb = Number.isFinite(config.runtimeBox.maxMemoryMb)
    ? config.runtimeBox.maxMemoryMb
    : 3072;
  const requested = requestedMb ?? defaultMb;
  return Math.max(512, Math.min(requested, maxMb));
}

export function isRuntimeProfile(value: string): value is RuntimeProfile {
  return SUPPORTED_RUNTIME_PROFILES.has(value as RuntimeProfile);
}

export async function resolveProjectRuntimeProfile(
  projectRoot: string,
  explicitProfile?: RuntimeProfile,
): Promise<RuntimeProfile> {
  if (explicitProfile) return explicitProfile;
  const profilePath = path.join(projectRoot, '.runtime-box', 'profile.json');
  try {
    const data = JSON.parse(await fs.readFile(profilePath, 'utf-8'));
    const profile = typeof data?.profile === 'string' ? data.profile : '';
    if (isRuntimeProfile(profile)) return profile;
    if (profile) console.warn(`[runtime-box] unsupported profile in ${profilePath}: ${profile}`);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT') console.warn(`[runtime-box] failed to read ${profilePath}:`, (err as Error).message);
  }
  return DEFAULT_RUNTIME_PROFILE;
}

export function runtimeBoxImageForProfile(profile: RuntimeProfile): string {
  switch (profile) {
    case 'operator-tools':
      return process.env.RUNTIME_BOX_OPERATOR_IMAGE || 'tower-runtime-box:operator-tools';
    case 'node22-python313':
    case 'python313':
    case 'node22':
    case 'custom':
    default:
      // Until lightweight python/node-only variants exist, all non-operator
      // profiles use the configured default image. This preserves old rows and
      // env overrides while letting operator workbenches opt into a reproducible
      // tool-rich image.
      return config.runtimeBox.image;
  }
}

export function runtimeBoxImageNeedsRecreate(existingImageRef: string | null | undefined, configuredImageRef: string): boolean {
  if (!existingImageRef) return true;
  if (configuredImageRef.startsWith('sha256:')) return existingImageRef !== configuredImageRef;
  // Mutable tags cannot prove parity with Docker inspect's immutable image ID.
  // Production must pin sha256; development tags retain legacy reuse semantics.
  return false;
}

// ── 오류 타입 ─────────────────────────────────────────────────────────────

export class RuntimeBoxError extends Error {
  constructor(public reason: string) {
    super(`RuntimeBox error: ${reason}`);
    this.name = 'RuntimeBoxError';
  }
}

export async function validateWorkbenchToolMutationCandidate(input: {
  projectId: string;
  candidateHostPath: string;
  candidateMountMode: 'rw' | 'ro';
  storeRoot?: string;
}): Promise<string> {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(input.projectId)) {
    throw new RuntimeBoxError('Workbench mutation project id is invalid');
  }
  const storeRoot = path.resolve(input.storeRoot ?? config.experimentalWorkbenchTools.storeRoot);
  const projectStore = path.join(storeRoot, 'projects', input.projectId);
  const candidateHostPath = path.resolve(input.candidateHostPath);
  const relative = path.relative(projectStore, candidateHostPath).replaceAll('\\', '/');
  const allowed = input.candidateMountMode === 'rw'
    ? /^staging\/[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(relative)
    : /^revisions\/[0-9]{6}$/.test(relative);
  if (!allowed) {
    throw new RuntimeBoxError(`Workbench mutation ${input.candidateMountMode} candidate is not owned by the requested project`);
  }

  let candidateStat: Awaited<ReturnType<typeof fs.lstat>>;
  let candidateRealPath: string;
  try {
    candidateStat = await fs.lstat(candidateHostPath);
    candidateRealPath = await fs.realpath(candidateHostPath);
  } catch {
    throw new RuntimeBoxError('Workbench mutation candidate is unavailable');
  }
  if (!candidateStat.isDirectory() || candidateStat.isSymbolicLink()) {
    throw new RuntimeBoxError('Workbench mutation candidate must be a real directory');
  }
  if (candidateRealPath !== candidateHostPath) {
    throw new RuntimeBoxError('Workbench mutation candidate resolved through a symlink or escaped its project store');
  }
  return candidateHostPath;
}

/**
 * Run one credential-free Workbench installer command in a disposable container.
 * The Project source is mounted read-only and copied into an ephemeral tmpfs workspace;
 * only the command-scoped candidate persists writes. Credentials are not materialized.
 */
export async function execWorkbenchToolMutation(input: {
  projectId: string;
  projectRoot: string;
  candidateHostPath: string;
  candidateContainerPath: '/workspace/.runtime-box/workbench-tools/active';
  candidateMountMode: 'rw' | 'ro';
  command: string;
  cwd: '/workspace';
}): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  assertProjectRootBoundary(input.projectRoot);
  const candidateHostPath = await validateWorkbenchToolMutationCandidate({
    projectId: input.projectId,
    candidateHostPath: input.candidateHostPath,
    candidateMountMode: input.candidateMountMode,
  });
  if (input.candidateContainerPath !== '/workspace/.runtime-box/workbench-tools/active' || input.cwd !== '/workspace') {
    throw new RuntimeBoxError('Workbench mutation runner path policy violation');
  }
  const box = await queryBoxOne('SELECT * FROM project_runtime_boxes WHERE project_id=$1', [input.projectId]);
  const image = runtimeBoxImageForProfile(box?.runtime_profile ?? DEFAULT_RUNTIME_PROFILE);
  const containerName = `tower-workbench-mutation-${process.pid}-${Date.now()}`;
  const mountMode = input.candidateMountMode === 'ro' ? 'ro' : 'rw';
  const isolatedCommand = [
    'cp -R /tower-project-source/. /workspace/',
    `mkdir -p ${shellQuote(path.dirname(input.candidateContainerPath))}`,
    input.command,
  ].join(' && ');
  const result = await spawnDockerCmd([
    'run', '--rm', '--name', containerName,
    '--user', `${process.getuid?.() ?? 0}:${process.getgid?.() ?? 0}`,
    '--security-opt', 'no-new-privileges',
    '--cap-drop', 'ALL',
    '--pids-limit', '256',
    '--memory', '3072m',
    '--cpus', '1',
    '-e', 'UV_CACHE_DIR=/tmp/uv-cache',
    '--mount', `type=bind,src=${path.resolve(input.projectRoot)},dst=/tower-project-source,readonly=true,bind-propagation=rprivate`,
    '--tmpfs', '/workspace:rw,nosuid,nodev,mode=0777',
    '--mount', `type=bind,src=${candidateHostPath},dst=${input.candidateContainerPath},readonly=${mountMode === 'ro'},bind-propagation=rprivate`,
    '-w', input.cwd,
    image, 'sh', '-lc', isolatedCommand,
  ], { timeoutMs: 15 * 60_000 });
  return { exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr };
}

// ── 경계 검증 ─────────────────────────────────────────────────────────────

/**
 * project_root 가 workspace/projects/ 하위인지 검증.
 * 상위 경로 또는 /workspace 루트 접근 방지.
 * 이 검증이 없으면 다른 프로젝트 또는 호스트 루트가 mount 될 수 있음.
 */
function assertProjectRootBoundary(projectRoot: string): void {
  const projectsBase = path.join(WORKSPACE_ROOT, 'projects');
  const resolved = path.resolve(projectRoot);
  if (!resolved.startsWith(projectsBase + path.sep)) {
    throw new RuntimeBoxError(
      `project_root 경계 위반: ${projectRoot} 는 ${projectsBase} 하위여야 함. ` +
      `다른 프로젝트 또는 호스트 루트 mount 차단.`,
    );
  }
}

/** Return true when a persisted Runtime Box row still points at an old project folder. */
export function runtimeBoxProjectRootNeedsSync(existingRoot: string, projectRoot: string): boolean {
  return path.resolve(existingRoot) !== path.resolve(projectRoot);
}

// ── Box 조회 / 생성 ───────────────────────────────────────────────────────

/** project_runtime_boxes 에서 특정 프로젝트 Box 를 조회. */
export async function getBoxByProject(projectId: string): Promise<BoxRow | undefined> {
  return queryBoxOne(
    'SELECT * FROM project_runtime_boxes WHERE project_id = $1',
    [projectId],
  );
}

/**
 * 프로젝트 Box 를 조회하거나, 없으면 DB row 를 생성.
 * 컨테이너 시작은 하지 않음 (ensureRunning 이 담당).
 *
 * project_root 는 Tower 가 자동으로 결정 (workspace/projects/<slug>/).
 * 사용자가 project_root 를 지정할 수 없음 — 경계 위반 방지.
 */
export async function getOrCreateBox(
  projectId: string,
  createdBy: number,
  opts?: { runtimeProfile?: RuntimeProfile; memoryMb?: number; idleStopMinutes?: number },
): Promise<BoxRow> {
  // 프로젝트 정보로 root_path 결정
  const project = await getProject(projectId);
  if (!project) throw new RuntimeBoxError(`project ${projectId} not found`);

  // project.rootPath 가 없으면 기본 경로 사용
  const projectRoot = project.rootPath ||
    path.join(WORKSPACE_ROOT, 'projects', project.name.toLowerCase().replace(/[^a-z0-9]+/g, '-'));

  // 경계 검증 (핵심 보안 가드)
  assertProjectRootBoundary(projectRoot);

  const profile = await resolveProjectRuntimeProfile(projectRoot, opts?.runtimeProfile);

  // 기존 row 가 프로젝트 rename 이전 경로를 들고 있을 수 있다.
  // Runtime Box mount 는 DB row 의 project_root 를 그대로 쓰므로, 최신 projects.root_path 와
  // 동기화하지 않으면 /workspace 가 과거 빈 shell 프로젝트를 보게 된다.
  const existing = await getBoxByProject(projectId);
  if (existing != null) {
    const normalizedProjectRoot = path.resolve(projectRoot);
    const profileChanged = existing.runtime_profile !== profile;
    if (runtimeBoxProjectRootNeedsSync(existing.project_root, normalizedProjectRoot) || profileChanged) {
      if (existing.status === 'running' || existing.status === 'starting') {
        await stopBox(existing.id, 'stopped');
      }
      await execute(
        `UPDATE project_runtime_boxes
           SET project_root = $2,
               runtime_profile = $3,
               status = CASE WHEN status IN ('running', 'starting') THEN 'stopped' ELSE status END,
               container_id = NULL,
               updated_at = now()
         WHERE id = $1`,
        [existing.id, normalizedProjectRoot, profile],
      );
      return (await getBoxByProject(projectId))!;
    }
    return existing;
  }

  const memoryMb = clampBoxMemoryMb(opts?.memoryMb);
  const idleStop = opts?.idleStopMinutes ?? 20;

  const rows = await queryBoxes(
    `INSERT INTO project_runtime_boxes
       (project_id, status, runtime_profile, project_root,
        memory_mb, idle_stop_minutes, created_by)
     VALUES ($1, 'stopped', $2, $3, $4, $5, $6)
     ON CONFLICT (project_id) DO NOTHING
     RETURNING *`,
    [projectId, profile, projectRoot, memoryMb, idleStop, createdBy],
  );

  // ON CONFLICT 로 다른 세션이 먼저 만든 경우
  if (rows.length === 0) {
    const found = await getBoxByProject(projectId);
    if (found == null) throw new RuntimeBoxError(`concurrent box creation conflict for ${projectId}`);
    return found;
  }
  return rows[0];
}

// ── Docker Backend ────────────────────────────────────────────────────────

/**
 * Docker 명령을 spawn 으로 실행. 결과를 { stdout, stderr, exitCode, timedOut } 으로 반환.
 *
 * - ENOENT (Docker 없음) → exitCode -1, stderr "Docker binary not found..."
 * - timeout → timedOut=true, process SIGKILL'd
 * - stdout/stderr 각 1MB 상한 (초과분 버림)
 * - onStdout / onStderr callback 있으면 실시간 전달
 */
async function spawnCmd(
  bin: string,
  args: string[],
  opts: {
    timeoutMs?: number;
    preserveStdoutTail?: boolean;
    onStdout?: (chunk: string) => void;
    onStderr?: (chunk: string) => void;
    signal?: AbortSignal;
    /** Kill the command inside its execution boundary before detaching docker exec. */
    onAbort?: () => Promise<void>;
  } = {},
): Promise<{ stdout: string; stderr: string; exitCode: number; timedOut: boolean }> {
  const MAX_OUTPUT = 1_048_576; // 1MB per stream

  return new Promise((resolve) => {
    let timedOut = false;
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let stdoutLen = 0;
    let stderrLen = 0;

    let proc: ReturnType<typeof spawn>;
    try {
      proc = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (spawnErr) {
      resolve({ stdout: '', stderr: (spawnErr as Error).message, exitCode: -1, timedOut: false });
      return;
    }

    proc.stdout?.on('data', (chunk: Buffer) => {
      opts.onStdout?.(chunk.toString('utf8'));
      if (opts.preserveStdoutTail) {
        stdoutChunks.push(chunk); stdoutLen += chunk.length;
        while (stdoutLen > MAX_OUTPUT && stdoutChunks.length > 1) stdoutLen -= stdoutChunks.shift()!.length;
      } else if (stdoutLen < MAX_OUTPUT) {
        stdoutChunks.push(chunk);
        stdoutLen += chunk.length;
      }
    });

    proc.stderr?.on('data', (chunk: Buffer) => {
      opts.onStderr?.(chunk.toString('utf8'));
      if (stderrLen < MAX_OUTPUT) {
        stderrChunks.push(chunk);
        stderrLen += chunk.length;
      }
    });

    let settled = false;
    let aborting = false;
    const abort = () => {
      if (settled || aborting) return;
      aborting = true;
      void (async () => {
        try { await opts.onAbort?.(); }
        catch (error) { console.warn('[runtime-box] command boundary abort failed:', (error as Error).message); }
        if (!settled) proc.kill('SIGTERM');
        setTimeout(() => { if (!settled) proc.kill('SIGKILL'); }, 2_000).unref();
      })();
    };
    if (opts.signal?.aborted) abort();
    else opts.signal?.addEventListener('abort', abort, { once: true });

    let timer: ReturnType<typeof setTimeout> | null = null;
    if (opts.timeoutMs) {
      timer = setTimeout(() => {
        timedOut = true;
        proc.kill('SIGKILL');
      }, opts.timeoutMs);
    }

    proc.on('error', (err) => {
      settled = true;
      opts.signal?.removeEventListener('abort', abort);
      if (timer) clearTimeout(timer);
      const code = (err as NodeJS.ErrnoException).code;
      const msg = code === 'ENOENT'
        ? `Binary "${bin}" not found. Is it installed and in PATH?`
        : err.message;
      resolve({ stdout: '', stderr: msg, exitCode: -1, timedOut: false });
    });

    proc.on('close', (code) => {
      settled = true;
      opts.signal?.removeEventListener('abort', abort);
      if (timer) clearTimeout(timer);
      resolve({
        stdout: stdoutChunks.length > 0
          ? opts.preserveStdoutTail ? Buffer.concat(stdoutChunks).toString('utf8').slice(-MAX_OUTPUT) : Buffer.concat(stdoutChunks).toString('utf8').slice(0, MAX_OUTPUT) : '',
        stderr: stderrChunks.length > 0
          ? Buffer.concat(stderrChunks).toString('utf8').slice(0, MAX_OUTPUT) : '',
        exitCode: code ?? -1,
        timedOut,
      });
    });
  });
}

async function spawnDockerCmd(
  args: string[],
  opts: {
    timeoutMs?: number;
    preserveStdoutTail?: boolean;
    onStdout?: (chunk: string) => void;
    onStderr?: (chunk: string) => void;
    signal?: AbortSignal;
    onAbort?: () => Promise<void>;
  } = {},
): Promise<{ stdout: string; stderr: string; exitCode: number; timedOut: boolean }> {
  return spawnCmd(config.runtimeBox.dockerBin, args, opts);
}

interface ProjectGitHubIdentity {
  provider?: string;
  mode?: string;
  account?: { login?: string };
  credential_policy?: { store_token_in_runbox?: boolean };
}

interface ProjectConnections {
  trusted_internal_project?: boolean;
  credential_pool?: string;
  allow_roles?: string[];
  providers?: string[];
  github?: { account?: string; repo?: string };
  google?: { account?: string };
}

const GWS_LEGACY_DEFAULT_CREDENTIAL_ID = 'gws-default-config';
const GWS_SHARED_FINANCE_CREDENTIAL_ID = 'gws-demo-org-finance';


function commandNeedsGitHubIdentity(cmd: string): boolean {
  // project_shell commands are often multi-line, env-prefixed, or git-option-prefixed, e.g.
  //   echo "git fetch no prompt"; GIT_TERMINAL_PROMPT=0 git fetch origin
  //   git -c safe.directory=/workspace fetch origin
  // Match the git token plus a nearby write/network subcommand anywhere in the
  // shell snippet. False positives only add command-scoped env to this single
  // exec; credentials still do not persist in the box.
  return /\bgit\b[\s\S]{0,160}\b(fetch|pull|push|ls-remote|clone|submodule)\b/.test(cmd) || /\bgh\s+/.test(cmd);
}

async function readProjectGitHubIdentity(projectRoot: string): Promise<ProjectGitHubIdentity | undefined> {
  try {
    const raw = await fs.readFile(path.join(projectRoot, '.project', 'integrations', 'github.json'), 'utf8');
    const parsed = JSON.parse(raw) as ProjectGitHubIdentity;
    if (parsed.provider !== 'github') return undefined;
    return parsed;
  } catch {
    return undefined;
  }
}

async function readProjectConnections(projectRoot: string): Promise<ProjectConnections | undefined> {
  try {
    const raw = await fs.readFile(path.join(projectRoot, '.project', 'connections.json'), 'utf8');
    return JSON.parse(raw) as ProjectConnections;
  } catch {
    return undefined;
  }
}

async function userMayUseTrustedCredentialPool(_userId: number, _connections: ProjectConnections): Promise<boolean> {
  // Project-editable declarations and requester roles are not grants to the
  // platform's gh/Azure accounts. Use an explicit Agent Vault connection.
  // Keep the bridge signature during migration, but never copy host credentials.
  return false;
}

async function getHostGitHubTokenForProject(_identity: ProjectGitHubIdentity): Promise<string | undefined> {
  // A project-owned github.json cannot authorize the platform user's gh token.
  // Explicit Agent connections are injected before this compatibility hook.
  return undefined;
}

async function withProjectGitHubIdentityEnv(
  box: BoxRow,
  req: ExecRequest,
): Promise<ExecRequest> {
  if (!commandNeedsGitHubIdentity(req.cmd)) return req;
  if (req.env?.GITHUB_TOKEN?.trim() || req.env?.GH_TOKEN?.trim()) return req;

  const identity = await readProjectGitHubIdentity(box.project_root);
  if (!identity) return req;

  const token = await getHostGitHubTokenForProject(identity);
  if (!token) return req;

  const askpassHostPath = path.join(box.project_root, '.project', 'runtime-box', 'bin', 'git-askpass-github-token');
  const askpassExists = await fs.access(askpassHostPath).then(() => true).catch(() => false);
  if (!askpassExists) return req;

  return {
    ...req,
    env: {
      ...req.env,
      GITHUB_TOKEN: token,
      GH_TOKEN: token,
      GIT_TERMINAL_PROMPT: '0',
      GIT_ASKPASS: `${BOX_WORKDIR}/.project/runtime-box/bin/git-askpass-github-token`,
      // Avoid "dubious ownership" in root-run containers with boxuser-owned mounts.
      GIT_CONFIG_COUNT: req.env?.GIT_CONFIG_COUNT ?? '1',
      GIT_CONFIG_KEY_0: req.env?.GIT_CONFIG_KEY_0 ?? 'safe.directory',
      GIT_CONFIG_VALUE_0: req.env?.GIT_CONFIG_VALUE_0 ?? BOX_WORKDIR,
    },
  };
}

function commandNeedsTool(cmd: string, tool: 'gh' | 'az' | 'gws' | 'higgsfield'): boolean {
  return new RegExp(`\\b${tool}\\s+`).test(cmd);
}

export function commandRequestsPersonalGwsProfile(cmd: string): boolean {
  return /(^|[;&|()\s])(?:export\s+)?(?:TOWER_)?GWS_PROFILE=(?:personal|['"]personal['"])(?=$|[;&|()\s])/.test(cmd);
}

export function commandRequestsFinanceGwsProfile(cmd: string): boolean {
  return /(^|[;&|()\s])(?:export\s+)?(?:TOWER_)?GWS_PROFILE=(?:finance|['"]finance['"])(?=$|[;&|()\s])/.test(cmd);
}

export function commandRequestsGwsConnectionId(cmd: string): string | null {
  const match = cmd.match(/(^|[;&|()\s])(?:export\s+)?(?:TOWER_)?GWS_CONNECTION_ID=(?:['"]([A-Za-z0-9._-]+)['"]|([A-Za-z0-9._-]+))(?=$|[;&|()\s])/);
  return match?.[2] || match?.[3] || null;
}

export function commandIsGwsAuthLogin(cmd: string): boolean {
  return /(^|[;&|()\s])gws\s+auth\s+login(?:$|[;&|()\s])/.test(cmd);
}

async function dockerExecShell(containerRef: string, script: string, timeoutMs = 30_000) {
  return spawnDockerCmd(['exec', containerRef, 'sh', '-lc', script], { timeoutMs });
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function assertSafeCredentialFileName(value: string): void {
  if (!/^[A-Za-z0-9._-]{1,100}$/.test(value) || value.includes('..')) {
    throw new RuntimeBoxError(`invalid credential materialization filename: ${value}`);
  }
}

function normalizeCredentialFileMode(value: string): string {
  const normalized = value.startsWith('0') ? value : `0${value}`;
  if (!/^0[0-7]{3}$/.test(normalized)) {
    throw new RuntimeBoxError(`invalid credential materialization mode: ${value}`);
  }
  return normalized;
}

/**
 * Normalize file-style credentials just before writing them into the Runtime Box.
 *
 * OpenSSH private keys are newline-sensitive: removing the final newline makes
 * ssh/ssh-keygen fail with "error in libcrypto". Secret entry CLIs often trim
 * stdin boundary whitespace, so repair that narrow file format here instead of
 * asking every operator to remember the trailing newline detail.
 */
export function normalizeRuntimeCredentialFileContent(content: string, credentialType?: string): string {
  if (
    credentialType === 'ssh_private_key' &&
    /^-----BEGIN (?:OPENSSH|RSA|EC|DSA) PRIVATE KEY-----/.test(content) &&
    !content.endsWith('\n')
  ) {
    return `${content}\n`;
  }
  return content;
}

async function writeCredentialFileFromString(
  containerRef: string,
  destPath: string,
  content: string,
  mode = '0600',
  timeoutMs = 30_000,
  ownerUserSpec?: string,
  credentialType?: string,
): Promise<void> {
  const normalizedMode = normalizeCredentialFileMode(mode);
  const normalizedContent = normalizeRuntimeCredentialFileContent(content, credentialType);
  const chown = ownerUserSpec ? ` && chown ${shellQuote(ownerUserSpec)} ${shellQuote(destPath)}` : '';
  const proc = spawn(config.runtimeBox.dockerBin, ['exec', '-i', containerRef, 'sh', '-lc', `umask 077 && cat > ${shellQuote(destPath)} && chmod ${normalizedMode} ${shellQuote(destPath)}${chown}`], {
    stdio: ['pipe', 'ignore', 'pipe'],
  });

  let stderr = '';
  const maxLen = 8_000;
  const timer = setTimeout(() => proc.kill('SIGKILL'), timeoutMs);
  proc.stderr?.on('data', (chunk: Buffer) => { stderr = (stderr + chunk.toString('utf8')).slice(0, maxLen); });

  await new Promise<void>((resolve, reject) => {
    proc.on('error', reject);
    proc.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new RuntimeBoxError(`failed to write runtime credential file: ${stderr || `docker exec exited ${code}`}`));
    });
    proc.stdin.end(normalizedContent);
  });
}

async function writeContainerFileFromString(
  containerRef: string,
  destPath: string,
  content: string,
  timeoutMs = 30_000,
): Promise<void> {
  const proc = spawn(config.runtimeBox.dockerBin, ['exec', '-i', containerRef, 'sh', '-lc', `cat > ${shellQuote(destPath)}`], {
    stdio: ['pipe', 'ignore', 'pipe'],
  });

  let stderr = '';
  const maxLen = 8_000;
  const timer = setTimeout(() => proc.kill('SIGKILL'), timeoutMs);
  proc.stderr?.on('data', (chunk: Buffer) => { stderr = (stderr + chunk.toString('utf8')).slice(0, maxLen); });

  await new Promise<void>((resolve, reject) => {
    proc.on('error', reject);
    proc.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new RuntimeBoxError(`failed to write runtime credential material: ${stderr || `docker exec exited ${code}`}`));
    });
    proc.stdin.end(content);
  });
}

async function projectCanUseCredential(projectId: string, credentialId: string): Promise<boolean> {
  const row = await queryOne<{ id: string }>(
    `SELECT id FROM workspace_credentials
      WHERE id = $1 AND enabled = true
        AND (scope = 'workspace' OR (scope = 'project' AND project_id = $2))`,
    [credentialId, projectId],
  );
  return Boolean(row);
}

interface AllowedGwsConnection {
  id: string;
  displayName: string;
  isProjectDefault: boolean;
  credentialTypeId?: string;
  googleAccount?: string;
}

export async function listAllowedProjectGwsConnections(projectId: string): Promise<AllowedGwsConnection[]> {
  const rows = await query<{ id: string; display_name: string; scope: string; metadata: Record<string, unknown> | null }>(
    `SELECT c.id, c.display_name, c.scope, c.metadata
       FROM workspace_credentials c
      WHERE c.enabled = true
        AND c.kind = 'gws'
        AND c.provider = 'google'
        AND (c.scope = 'workspace' OR (c.scope = 'project' AND c.project_id = $1))
      ORDER BY CASE c.scope WHEN 'project' THEN 0 ELSE 1 END, lower(c.display_name), c.id`,
    [projectId],
  );
  const projectRows = rows.filter(row => row.scope === 'project');
  return rows.map(row => ({
    id: row.id,
    displayName: row.display_name,
    // A project credential is an implicit default only when it is the sole
    // project-owned Google Connection. Row ordering must never pick an identity.
    isProjectDefault: row.scope === 'project' && projectRows.length === 1,
    credentialTypeId: typeof row.metadata?.credential_type_id === 'string' ? row.metadata.credential_type_id : 'google_unknown',
    googleAccount: typeof row.metadata?.google_account === 'string' ? row.metadata.google_account : '',
  }));
}

export async function selectProjectGwsConnection(input: { projectId: string; requestedCredentialId?: string | null }): Promise<AllowedGwsConnection> {
  const candidates = await listAllowedProjectGwsConnections(input.projectId);
  if (input.requestedCredentialId) {
    const selected = candidates.find(candidate => candidate.id === input.requestedCredentialId);
    if (!selected) {
      throw new RuntimeBoxError(`GWS_CONNECTION_NOT_ALLOWED: ${input.requestedCredentialId} is not an allowed Google Workspace Connection for this Agent.`);
    }
    return selected;
  }

  const projectDefaults = candidates.filter(candidate => candidate.isProjectDefault);
  if (projectDefaults.length === 1) return projectDefaults[0];
  if (projectDefaults.length > 1) {
    const choices = projectDefaults.map(candidate => `${candidate.id} (${candidate.displayName})`).join(', ');
    throw new RuntimeBoxError(`AMBIGUOUS_GWS_DEFAULT: This Agent has multiple default Google Workspace Connections. Keep one runtime_default or select one with GWS_CONNECTION_ID=<id>. Defaults: ${choices}`);
  }
  if (candidates.length === 1) return candidates[0];
  if (candidates.length === 0) {
    throw new RuntimeBoxError('PROJECT_GWS_CREDENTIAL_NOT_AVAILABLE: This Agent has no allowed Google Workspace Connection. Connect one in Agent Credential management.');
  }
  const choices = candidates.map(candidate => {
    const account = candidate.googleAccount ? `; account=${candidate.googleAccount}` : '';
    return `${candidate.id} (${candidate.displayName}; auth=${candidate.credentialTypeId || 'google_unknown'}${account})`;
  }).join(', ');
  throw new RuntimeBoxError(`AMBIGUOUS_GWS_CONNECTION: This Agent has multiple Google Workspace Connections and no compatible default. Ask the user which account or purpose to use, then select it with GWS_CONNECTION_ID=<id>. Available: ${choices}`);
}

/** Applies Agent runtime file ownership, never requester-specific credential paths. */
export function runtimeBoxAgentGwsCredentialPermissionsScript(gwsConfigDir: string, ownerUserSpec?: string): string {
  return [
    `chmod 0700 ${shellQuote(gwsConfigDir)}`,
    `find ${shellQuote(gwsConfigDir)} -type f -exec chmod 0600 {} +`,
    ...(ownerUserSpec ? [`chown -R ${shellQuote(ownerUserSpec)} ${shellQuote(gwsConfigDir)}`] : []),
  ].join(' && ');
}

async function materializeGwsConfigFromVault(opts: {
  box: BoxRow;
  userId: number;
  credentialRoot: string;
  env: Record<string, string>;
  command: string;
}): Promise<{ injected: RuntimeCredentialEnvItem[] }> {
  const wantsPersonal = commandRequestsPersonalGwsProfile(opts.command);
  const wantsFinance = commandRequestsFinanceGwsProfile(opts.command);
  const requestedCredentialId = commandRequestsGwsConnectionId(opts.command);
  const isAuthLogin = commandIsGwsAuthLogin(opts.command);

  let encodedConfig: string | null = null;
  let credentialId = GWS_LEGACY_DEFAULT_CREDENTIAL_ID;

  if (wantsPersonal || isAuthLogin) {
    throw new RuntimeBoxError('AGENT_GWS_CONNECTION_REQUIRED: Requester-personal Google credentials and host OAuth login are not Agent connections. Connect Google to this Agent explicitly before running this command.');
  }

  if (!encodedConfig && wantsFinance && !isAuthLogin) {
    const financeSecret = await projectCanUseCredential(opts.box.project_id, GWS_SHARED_FINANCE_CREDENTIAL_ID)
      ? await resolveProjectCredentialSecretValue({
        projectId: opts.box.project_id,
        userId: opts.userId,
        credentialId: GWS_SHARED_FINANCE_CREDENTIAL_ID,
        kind: 'gws',
        provider: 'google',
        targetType: 'runtime_box_gws_config',
      })
      : null;
    if (!financeSecret) {
      throw new RuntimeBoxError('FINANCE_CREDENTIAL_NOT_AVAILABLE: GWS_PROFILE=finance requires an explicitly allowed finance credential for this project and user.');
    }
    encodedConfig = financeSecret.value;
    credentialId = financeSecret.credentialId;
  }

  if (!encodedConfig && !wantsPersonal && !wantsFinance && !isAuthLogin) {
    const selected = await selectProjectGwsConnection({
      projectId: opts.box.project_id,
      requestedCredentialId,
    });
    const projectSecret = await resolveProjectCredentialSecretValue({
      projectId: opts.box.project_id,
      userId: opts.userId,
      credentialId: selected.id,
      kind: 'gws',
      provider: 'google',
      targetType: 'runtime_box_gws_config',
    });
    if (!projectSecret) {
      throw new RuntimeBoxError(`PROJECT_GWS_CREDENTIAL_NOT_AVAILABLE: ${selected.id} is listed for this Agent but cannot be resolved for Runtime use.`);
    }
    encodedConfig = projectSecret.value;
    credentialId = projectSecret.credentialId;
  }

  if (!encodedConfig) return { injected: [] };
  // Validate the entire archive before any container write. No tar extraction,
  // requester path, token discovery, or personal-bundle promotion is permitted.
  const files = decodeAgentGwsBundle(encodedConfig);
  const containerRef = opts.box.container_id || `tower-box-${opts.box.id}`;
  const homeDir = `${opts.credentialRoot}/home`;
  const gwsConfigDir = `${homeDir}/.config/gws`;
  const prepared = await dockerExecShell(containerRef, `umask 077; rm -rf ${shellQuote(homeDir)} && mkdir -p ${shellQuote(gwsConfigDir)} ${shellQuote(opts.credentialRoot)}`, 10_000);
  if (prepared.exitCode !== 0) throw new RuntimeBoxError('failed to prepare Agent GWS credential directory');
  for (const file of files) {
    await writeContainerFileFromString(containerRef, `${gwsConfigDir}/${file.name}`, file.content.toString('utf8'), 30_000);
  }
  const ownerUserSpec = await projectOwnerUserSpec(opts.box);
  const permissions = await dockerExecShell(containerRef, runtimeBoxAgentGwsCredentialPermissionsScript(gwsConfigDir, ownerUserSpec), 10_000);
  if (permissions.exitCode !== 0) throw new RuntimeBoxError('failed to apply Agent GWS credential permissions');

  opts.env.HOME = homeDir;
  opts.env.XDG_CONFIG_HOME = `${homeDir}/.config`;
  opts.env.GWS_CONFIG_HOME = gwsConfigDir;
  opts.env.GOOGLE_WORKSPACE_CLI_CONFIG_DIR = gwsConfigDir;
  opts.env.GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE = `${gwsConfigDir}/credentials.json`;
  opts.env.GWS_REDIRECT_URI = `${config.publicUrl || 'https://tower.tower.example.com'}/api/oauth/google/callback`;
  const injected: RuntimeCredentialEnvItem[] = [{ credentialId, envName: 'GWS_CONFIG_HOME' }];
  return { injected };
}

export async function resolveHostGwsSourcePath(): Promise<string> {
  const candidates: string[] = [];
  for (const bin of ['/usr/bin/gws', '/usr/local/bin/gws']) {
    try {
      const realGws = await fs.realpath(bin);
      candidates.push(path.dirname(realGws));
    } catch {}
  }
  candidates.push(
    path.join(process.env.HOME || '/home/tower', '.local', 'share', 'gws'),
    '/usr/lib/node_modules/@googleworkspace/cli',
  );

  for (const candidate of [...new Set(candidates)]) {
    try {
      const stat = await fs.stat(candidate);
      if (!stat.isDirectory()) continue;
      const hasRunGws = await fileExists(path.join(candidate, 'run-gws.js'));
      const hasBinary = await fileExists(path.join(candidate, 'binary.js'));
      const hasIndex = await fileExists(path.join(candidate, 'index.mjs'));
      if (hasRunGws || hasBinary || hasIndex) return candidate;
    } catch {}
  }
  throw new RuntimeBoxError('host gws CLI package not found or unsupported');
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    const stat = await fs.stat(filePath);
    return stat.isFile();
  } catch {
    return false;
  }
}

export function runtimeBoxGwsShimScript(): string {
  return `#!/usr/bin/env sh
set -eu
if [ -x /usr/bin/gws ]; then
  exec /usr/bin/gws "$@"
fi
BASE=/opt/tower-tools/lib/gws-cli
if [ -f "$BASE/run-gws.js" ]; then
  exec node "$BASE/run-gws.js" "$@"
fi
if [ -f "$BASE/binary.js" ]; then
  exec node -e 'require(process.argv[1]).run("gws")' "$BASE/binary.js" "$@"
fi
if [ -f "$BASE/index.mjs" ]; then
  exec node "$BASE/index.mjs" "$@"
fi
echo "gws CLI is installed but no supported entrypoint was found under $BASE" >&2
exit 127
`;
}

/**
 * Adds Tower identity env for Runtime Box commands that need user-scoped CLIs.
 * Caller-provided TOWER_USER_ID is deliberately overwritten so a project command
 * cannot spoof another user's GWS token directory.
 */
export function withRuntimeBoxTowerIdentityEnv(env: Record<string, string>, userId: number): Record<string, string> {
  return { ...env, TOWER_USER_ID: String(userId) };
}

async function ensureRuntimeBoxTool(box: BoxRow, tool: 'gh' | 'az' | 'gws'): Promise<void> {
  if (!commandNeedsTool('', tool)) {
    // no-op; keeps TypeScript exhaustiveness simple when this helper is called explicitly.
  }
  const containerRef = box.container_id || `tower-box-${box.id}`;
  const checkScript = tool === 'gws'
    ? 'test -x /opt/tower-tools/bin/gws && grep -q /usr/bin/gws /opt/tower-tools/bin/gws && test -x /usr/bin/gws'
    : `command -v ${tool} >/dev/null 2>&1 || test -x /opt/tower-tools/bin/${tool}`;
  const check = await dockerExecShell(containerRef, checkScript, 5_000);
  if (check.exitCode === 0) return;

  await dockerExecShell(containerRef, 'mkdir -p /opt/tower-tools/bin /opt/tower-tools/lib', 10_000);

  if (tool === 'gh') {
    await spawnDockerCmd(['cp', '/usr/bin/gh', `${containerRef}:/opt/tower-tools/bin/gh`], { timeoutMs: 30_000 });
    await dockerExecShell(containerRef, 'chmod +x /opt/tower-tools/bin/gh', 5_000);
    return;
  }

  if (tool === 'az') {
    await spawnDockerCmd(['cp', '/opt/az', `${containerRef}:/opt/az`], { timeoutMs: 120_000 });
    await dockerExecShell(containerRef, `cat > /opt/tower-tools/bin/az <<'SH'\n#!/usr/bin/env sh\nexec /opt/az/bin/python3 -Im azure.cli "$@"\nSH\nchmod +x /opt/tower-tools/bin/az`, 10_000);
    return;
  }

  if (tool === 'gws') {
    await dockerExecShell(containerRef, 'rm -rf /opt/tower-tools/lib/gws-cli /opt/tower-tools/bin/gws', 10_000);
    const imageGws = await dockerExecShell(containerRef, 'test -x /usr/bin/gws', 5_000);
    if (imageGws.exitCode !== 0) {
      const hostGwsSource = await resolveHostGwsSourcePath();
      await spawnDockerCmd(['cp', hostGwsSource, `${containerRef}:/opt/tower-tools/lib/gws-cli`], { timeoutMs: 60_000 });
    }
    await writeContainerFileFromString(containerRef, '/opt/tower-tools/bin/gws', runtimeBoxGwsShimScript(), 10_000);
    const installed = await dockerExecShell(
      containerRef,
      'chmod +x /opt/tower-tools/bin/gws && (test -x /usr/bin/gws || test -f /opt/tower-tools/lib/gws-cli/run-gws.js || test -f /opt/tower-tools/lib/gws-cli/binary.js || test -f /opt/tower-tools/lib/gws-cli/index.mjs)',
      10_000,
    );
    if (installed.exitCode !== 0) {
      throw new RuntimeBoxError(`gws CLI installed without supported entrypoint: ${installed.stderr || installed.stdout || `exit ${installed.exitCode}`}`);
    }
  }
}

async function prepareHiggsfieldPersistentSession(opts: {
  box: BoxRow;
  env: Record<string, string>;
}): Promise<{ injected: RuntimeCredentialEnvItem[] }> {
  const containerRef = opts.box.container_id || `tower-box-${opts.box.id}`;
  const configuredPath = String(opts.env.HIGGSFIELD_CLI_CREDENTIALS_FILE || '').trim();
  const credentialsPath = configuredPath || '/workspace/.tower/service-home/higgsfield/.config/higgsfield/credentials.json';
  const configDir = credentialsPath.slice(0, credentialsPath.lastIndexOf('/'));
  const homeDir = configuredPath
    ? String(opts.env.HOME || '/workspace')
    : '/workspace/.tower/service-home/higgsfield';
  const ownerUserSpec = await projectOwnerUserSpec(opts.box);
  const ownership = ownerUserSpec ? ` && chown -R ${shellQuote(ownerUserSpec)} ${shellQuote(configDir)}` : '';

  // Higgsfield owns this persistent session. Its CLI may rotate refresh tokens or
  // update workspace selection in credentials.json, so Tower must not recreate or
  // delete the file after each command. Users can override the exact file path by
  // setting HIGGSFIELD_CLI_CREDENTIALS_FILE in the project command environment.
  await dockerExecShell(
    containerRef,
    `mkdir -p ${shellQuote(configDir)} && chmod 700 ${shellQuote(homeDir)} ${shellQuote(configDir)}${ownership}`,
    10_000,
  );
  opts.env.HOME = homeDir;
  opts.env.XDG_CONFIG_HOME = `${homeDir}/.config`;
  opts.env.HIGGSFIELD_CLI_CREDENTIALS_FILE = credentialsPath;
  return { injected: [{ credentialId: 'project-managed:higgsfield-session', envName: 'HIGGSFIELD_CLI_CREDENTIALS_FILE' }] };
}

async function materializeRuntimeCredentialFiles(opts: {
  box: BoxRow;
  credentialRoot: string;
  env: Record<string, string>;
  files: Array<{ credentialId: string; envName: string; fileName: string; mode: string; credentialType?: string; value: string }>;
  ownerUserSpec?: string;
}): Promise<RuntimeCredentialMaterializedFileItem[]> {
  if (opts.files.length === 0) return [];
  const containerRef = opts.box.container_id || `tower-box-${opts.box.id}`;
  const materialized: RuntimeCredentialMaterializedFileItem[] = [];

  const ownership = opts.ownerUserSpec ? ` && chown ${shellQuote(opts.ownerUserSpec)} ${shellQuote(opts.credentialRoot)}` : '';
  await dockerExecShell(containerRef, `mkdir -p ${shellQuote(opts.credentialRoot)}${ownership}`, 10_000);
  const seenEnvNames = new Set<string>();
  for (const file of opts.files) {
    if (seenEnvNames.has(file.envName) || Object.prototype.hasOwnProperty.call(opts.env, file.envName)) continue;
    seenEnvNames.add(file.envName);
    assertSafeCredentialFileName(file.fileName);
    const destPath = `${opts.credentialRoot}/${file.fileName}`;
    await writeCredentialFileFromString(containerRef, destPath, file.value, file.mode, 30_000, opts.ownerUserSpec, file.credentialType);
    opts.env[file.envName] = destPath;
    materialized.push({ credentialId: file.credentialId, envName: file.envName, credentialType: file.credentialType });
  }

  return materialized;
}

async function prepareCliCredentialEnv(
  box: BoxRow,
  req: ExecRequest,
  credentialRoot?: string,
): Promise<{ req: ExecRequest; cleanup?: () => Promise<void>; injected?: RuntimeCredentialEnvItem[] }> {
  const needsGh = commandNeedsTool(req.cmd, 'gh');
  const needsAz = commandNeedsTool(req.cmd, 'az');
  const needsGws = commandNeedsTool(req.cmd, 'gws');
  const needsHiggsfield = commandNeedsTool(req.cmd, 'higgsfield');
  if (!needsGh && !needsAz && !needsGws && !needsHiggsfield) return { req };

  const containerRef = box.container_id || `tower-box-${box.id}`;
  const localCredentialRoot = credentialRoot ?? `/tmp/tower-credentials/${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const env: Record<string, string> = { ...req.env, PATH: `/opt/tower-tools/bin:${req.env?.PATH ?? '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin'}` };
  const injected: RuntimeCredentialEnvItem[] = [];

  // gh/az are still legacy trusted-pool bridges gated by .project/connections.json.
  // gws below is Credential Vault-gated and does not depend on connections.json.
  const connections = await readProjectConnections(box.project_root);
  const mayUseTrustedPool = connections ? await userMayUseTrustedCredentialPool(req.userId, connections) : false;

  if (mayUseTrustedPool && (needsGh || commandNeedsGitHubIdentity(req.cmd))) {
    await ensureRuntimeBoxTool(box, 'gh');
    const githubReq = await withProjectGitHubIdentityEnv(box, { ...req, env });
    Object.assign(env, githubReq.env ?? {});
  }

  if (mayUseTrustedPool && needsAz) {
    await ensureRuntimeBoxTool(box, 'az');
    await dockerExecShell(containerRef, `rm -rf ${localCredentialRoot}/azure && mkdir -p ${localCredentialRoot}`, 10_000);
    await spawnDockerCmd(['cp', '/home/tower/.azure', `${containerRef}:${localCredentialRoot}/azure`], { timeoutMs: 30_000 });
    env.AZURE_CONFIG_DIR = `${localCredentialRoot}/azure`;
  }

  if (needsGws) {
    Object.assign(env, withRuntimeBoxTowerIdentityEnv(env, req.userId));
    await ensureRuntimeBoxTool(box, 'gws');
    const gws = await materializeGwsConfigFromVault({ box, userId: req.userId, credentialRoot: localCredentialRoot, env, command: req.cmd });
    injected.push(...gws.injected);
  }

  if (needsHiggsfield) {
    const higgsfield = await prepareHiggsfieldPersistentSession({ box, env });
    injected.push(...higgsfield.injected);
  }

  return {
    req: { ...req, env },
    injected,
    cleanup: async () => {
      if (!credentialRoot) await dockerExecShell(containerRef, `rm -rf ${localCredentialRoot}`, 10_000);
    },
  };
}

/**
 * `docker run` 으로 Box 컨테이너를 시작. 성공 시 container ID 반환.
 *
 * 보안 원칙 (코드 레벨 강제):
 *   ✅ project_root:/workspace:rw 바인드 마운트 (경계 재검증 후)
 *   ✅ --security-opt no-new-privileges (setuid/setgid 상승 방지)
 *   ✅ --memory, --cpus, --pids-limit (자원 상한)
 *   ❌ /var/run/docker.sock 마운트 금지 (Docker-in-Docker)
 *   ❌ --privileged 금지
 *   ❌ Tower .env / DATABASE_URL 주입 금지
 *   ❌ --network host 금지 (host port sniffing 방지)
 *
 * NOTE: --cap-drop ALL 은 v1 에서 비활성.
 *   npm/pip postinstall scripts 중 CAP_CHOWN / CAP_FOWNER 가 필요한 패키지가
 *   있어 드롭하면 install 실패 사례 있음.
 *   개선 경로: 이미지에 non-root user 추가 + --user uid:gid 조합으로
 *   Phase 2 에서 --cap-drop ALL 재활성화 검토.
 */
export function isDockerContainerNameConflict(stderr: string, containerName: string): boolean {
  return stderr.includes('Conflict. The container name') && stderr.includes(`/${containerName}`);
}

export function isDockerImageMissingError(stderr: string): boolean {
  return ['Unable to find image', 'No such image', 'pull access denied', 'manifest unknown']
    .some((message) => stderr.includes(message));
}

async function restorePinnedRuntimeBoxImage(image: string): Promise<boolean> {
  if (!/^sha256:[0-9a-f]{64}$/.test(image)) return false;
  const archive = process.env.RUNTIME_BOX_IMAGE_ARCHIVE?.trim();
  if (!archive || !path.isAbsolute(archive)) return false;
  try { await fs.access(archive); } catch { return false; }
  const load = await spawnDockerCmd(['load', '--input', archive], { timeoutMs: 15 * 60_000 });
  if (load.exitCode !== 0) return false;
  const inspect = await spawnDockerCmd(['image', 'inspect', image, '--format', '{{.Id}}'], { timeoutMs: 30_000 });
  return inspect.exitCode === 0 && inspect.stdout.trim() === image;
}

async function startDockerContainer(
  box: BoxRow,
  options: { cleanupContainerName?: boolean } = {},
): Promise<{ containerId: string; workbenchPlan: WorkbenchToolProjectionPlan }> {
  const image = runtimeBoxImageForProfile(box.runtime_profile);
  const containerName = `tower-box-${box.id}`;
  const cleanupContainerName = options.cleanupContainerName !== false;

  // Docker bind mount 직전 경계 이중 검증 (방어적)
  assertProjectRootBoundary(box.project_root);

  // Generic starts may clean stale same-name containers. Exact replacement disables
  // this because a foreign/unknown owner appearing after exact removal must never
  // be deleted as implicit orphan cleanup.
  if (cleanupContainerName) await spawnDockerCmd(['rm', '-f', containerName]);

  // Existing DB rows may predate the cap; enforce the cap at Docker boundary too.
  const memoryMb = clampBoxMemoryMb(box.memory_mb);
  const bindMountEnabled = projectUsesSkillBindMount({
    id: box.project_id,
    rootPath: box.project_root,
  });
  const skillMountPlan = bindMountEnabled
    ? buildRuntimeSkillBindMountPlan(box.project_root)
    : { enabled: false, mounts: [], skipped: [], durationMs: 0 };
  if (bindMountEnabled && !skillMountPlan.enabled) {
    throw new RuntimeBoxError(
      `Runtime skill bind-ro plan invalid for project ${box.project_id}: ${skillMountPlan.skipped.map((item) => `${item.name}:${item.reason}`).join(',') || 'no_mounts'}. `
      + 'Reconcile the project skill manifest before starting the Runtime Box.',
    );
  } else if (skillMountPlan.enabled) {
    console.log(`[runtime-box] skill bind-ro plan project=${box.project_id} mounts=${skillMountPlan.mounts.length} prepare_ms=${skillMountPlan.durationMs.toFixed(1)}`);
  }

  const workbenchPlan = await buildWorkbenchToolProjectionPlan(box.project_id);
  if (workbenchPlan.enabled) {
    console.log(`[runtime-box] Workbench tool bind-ro plan project=${box.project_id} revision=${workbenchPlan.revision}`);
  }

  const runArgs = [
    'run', '-d',
    '--name',         containerName,
    '--memory',       `${memoryMb}m`,
    '--memory-swap',  `${memoryMb}m`,   // swap 비활성 (swap = memory limit)
    '--cpus',         String(box.cpu_limit),
    '--pids-limit',   String(box.pids_limit),
    '--security-opt', 'no-new-privileges',
    // TODO Phase 2: --cap-drop ALL + --user <uid>:<gid> (non-root image 빌드 후)
    '-v',             `${box.project_root}:/workspace:rw`,
    // Docker applies these child mounts after the project mount. This avoids
    // host mount propagation requirements and makes the teamskills source
    // read-only only inside the Runtime Box.
    ...runtimeSkillDockerMountArgs(skillMountPlan),
    // Workbench tools use a Project-external immutable revision store. Only
    // the active revision is projected into the normal Runtime Box, read-only.
    ...runtimeWorkbenchToolDockerMountArgs(workbenchPlan),
    '-w',             '/workspace',
    '--label',        `tower.box.id=${box.id}`,
    '--label',        `tower.project.id=${box.project_id}`,
    // ⚠️ 금지 (검색 가능하게 명시):
    //   NO: -v /var/run/docker.sock:/var/run/docker.sock
    //   NO: --privileged
    //   NO: -e DATABASE_URL=... / -e JWT_SECRET=...
    //   NO: --network host
    image,
    'sleep', 'infinity',
  ];

  let result = await spawnDockerCmd(runArgs);
  if (result.exitCode !== 0 && isDockerImageMissingError(result.stderr) && await restorePinnedRuntimeBoxImage(image)) {
    result = await spawnDockerCmd(runArgs);
  }
  if (cleanupContainerName && result.exitCode !== 0 && isDockerContainerNameConflict(result.stderr, containerName)) {
    // 시작 직전 정리와 docker run 사이에 남은 이름 충돌은 한 번 더 정리해 자동 복구한다.
    // global advisory lock이 Tower의 Box start를 직렬화하므로 같은 앱의 정상 start를 지우지 않는다.
    await spawnDockerCmd(['rm', '-f', containerName]);
    result = await spawnDockerCmd(runArgs);
  }

  if (result.exitCode !== 0) {
    const err = result.stderr;
    if (isDockerImageMissingError(err)) {
      throw new RuntimeBoxError(
        `Runtime Box Docker backend not ready: image "${image}" not found. ` +
        `이미지를 빌드하거나 RUNTIME_BOX_IMAGE 를 기존 이미지명으로 설정하세요.`,
      );
    }
    if (result.exitCode === -1) {
      throw new RuntimeBoxError(
        `Docker 를 찾을 수 없음: ${err}. ` +
        `Docker 가 설치되어 있고 PATH 에 있는지 확인하세요 (RUNTIME_BOX_DOCKER_BIN 로 경로 지정 가능).`,
      );
    }
    throw new RuntimeBoxError(
      `docker run 실패 (exit ${result.exitCode}): ${err.slice(0, 500)}`,
    );
  }

  // docker run -d 는 성공 시 64자 container ID 를 stdout 에 반환
  return {
    containerId: result.stdout.trim().slice(0, 64) || containerName,
    workbenchPlan,
  };
}

/**
 * 실행 중인 Box 컨테이너 안에서 명령 실행.
 *
 * - cwd 는 /workspace 또는 /workspace/... 만 허용
 * - env 값에 개행/null 바이트 포함 시 해당 항목 무시 (주입 방지)
 * - timeout: Node spawn SIGKILL
 * - exit_code 137 + timedOut=false → oom_killed=true
 * - stdout/stderr 각 1MB 상한
 */
/**
 * OS package manager commands intentionally mutate the container image layer and
 * need container-root. Normal project commands should run as the host project
 * uid/gid so generated artifacts are writable from Tower file APIs and later
 * sessions.
 */
export function shouldRunRuntimeBoxCommandAsRoot(cmd: string): boolean {
  return /(^|[;&|()\s])(sudo\s+)?(apt-get|apt|dpkg|add-apt-repository)\s+/.test(cmd);
}

export function parseRuntimeBoxUserSpec(userSpec: string | undefined): { uid: string; gid: string } | undefined {
  const match = userSpec?.match(/^(\d+):(\d+)$/);
  if (!match) return undefined;
  return { uid: match[1], gid: match[2] };
}

/**
 * Root commands still run as uid 0, but with the project gid so fresh files are
 * group-associated with the host project owner instead of root:root.
 */
export function runtimeBoxRootUserArgs(projectOwnerSpec: string | undefined): string[] {
  const ids = parseRuntimeBoxUserSpec(projectOwnerSpec);
  return ids ? ['--user', `0:${ids.gid}`] : [];
}

/** Keep root-created files group-writable by default without using world-writable modes. */
export function runtimeBoxShellCommandForExec(cmd: string, runAsRoot: boolean): string {
  return runAsRoot ? `umask 0002\n${cmd}` : cmd;
}

/** Shell snippet used after a root command to restore host editability for touched project files. */
export function recentWorkspaceOwnershipNormalizeScript(): string {
  return [
    'if [ -e "$1" ]; then',
    '  find /workspace -xdev \\( \\( -newer "$1" -o -cnewer "$1" \\) -a \\( -user 0 -o -group 0 \\) \\) -exec chown -h "$2" {} +;',
    '  find /workspace -xdev \\( -newer "$1" -o -cnewer "$1" \\) ! -type l -exec chmod u+rwX,g+rwX {} +;',
    '  rm -f "$1";',
    'fi',
  ].join(' ');
}

/** Return the host uid/gid that owns the bind-mounted project root. */
async function projectOwnerUserSpec(box: BoxRow): Promise<string | undefined> {
  try {
    const stat = await fs.stat(box.project_root);
    return `${stat.uid}:${stat.gid}`;
  } catch (err) {
    console.warn(`[runtime-box] failed to stat project root for uid/gid (${box.project_root}); falling back to container default user:`, (err as Error).message);
    return undefined;
  }
}

/**
 * Best-effort cleanup for the narrow case where a root command writes into the
 * bind-mounted project directory. The marker limits the scan to files changed
 * by this root command, avoiding a full workspace chown on every exec.
 */
async function normalizeRecentWorkspaceOwnership(
  containerRef: string,
  userSpec: string | undefined,
  markerPath: string | undefined,
): Promise<void> {
  if (!userSpec || userSpec === '0:0' || !markerPath) return;
  const cmd = recentWorkspaceOwnershipNormalizeScript();
  const result = await spawnDockerCmd(
    ['exec', containerRef, 'sh', '-c', cmd, 'sh', markerPath, userSpec],
    { timeoutMs: 30_000 },
  );
  if (result.exitCode !== 0 && !result.timedOut) {
    console.warn(`[runtime-box] recent workspace ownership normalization failed: ${result.stderr.slice(0, 500)}`);
  } else if (result.timedOut) {
    console.warn('[runtime-box] recent workspace ownership normalization timed out; continuing');
  }
}

export function clampRuntimeBoxExecTimeoutMs(timeoutSec?: number): number {
  return Math.min(
    Math.max((timeoutSec ?? RUNTIME_BOX_EXEC_TIMEOUT_DEFAULT_SEC) * 1_000, 1_000),
    RUNTIME_BOX_EXEC_TIMEOUT_MAX_SEC * 1_000,
  );
}

async function execDockerCommand(
  box: BoxRow,
  req: ExecRequest,
  cwd: string,
): Promise<{ exit_code: number; stdout: string; stderr: string; duration_ms: number; timed_out: boolean; oom_killed: boolean }> {
  // container_id 가 있으면 사용 (more reliable). 없으면 이름으로 fallback.
  const containerRef = box.container_id || `tower-box-${box.id}`;
  const timeoutMs = isManagedDownloadCommand(req.cmd)
    ? Math.max(1, Math.min(DOWNLOAD_TIMEOUT_MAX_SEC, req.timeout_sec ?? DOWNLOAD_TIMEOUT_MAX_SEC)) * 1000
    : clampRuntimeBoxExecTimeoutMs(req.timeout_sec);
  const started = Date.now();

  const runAsRoot = shouldRunRuntimeBoxCommandAsRoot(req.cmd);
  const ownerUserSpec = await projectOwnerUserSpec(box);
  const userArgs = runAsRoot
    ? runtimeBoxRootUserArgs(ownerUserSpec)
    : ownerUserSpec ? ['--user', ownerUserSpec] : [];
  const markerPath = runAsRoot
    ? `/tmp/tower-runtime-box-marker-${box.id}-${Date.now()}-${Math.random().toString(16).slice(2)}`
    : undefined;

  if (markerPath) {
    await spawnDockerCmd(['exec', containerRef, 'touch', markerPath], { timeoutMs: 5_000 });
  }

  // env 주입 — 값 검증: 개행/null 바이트 포함 항목은 무시
  const envArgs: string[] = [];
  if (!runAsRoot) {
    // Numeric --user may not have a passwd entry/home. Give package managers
    // and language tools writable state outside read-only managed skill mounts.
    // uv may read pyproject.toml/scripts from .tower/skills, but its cache and
    // Python bytecode must never be written back into the canonical source.
    envArgs.push('-e', 'HOME=/tmp/tower-runtime-home');
    envArgs.push('-e', 'XDG_CACHE_HOME=/tmp/tower-runtime-cache');
    envArgs.push('-e', 'UV_CACHE_DIR=/tmp/tower-runtime-cache/uv');
    envArgs.push('-e', 'PYTHONDONTWRITEBYTECODE=1');
  }
  // Managed Workbench tools are project-scoped and survive container recreation via /workspace.
  // Caller PATH remains available after the immutable active revision prefix.
  const requestedPath = req.env?.PATH;
  envArgs.push('-e', `PATH=${withWorkbenchToolPath(requestedPath)}`);
  if (req.env) {
    for (const [k, v] of Object.entries(req.env)) {
      if (k === 'PATH') continue;
      if (/[\r\n\0]/.test(k) || /[\r\n\0]/.test(v)) {
        console.warn(`[runtime-box] exec env skipped (unsafe chars in key/value): ${k}`);
        continue;
      }
      envArgs.push('-e', `${k}=${v}`);
    }
  }

  const cancellationPidFile = req.signal
    ? `/tmp/tower-exec-${box.id}-${Date.now()}-${Math.random().toString(16).slice(2)}.pid`
    : undefined;
  const command = runtimeBoxShellCommandForExec(req.cmd, runAsRoot);
  const boundedCommand = cancellationPidFile
    ? `exec setsid --wait sh -c ${shellQuote(`printf '%s\\n' "$$" > ${shellQuote(cancellationPidFile)}; exec sh -c ${shellQuote(command)}`)}`
    : command;
  const killExecutionGroup = cancellationPidFile
    ? async () => {
        // The setsid shell PID is also the process-group ID. TERM first, then
        // KILL any survivors, and only then let docker exec detach/finalize.
        const killScript = `i=0; pid=''; while [ "$i" -lt 20 ] && [ -z "$pid" ]; do `
          + `pid=$(cat ${shellQuote(cancellationPidFile)} 2>/dev/null || true); [ -n "$pid" ] || sleep 0.05; i=$((i+1)); done; `
          + `if [ -n "$pid" ]; then /usr/bin/kill -TERM -- "-$pid" 2>/dev/null || true; sleep 0.5; `
          + `/usr/bin/kill -KILL -- "-$pid" 2>/dev/null || true; sleep 0.1; `
          + `if ps -eo pgid=,stat= | awk -v pgid="$pid" '$1 == pgid && $2 !~ /^Z/ { found=1 } END { exit !found }'; then exit 42; fi; fi; `
          + `rm -f ${shellQuote(cancellationPidFile)}`;
        const killed = await spawnDockerCmd(['exec', containerRef, 'sh', '-c', killScript], { timeoutMs: 5_000 });
        if (killed.exitCode !== 0 || killed.timedOut) {
          throw new RuntimeBoxError(`PROCESS_TREE_STILL_RUNNING: failed to terminate execution process group (${killed.stderr || `exit ${killed.exitCode}`})`);
        }
      }
    : undefined;

  const result = await spawnDockerCmd(
    ['exec', ...userArgs, '-w', cwd, ...envArgs, containerRef, 'sh', '-c', boundedCommand],
    {
      timeoutMs,
      preserveStdoutTail: isManagedDownloadCommand(req.cmd),
      onStdout: req.onStdout,
      onStderr: req.onStderr,
      signal: req.signal,
      onAbort: killExecutionGroup,
    },
  );
  if (cancellationPidFile) {
    await spawnDockerCmd(['exec', containerRef, 'rm', '-f', cancellationPidFile], { timeoutMs: 5_000 });
  }

  await normalizeRecentWorkspaceOwnership(containerRef, ownerUserSpec, markerPath);

  return {
    // timeout kill 시 exit_code 124 (POSIX timeout convention)
    exit_code: result.timedOut ? 124 : result.exitCode,
    stdout:    result.stdout,
    stderr:    result.stderr,
    duration_ms: Date.now() - started,
    timed_out:   result.timedOut,
    // OOM: exit 137(SIGKILL by kernel) 이면서 timeout kill 이 아닌 경우
    oom_killed: !result.timedOut && result.exitCode === 137,
  };
}

/**
 * 컨테이너 stop(10s grace) + rm. "No such container" 는 성공 취급.
 */
async function stopDockerContainer(containerRef: string): Promise<void> {
  await spawnDockerCmd(['stop', '--time', '10', containerRef]);
  await spawnDockerCmd(['rm', '--force', containerRef]);
}

export interface RuntimeBoxExactRecreateAudit {
  stage: 'complete';
  previousContainerId: string;
  containerId: string;
  oldContainerRestored: false;
}

/**
 * Exact replacement primitive for A4b. Caller owns M → A → L and passes authentic
 * A/L tokens. This never calls ensureRunning, capacity reclaim, or Service writers.
 */
export async function recreateRuntimeBoxExactWithLocksHeld(input: {
  boxId: number;
  projectId: string;
  expectedContainerId: string;
  activity: RuntimeBoxActivityLockHeld;
  lifecycle: RuntimeBoxLifecycleLockHeld;
  onDestructiveStart?: () => void;
}): Promise<{ box: BoxRow; audit: RuntimeBoxExactRecreateAudit }> {
  assertRuntimeBoxActivityLockHeld(input.activity, input.boxId);
  assertRuntimeBoxLifecycleLockHeld(input.lifecycle, input.boxId);

  const current = await queryBoxOne(
    `SELECT * FROM project_runtime_boxes
      WHERE id=$1 AND project_id=$2 AND status='running' AND container_id=$3`,
    [input.boxId, input.projectId, input.expectedContainerId],
  );
  if (!current) throw new RuntimeBoxError('STALE_RUNTIME: exact approved Runtime is no longer running');

  const observed = await observeRuntimeBoxContainer({
    containerRef: input.expectedContainerId,
    expectedBoxId: input.boxId,
    expectedProjectId: input.projectId,
    inspect: inspectRuntimeBoxContainer,
  });
  if (observed.kind !== 'running' || observed.identity.containerId !== input.expectedContainerId) {
    throw new RuntimeBoxError(`STALE_RUNTIME: approved container observation is ${observed.kind}`);
  }

  input.onDestructiveStart?.();
  await stopDockerContainer(input.expectedContainerId);
  const absent = await observeRuntimeBoxContainer({
    containerRef: input.expectedContainerId,
    expectedBoxId: input.boxId,
    expectedProjectId: input.projectId,
    inspect: inspectRuntimeBoxContainer,
  });
  if (absent.kind !== 'not_found') {
    throw new RuntimeBoxError(`RECOVERY_REQUIRED: removed Runtime observation is ${absent.kind}`);
  }

  await transaction(async client => {
    const db = withClient(client);
    const transitioned = await db.execute(
      `UPDATE project_runtime_boxes
          SET status='starting',container_id=NULL,stopped_at=NOW(),updated_at=NOW(),last_error=NULL,error_at=NULL
        WHERE id=$1 AND project_id=$2 AND status='running' AND container_id=$3`,
      [input.boxId, input.projectId, input.expectedContainerId],
    );
    if (transitioned.changes !== 1) {
      throw new RuntimeBoxError('RECOVERY_REQUIRED: exact Runtime DB transition missed after removal');
    }
    await db.execute(
      `UPDATE runtime_box_services
          SET status=CASE WHEN status='expired' THEN 'expired' ELSE 'stopped' END,
              process_pid=NULL,stopped_at=COALESCE(stopped_at,NOW())
        WHERE box_id=$1 AND status IN ('pending','running','error')`,
      [input.boxId],
    );
    await db.execute(
      `UPDATE runtime_box_workbench_tool_projections
          SET status=CASE WHEN status='recovery_required' THEN 'recovery_required' ELSE 'unmounted' END,
              updated_at=NOW()
        WHERE box_id=$1`,
      [input.boxId],
    );
  });

  let started: Awaited<ReturnType<typeof startDockerContainer>> | undefined;
  let projectionRecorded = false;
  try {
    const starting = await queryBoxOne(
      `SELECT * FROM project_runtime_boxes WHERE id=$1 AND project_id=$2 AND status='starting'`,
      [input.boxId, input.projectId],
    );
    if (!starting) throw new RuntimeBoxError('replacement Runtime starting row disappeared');
    started = await startDockerContainer(starting, { cleanupContainerName: false });
    await recordWorkbenchToolProjection({ boxId: input.boxId, plan: started.workbenchPlan });
    projectionRecorded = started.workbenchPlan.enabled;
    const updated = await execute(
      `UPDATE project_runtime_boxes
          SET status='running',container_id=$2,started_at=NOW(),last_active_at=NOW(),updated_at=NOW(),last_error=NULL,error_at=NULL
        WHERE id=$1 AND project_id=$3 AND status='starting' AND container_id IS NULL`,
      [input.boxId, started.containerId, input.projectId],
    );
    if (updated.changes !== 1) throw new RuntimeBoxError('replacement Runtime DB activation missed');
    const box = await queryBoxOne('SELECT * FROM project_runtime_boxes WHERE id=$1', [input.boxId]);
    if (!box) throw new RuntimeBoxError('replacement Runtime row disappeared');
    return {
      box,
      audit: {
        stage: 'complete',
        previousContainerId: input.expectedContainerId,
        containerId: started.containerId,
        oldContainerRestored: false,
      },
    };
  } catch (error) {
    if (started) await stopDockerContainer(started.containerId).catch(() => undefined);
    if (projectionRecorded) await markWorkbenchToolProjectionRecoveryRequired(input.boxId).catch(() => undefined);
    const reason = `recreate start failed; old container remains absent; ${(error as Error).message}`;
    await execute(
      `UPDATE project_runtime_boxes
          SET status='error',container_id=NULL,last_error=$2,error_at=NOW(),updated_at=NOW()
        WHERE id=$1`,
      [input.boxId, reason.slice(0, 2000)],
    );
    await markWorkbenchToolProjectionRecoveryRequired(input.boxId).catch(() => undefined);
    throw error;
  }
}

// ── Box 시작 / 종료 ───────────────────────────────────────────────────────

/**
 * Box 가 stopped / idle_stopped 이면 시작.
 * running 이면 그대로 반환.
 *
 * @param userId optional — 제공 시 per-user budget gate 도 검사.
 *
 * TODO #1 (Docker 구현 필요):
 *   - `docker run -d` 명령으로 컨테이너 시작
 *   - --memory, --cpus, --pids-limit 적용
 *   - -v {project_root}:/workspace:rw
 *   - --security-opt no-new-privileges
 *   - Docker socket 절대 mount 금지
 *   - Tower host .env / DB credential 주입 금지
 *   - network: 기본 bridge (프로젝트 내부 연결), 외부 허용 (v1)
 *   - container name: tower-box-{box_id}
 */
export async function ensureRunning(boxId: number, userId?: number): Promise<BoxRow> {
  const box = await queryBoxOne(
    'SELECT * FROM project_runtime_boxes WHERE id = $1',
    [boxId],
  );
  if (!box) throw new RuntimeBoxError(`box ${boxId} not found`);
  const project = await queryOne<{ lifecycle_status: string | null; archived: number | null }>(
    'SELECT lifecycle_status, archived FROM projects WHERE id = $1', [box.project_id],
  );
  if (!project || project.archived || (project.lifecycle_status ?? 'active') !== 'active') {
    throw new RuntimeBoxError(`project ${box.project_id} is retired; Runtime Box start is disabled`);
  }

  const configuredImage = runtimeBoxImageForProfile(box.runtime_profile);
  if (box.status === 'running') {
    const containerRef = box.container_id || `tower-box-${box.id}`;
    const appliedImage = await inspectContainerImageRef(containerRef);
    if (!runtimeBoxImageNeedsRecreate(appliedImage, configuredImage)) return box;
    console.log(`[runtime-box] recreating box ${box.id}: image changed ${appliedImage || 'unknown'} -> ${configuredImage}`);
    await stopBox(box.id, 'stopped');
    return ensureRunning(box.id, userId);
  }

  if (box.status === 'starting') {
    // 다른 세션이 이미 시작 중 — 최대 10초 대기 후 반환
    await waitForStatus(boxId, 'running', 10_000);
    return (await queryBoxOne('SELECT * FROM project_runtime_boxes WHERE id = $1', [boxId]))!;
  }

  const start = async (): Promise<BoxRow> => {
    // 사용자 lock 대기 중 같은 프로젝트가 먼저 시작됐을 수 있으므로 다시 확인한다.
    const currentBox = await queryBoxOne('SELECT * FROM project_runtime_boxes WHERE id = $1', [boxId]);
    if (!currentBox) throw new RuntimeBoxError(`box ${boxId} not found`);
    if (currentBox.status === 'running') return currentBox;
    if (currentBox.status === 'starting') {
      await waitForStatus(boxId, 'running', 10_000);
      return (await queryBoxOne('SELECT * FROM project_runtime_boxes WHERE id = $1', [boxId]))!;
    }

    // per-user 한도 회수는 global gate보다 먼저 수행한다. 회수된 한 슬롯은 두 예산을 함께 낮춘다.
    if (userId !== undefined) await reclaimUserRuntimeBoxSlotOrThrow(userId, boxId);
    await assertGlobalBoxBudget();

    await execute(
      `UPDATE project_runtime_boxes SET status = 'starting', updated_at = now() WHERE id = $1`,
      [boxId],
    );

    let started: Awaited<ReturnType<typeof startDockerContainer>> | undefined;
    let projectionRecorded = false;
    try {
      const freshBox = await queryBoxOne(
        'SELECT * FROM project_runtime_boxes WHERE id = $1',
        [boxId],
      );
      if (!freshBox) throw new RuntimeBoxError(`box ${boxId} disappeared during start`);

      started = await startDockerContainer(freshBox);
      await recordWorkbenchToolProjection({ boxId, plan: started.workbenchPlan });
      projectionRecorded = started.workbenchPlan.enabled;

      await execute(
        `UPDATE project_runtime_boxes
           SET status = 'running', container_id = $2,
               started_at = now(), last_active_at = now(), updated_at = now(),
               last_error = NULL, error_at = NULL
         WHERE id = $1`,
        [boxId, started.containerId],
      );
    } catch (e) {
      if (started) {
        await stopDockerContainer(started.containerId).catch(() => undefined);
      }
      if (projectionRecorded) {
        // The projection was mounted and observed, but the Runtime never reached a
        // durable running state. Preserve that lifecycle divergence for operators.
        await markWorkbenchToolProjectionRecoveryRequired(boxId).catch(() => undefined);
      }
      await execute(
        `UPDATE project_runtime_boxes
           SET status = 'error', container_id = NULL,
               last_error = $2, error_at = now(), updated_at = now()
         WHERE id = $1`,
        [boxId, (e as Error).message],
      );
      throw new RuntimeBoxError(`failed to start box ${boxId}: ${(e as Error).message}`);
    }

    return (await queryBoxOne('SELECT * FROM project_runtime_boxes WHERE id = $1', [boxId]))!;
  };

  return withRuntimeBoxStartLocks(userId, start);
}

/**
 * 모든 Box start를 global lock으로 직렬화해 전역 한도를 지키고, user lock으로
 * 같은 사용자의 회수 계약도 명시한다. lock 순서는 항상 global → user로 고정한다.
 */
async function withRuntimeBoxStartLocks<T>(userId: number | undefined, fn: () => Promise<T>): Promise<T> {
  const client = await getPgPool().connect();
  const lockKeys = [
    'runtime-box-global-start',
    ...(userId === undefined ? [] : [`runtime-box-user-start:${userId}`]),
  ];
  try {
    for (const lockKey of lockKeys) {
      await client.query('SELECT pg_advisory_lock(hashtextextended($1, 0))', [lockKey]);
    }
    return await fn();
  } finally {
    try {
      for (const lockKey of [...lockKeys].reverse()) {
        await client.query('SELECT pg_advisory_unlock(hashtextextended($1, 0))', [lockKey]);
      }
    } finally {
      client.release();
    }
  }
}

/** 한도 도달 시 이미 idle-stop 기준을 지난 안전한 LRU Box 하나를 회수한다. */
async function reclaimUserRuntimeBoxSlotOrThrow(userId: number, targetBoxId: number): Promise<void> {
  const limit = getLiveRuntimeBoxCapacity().maxRunningPerUser;
  let current = await countRunningBoxesByUser(userId);
  if (current < limit) return;

  const occupancy = await listUserRuntimeBoxOccupancy(userId, targetBoxId);
  const candidate = selectReclaimableRuntimeBox(occupancy);
  if (candidate) {
    const attempt = await tryWithRuntimeBoxActivityLock(candidate.id, async activity => {
      assertRuntimeBoxActivityLockHeld(activity, candidate.id);
      return withRuntimeBoxLifecycleLock(candidate.id, async lifecycle => {
        assertRuntimeBoxLifecycleLockHeld(lifecycle, candidate.id);
        // 후보 조회 뒤 새 exec가 시작됐을 수 있으므로 A → L 안에서 조건을 다시 확인한다.
        const refreshed = await listUserRuntimeBoxOccupancy(userId, targetBoxId);
        const stillReclaimable = selectReclaimableRuntimeBox(refreshed);
        if (stillReclaimable?.id !== candidate.id) return false;
        await stopBoxWithLocksHeld(candidate.id, 'idle_stopped', activity, lifecycle);
        return true;
      });
    });
    const reclaimed = attempt.acquired && attempt.value;
    if (reclaimed) {
      console.log(`[runtime-box] reclaimed idle box ${candidate.id} (${candidate.project_id}) for user ${userId}`);
      current = await countRunningBoxesByUser(userId);
      if (current < limit) return;
    }
  }

  throw new RuntimeBoxError(formatUserRuntimeBoxBudgetError({ current, limit, occupancy }));
}

/**
 * Box 를 stop. bind mount volume 은 유지 (프로젝트 파일 보존).
 *
 * @param targetStatus 'stopped' (명시적 stop) | 'idle_stopped' (idle cron).
 *                     기본값 'stopped'.
 * Docker stop 실패는 경고 로그만 — DB 상태는 어떻게든 갱신.
 */
export async function stopBox(
  boxId: number,
  targetStatus: 'stopped' | 'idle_stopped' = 'stopped',
): Promise<void> {
  const attempt = await tryWithRuntimeBoxActivityLock(boxId, activity =>
    withRuntimeBoxLifecycleLock(boxId, lifecycle =>
      stopBoxWithLocksHeld(boxId, targetStatus, activity, lifecycle)));
  if (!attempt.acquired) throw new RuntimeBoxError(`box ${boxId} has an active execution; stop was not started`);
}

async function stopBoxWithLocksHeld(
  boxId: number,
  targetStatus: 'stopped' | 'idle_stopped',
  activity: RuntimeBoxActivityLockHeld,
  lifecycle: RuntimeBoxLifecycleLockHeld,
): Promise<void> {
  assertRuntimeBoxActivityLockHeld(activity, boxId);
  assertRuntimeBoxLifecycleLockHeld(lifecycle, boxId);
  const box = await queryBoxOne(
    'SELECT * FROM project_runtime_boxes WHERE id = $1',
    [boxId],
  );
  if (!box || box.status === 'stopped' || box.status === 'idle_stopped') return;

  // Docker stop — 실패 시 경고만 (DB 상태는 갱신)
  const containerRef = box.container_id || `tower-box-${box.id}`;
  await stopDockerContainer(containerRef).catch(e => {
    console.warn(
      `[runtime-box] stopDockerContainer failed for box ${boxId} (${containerRef}):`,
      (e as Error).message,
    );
  });

  await execute(
    `UPDATE project_runtime_boxes
       SET status = $2, container_id = NULL, stopped_at = now(), updated_at = now()
     WHERE id = $1`,
    [boxId, targetStatus],
  );

  // Box 컨테이너가 내려가면 그 안의 서비스 프로세스도 모두 종료된다.
  // registry 에 stale running/PID 가 남으면 service_list 가 거짓 상태를 보여주므로 함께 정리한다.
  await execute(
    `UPDATE runtime_box_services
       SET status = CASE WHEN status = 'expired' THEN 'expired' ELSE 'stopped' END,
           process_pid = NULL,
           stopped_at = COALESCE(stopped_at, now())
     WHERE box_id = $1
       AND status IN ('pending', 'running', 'error')`,
    [boxId],
  );
  await markWorkbenchToolProjectionUnmounted(boxId);
}

/**
 * Box 를 완전 삭제. Docker 컨테이너 stop + rm 후 DB row 제거.
 * v1 은 bind mount 만 사용 → named volume 없음 (docker volume rm 불필요).
 * 프로젝트 파일 자체는 workspace/projects/ 에 그대로 유지.
 */
export async function destroyBox(boxId: number): Promise<void> {
  const attempt = await tryWithRuntimeBoxActivityLock(boxId, activity =>
    withRuntimeBoxLifecycleLock(boxId, async lifecycle => {
      await stopBoxWithLocksHeld(boxId, 'stopped', activity, lifecycle);
      await execute('DELETE FROM project_runtime_boxes WHERE id = $1', [boxId]);
    }));
  if (!attempt.acquired) throw new RuntimeBoxError(`box ${boxId} has an active execution; destroy was not started`);
}

// ── Exec ─────────────────────────────────────────────────────────────────

type RuntimeCredentialEnvItem = { credentialId: string; envName: string };
type RuntimeCredentialMaterializedFileItem = {
  credentialId: string;
  envName: string;
  credentialType?: string;
};
type RuntimeCredentialSkippedItem = { credentialId: string; envName?: string; reason: string };

/**
 * Collapse multi-stage credential materialization into a user-facing summary.
 *
 * The same secret can be injected by the broad API-key policy and later skipped
 * by a Credential Profile because the env key already exists. That is correct
 * internally but confusing in Runtime Context, so injected wins over skipped for
 * the same env/credential pair.
 */
export function summarizeCredentialEnvForRuntimeContext(opts: {
  injected: RuntimeCredentialEnvItem[];
  materializedFiles?: RuntimeCredentialMaterializedFileItem[];
  skippedExisting: RuntimeCredentialEnvItem[];
  skipped?: RuntimeCredentialSkippedItem[];
}): NonNullable<RuntimeContext['credential_env']> {
  const toKey = (item: RuntimeCredentialEnvItem) => `${item.envName}\u0000${item.credentialId}`;
  const injectedByKey = new Map<string, RuntimeCredentialEnvItem>();

  for (const item of opts.injected) {
    injectedByKey.set(toKey(item), item);
  }

  const skippedByKey = new Map<string, RuntimeCredentialEnvItem>();
  for (const item of opts.skippedExisting) {
    const key = toKey(item);
    if (injectedByKey.has(key)) continue;
    skippedByKey.set(key, item);
  }

  const sortItems = (items: RuntimeCredentialEnvItem[]) => items
    .sort((a, b) => `${a.envName}<-${a.credentialId}`.localeCompare(`${b.envName}<-${b.credentialId}`))
    .map(i => ({ credential_id: i.credentialId, env_name: i.envName }));
  const sortFileItems = (items: RuntimeCredentialMaterializedFileItem[] = []) => items
    .sort((a, b) => `${a.envName}<-${a.credentialId}`.localeCompare(`${b.envName}<-${b.credentialId}`))
    .map(i => ({ credential_id: i.credentialId, env_name: i.envName, kind: 'file' as const, ...(i.credentialType ? { credential_type: i.credentialType } : {}) }));
  const sortSkippedItems = (items: RuntimeCredentialSkippedItem[] = []) => items
    .sort((a, b) => `${a.envName ?? ''}<-${a.credentialId}<-${a.reason}`.localeCompare(`${b.envName ?? ''}<-${b.credentialId}<-${b.reason}`))
    .map(i => ({ credential_id: i.credentialId, ...(i.envName ? { env_name: i.envName } : {}), reason: i.reason }));

  return {
    injected: sortItems([...injectedByKey.values()]),
    materialized_files: sortFileItems(opts.materializedFiles),
    skipped_existing: sortItems([...skippedByKey.values()]),
    skipped: sortSkippedItems(opts.skipped),
  };
}

/**
 * Box 안에서 명령 실행.
 * Box 가 stopped 이면 on-demand start 후 실행.
 *
 * TODO #3 (Docker exec 구현 필요):
 *   - docker exec -it tower-box-{boxId} sh -c '{cmd}'
 *   - cwd 는 -w 플래그로 적용
 *   - env 는 -e K=V 로 주입 (Tower host secrets 는 주입 금지)
 *   - timeout 은 `timeout --signal=KILL {sec}` 로 wrapping
 *   - onStdout / onStderr 는 spawn 스트림으로 실시간 전달
 *   - OOM 판별: exit code 137
 */
export async function execInBox(req: ExecRequest): Promise<ExecResult> {
  // Start/capacity locks run before A to avoid a wait cycle with candidate reclaim.
  const started = await ensureRunning(req.boxId, req.userId);
  return withRuntimeBoxActivityLock(req.boxId, activity =>
    execInBoxWithActivityLock(req, started, activity));
}

export function assertExecBoxIdentityStable(started: BoxRow, current: BoxRow | undefined, boxId: number): BoxRow {
  if (!current) throw new RuntimeBoxError(`box ${boxId} not found`);
  if (current.status !== 'running' || current.container_id !== started.container_id) {
    throw new RuntimeBoxError(`box ${boxId} changed before exec; retry`);
  }
  return current;
}

/** exec 전체에서 A를 유지하고, 시작 직후 identity/status만 L 아래 짧게 재검증한다. */
async function execInBoxWithActivityLock(
  req: ExecRequest,
  started: BoxRow,
  activity: RuntimeBoxActivityLockHeld,
): Promise<ExecResult> {
  assertRuntimeBoxActivityLockHeld(activity, req.boxId);
  const runningBox = await withRuntimeBoxLifecycleLock(req.boxId, async lifecycle => {
    assertRuntimeBoxLifecycleLockHeld(lifecycle, req.boxId);
    const current = await queryBoxOne(
      'SELECT * FROM project_runtime_boxes WHERE id = $1',
      [req.boxId],
    );
    return assertExecBoxIdentityStable(started, current, req.boxId);
  });

  // cwd 검증: /workspace 이거나 /workspace/ 하위여야 함.
  // path.posix.normalize 로 /workspace/../ 같은 traversal 을 먼저 정규화한다.
  const rawCwd = req.cwd ?? BOX_WORKDIR;
  const cwd = path.posix.normalize(rawCwd);
  if (cwd !== BOX_WORKDIR && !cwd.startsWith(BOX_WORKDIR + '/')) {
    throw new RuntimeBoxError(
      `cwd 경계 위반: "${rawCwd}" 는 "${BOX_WORKDIR}" 또는 그 하위여야 함`,
    );
  }

  // Credential Vault and trusted external identity bridges materialize only for a
  // single docker exec. Risky/external-code commands run credential-free by default.
  const credentialSuppression = req.credentialMode === 'none'
    ? { suppress: true, reason: 'explicit internal credential-free execution policy' }
    : shouldSuppressCredentialEnv(req.cmd);
  const requestedCredentialScope = requestedCredentialEnvNames(req.cmd);

  // Resolve every credential immediately before this docker exec. The running
  // container never owns credential state, so grants, revocations, and rotations
  // take effect on the next command without restarting the Runtime Box.
  const containerRef = runningBox.container_id || `tower-box-${runningBox.id}`;
  const execId = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const credentialRoot = `/tmp/tower-credentials/${execId}`;
  const execution = await (async () => {
    let preparedCleanup: undefined | (() => Promise<void>);
    try {
      // Suppression applies to legacy identity bridges too; a credential-free
      // command must not receive a host GitHub token as a special case.
      const githubReq = credentialSuppression.suppress
        ? req
        : await withProjectGitHubIdentityEnv(runningBox, req);
      const prepared = credentialSuppression.suppress
        ? { req: githubReq, injected: [], cleanup: undefined as undefined | (() => Promise<void>) }
        : await prepareCliCredentialEnv(runningBox, githubReq, credentialRoot);
      preparedCleanup = prepared.cleanup;

      // Credential Vault API-key injection is the final env merge before docker exec.
      // Caller-provided env wins for duplicate keys; see credential-vault/_DECISIONS.md.
      const vaultEnv = credentialSuppression.suppress
        ? { env: prepared.req.env ?? {}, injected: [], skippedExisting: [], skipped: [] }
        : await resolveRuntimeBoxApiKeyEnv({
          projectId: runningBox.project_id,
          userId: req.userId,
          existingEnv: prepared.req.env,
          requestedEnvNames: requestedCredentialScope,
        });
      const fileResolution = credentialSuppression.suppress
        ? { materialize: [], skipped: [] }
        : await resolveRuntimeBoxCredentialFileMaterialization({
          projectId: runningBox.project_id,
          userId: req.userId,
          existingEnv: vaultEnv.env,
          requestedEnvNames: requestedCredentialScope,
        });
      const materializedFiles = credentialSuppression.suppress
        ? []
        : await materializeRuntimeCredentialFiles({
          box: runningBox,
          credentialRoot,
          env: vaultEnv.env,
          files: fileResolution.materialize,
          ownerUserSpec: await projectOwnerUserSpec(runningBox),
        });
      const finalReq = { ...prepared.req, env: vaultEnv.env };
      const execResult = await execDockerCommand(runningBox, finalReq, cwd);
      return { execResult, prepared, vaultEnv, fileResolution, materializedFiles };
    } finally {
      await preparedCleanup?.();
      if (!credentialSuppression.suppress) {
        await dockerExecShell(containerRef, `rm -rf ${shellQuote(credentialRoot)}`, 10_000);
      }
    }
  })();
  const { execResult, prepared, vaultEnv, fileResolution, materializedFiles } = execution;

  // last_active_at 갱신 (idle stop 기준) — exec 후 갱신
  await execute(
    'UPDATE project_runtime_boxes SET last_active_at = now(), updated_at = now() WHERE id = $1',
    [req.boxId],
  );

  // 실행 중인 서비스 목록 조회 (runtime context banner 용)
  const services = await query<Pick<ServiceRow, 'name' | 'internal_port' | 'status'>>(
    `SELECT name, internal_port, status FROM runtime_box_services
     WHERE box_id = $1 AND status = 'running'`,
    [req.boxId],
  );

  const credentialEnvSummary = {
    ...summarizeCredentialEnvForRuntimeContext({
      injected: [...(prepared.injected ?? []), ...vaultEnv.injected],
      materializedFiles,
      skippedExisting: vaultEnv.skippedExisting,
      skipped: [...vaultEnv.skipped, ...fileResolution.skipped],
    }),
    ...(credentialSuppression.suppress ? {
      suppressed: true,
      suppress_reason: credentialSuppression.reason,
    } : {}),
  };

  const runtimeContext: RuntimeContext = {
    runtime: 'project-runtime-box',
    project_id: runningBox.project_id,
    project_name: runningBox.project_id,  // TODO: join projects 해서 name 가져오기
    cwd,
    mount: 'project rw',
    services_running: services.map(s => ({
      name: s.name,
      port: s.internal_port,
      status: s.status,
    })),
    box_limits: {
      memory_mb: clampBoxMemoryMb(runningBox.memory_mb),
      cpu: parseFloat(runningBox.cpu_limit),
      idle_stop_minutes: runningBox.idle_stop_minutes,
    },
    credential_env: credentialEnvSummary,
    readiness: {
      baseline: 'tower-like-tooling',
      summary: 'browser/pdf/docs/media/presentation/dev utilities available; run runtime-box-doctor for base tools and runtime-skill-doctor for mounted managed skills',
      doctor_command: 'runtime-box-doctor; runtime-skill-doctor',
      capabilities: [
        'chromium-headless',
        'tower-html-render',
        'libreoffice',
        'pandoc-3.10',
        'typst-0.15.0',
        'pdf-tools',
        'imagemagick',
        'ffmpeg',
        'marp-cli',
        'mermaid-cli-11.16.0',
        'python-docs-data',
        'korean-fonts',
      ],
      harness_preferred: [
        'pdf_view for ordinary visual PDF reading',
        'harness OCR/PDF tools for user-facing OCR workflows; Runtime Box OCR binaries are for project-scoped preprocessing',
      ],
    },
  };

  return {
    ...execResult,
    runtime_context: runtimeContext,
  };
}

/** Internal credential-policy-preserving exec when an orchestrator already owns A. */
export async function execInBoxWithActivityLockHeld(
  req: ExecRequest,
  activity: RuntimeBoxActivityLockHeld,
): Promise<ExecResult> {
  assertRuntimeBoxActivityLockHeld(activity, req.boxId);
  const started = await queryBoxOne('SELECT * FROM project_runtime_boxes WHERE id=$1', [req.boxId]);
  if (!started || started.status !== 'running' || !started.container_id) {
    throw new RuntimeBoxError(`box ${req.boxId} is not running for held-activity exec`);
  }
  return execInBoxWithActivityLock(req, started, activity);
}

// ── Reconcile ────────────────────────────────────────────────────────────

async function inspectContainerImageRef(containerRef: string): Promise<string | undefined> {
  const result = await spawnDockerCmd([
    'inspect',
    '-f', '{{.Image}}',
    containerRef,
  ], { timeoutMs: 5_000 });
  if (result.exitCode !== 0) return undefined;
  const value = result.stdout.trim();
  return value || undefined;
}

async function inspectRuntimeBoxContainer(containerRef: string): Promise<DockerInspectResult> {
  return spawnDockerCmd(['inspect', containerRef], { timeoutMs: 5_000 });
}

async function cleanupVerifiedNonRunningContainer(containerId: string): Promise<void> {
  const stop = await spawnDockerCmd(['stop', '--time', '10', containerId]);
  if (stop.exitCode !== 0 && !/no such (?:object|container)|not found/i.test(stop.stderr)) {
    throw new RuntimeBoxError(`verified container stop failed: ${stop.stderr || `exit ${stop.exitCode}`}`);
  }
  const remove = await spawnDockerCmd(['rm', '--force', containerId]);
  if (remove.exitCode !== 0 && !/no such (?:object|container)|not found/i.test(remove.stderr)) {
    throw new RuntimeBoxError(`verified container remove failed: ${remove.stderr || `exit ${remove.exitCode}`}`);
  }
}

/**
 * Reconcile is a destructive lifecycle writer too. It must not project a
 * transient container absence while an exec or approved recreate owns A/L.
 */
async function reconcileConfirmedStaleRunningBox(rawBoxId: number): Promise<boolean> {
  const boxId = Number(rawBoxId);
  if (!Number.isSafeInteger(boxId) || boxId <= 0) {
    console.warn(`[runtime-box-reconcile] invalid Box id for confirmed-stale transition: ${String(rawBoxId)}`);
    return false;
  }
  const activity = await tryWithRuntimeBoxActivityLock(boxId, activityHeld =>
    withRuntimeBoxLifecycleLock(boxId, async lifecycleHeld => {
      assertRuntimeBoxActivityLockHeld(activityHeld, boxId);
      assertRuntimeBoxLifecycleLockHeld(lifecycleHeld, boxId);

      const current = await queryBoxOne(
        `SELECT * FROM project_runtime_boxes
          WHERE id=$1 AND status='running'`,
        [boxId],
      );
      if (!current) return false;

      const containerRef = current.container_id || `tower-box-${current.id}`;
      const observation = await observeRuntimeBoxContainer({
        containerRef,
        expectedBoxId: current.id,
        expectedProjectId: current.project_id,
        inspect: inspectRuntimeBoxContainer,
      });
      if (observation.kind === 'inspection_unknown' || observation.kind === 'identity_mismatch') {
        console.warn(`[runtime-box-reconcile] box ${current.id} locked observation blocked (${observation.kind})`);
        return false;
      }
      if (observation.kind === 'running') return false;
      if (observation.kind === 'not_running') {
        try {
          await cleanupVerifiedNonRunningContainer(observation.identity.containerId);
        } catch (error) {
          console.warn(`[runtime-box-reconcile] cleanup failed for ${containerRef}; DB state unchanged:`, (error as Error).message);
          return false;
        }
      }

      const transition = await transitionConfirmedStaleRuntime({
        boxId: current.id,
        expectedStatus: 'running',
        expectedContainerId: current.container_id,
        cause: observation.kind,
      });
      if (!transition.transitioned) {
        console.warn(`[runtime-box-reconcile] box ${current.id} changed before confirmed-stale transition`);
        return false;
      }
      console.log(`[runtime-box-reconcile] box ${current.id} atomically marked stopped (${containerRef} not running)`);
      return true;
    }));

  if (!activity.acquired) {
    console.log(`[runtime-box-reconcile] box ${boxId} active; confirmed-stale transition deferred`);
    return false;
  }
  return activity.value;
}

/**
 * DB 상태와 Docker 컨테이너 상태를 맞춘다.
 * - DB running/starting 이지만 컨테이너 없음/비실행 → stopped 처리 + service stale 정리
 * - DB stopped/idle/error 이지만 tower-box-N 컨테이너 잔재 존재 → rm -f
 */
export async function reconcileRuntimeBoxes(): Promise<number> {
  let changed = 0;
  const boxes = await queryBoxes(
    `SELECT * FROM project_runtime_boxes
     WHERE status IN ('running', 'starting', 'stopped', 'idle_stopped', 'error')`,
  );

  for (const box of boxes) {
    const containerRef = box.container_id || `tower-box-${box.id}`;
    const observation = await observeRuntimeBoxContainer({
      containerRef,
      expectedBoxId: box.id,
      expectedProjectId: box.project_id,
      inspect: inspectRuntimeBoxContainer,
    });

    if (observation.kind === 'inspection_unknown' || observation.kind === 'identity_mismatch') {
      console.warn(`[runtime-box-reconcile] box ${box.id} observation blocked (${observation.kind})`);
      continue;
    }

    if (box.status === 'running'
      && (observation.kind === 'not_found' || observation.kind === 'not_running')) {
      if (await reconcileConfirmedStaleRunningBox(box.id)) changed += 1;
      continue;
    }

    if (box.status === 'starting'
      && (observation.kind === 'not_found' || observation.kind === 'not_running')) {
      console.warn(`[runtime-box-reconcile] box ${box.id} starting state requires recovery authority; skipped`);
      continue;
    }

    if ((box.status === 'stopped' || box.status === 'idle_stopped' || box.status === 'error')
      && (observation.kind === 'running' || observation.kind === 'not_running')) {
      await stopDockerContainer(observation.identity.containerId).catch(e => {
        console.warn(`[runtime-box-reconcile] failed to remove stale container ${containerRef}:`, (e as Error).message);
      });
      await execute(
        `UPDATE project_runtime_boxes
           SET container_id = NULL, updated_at = now()
         WHERE id = $1`,
        [box.id],
      );
      changed += 1;
      console.log(`[runtime-box-reconcile] removed stale container for box ${box.id} (${containerRef})`);
    }
  }

  return changed;
}

// ── 유틸 ─────────────────────────────────────────────────────────────────

/** running box 목록 (idle stop cron 용). */
export async function listRunningBoxes(): Promise<BoxRow[]> {
  return queryBoxes(
    `SELECT * FROM project_runtime_boxes WHERE status IN ('running', 'starting')`,
  );
}

/** 상태가 될 때까지 폴링 대기. */
async function waitForStatus(boxId: number, target: BoxStatus, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const box = await queryBoxOne(
      'SELECT status FROM project_runtime_boxes WHERE id = $1',
      [boxId],
    );
    if (box?.status === target) return;
    await new Promise(r => setTimeout(r, 500));
  }
}

// ── Resource Budget Gate ──────────────────────────────────────────────────

/**
 * 현재 running 상태인 Box 수 반환.
 *
 * idle-stop-cron 및 budget gate 두 곳에서 사용.
 * status 'starting' 은 곧 running 이 될 것이므로 함께 집계.
 */
export async function countRunningBoxes(): Promise<number> {
  const rows = await query<{ cnt: string }>(
    `SELECT COUNT(*)::text AS cnt FROM project_runtime_boxes
     WHERE status IN ('running', 'starting')`,
  );
  return parseInt(rows[0]?.cnt ?? '0', 10);
}

/**
 * 특정 사용자가 생성한 running Box 수 반환 (created_by 기준).
 *
 * idle-stop-cron 및 per-user budget gate 에서 사용.
 */
export async function countRunningBoxesByUser(userId: number): Promise<number> {
  const rows = await query<{ cnt: string }>(
    `SELECT COUNT(*)::text AS cnt FROM project_runtime_boxes
     WHERE status IN ('running', 'starting') AND created_by = $1`,
    [userId],
  );
  return parseInt(rows[0]?.cnt ?? '0', 10);
}

/**
 * 전역 running box 수가 RUNTIME_BOX_MAX_RUNNING 을 초과하면 에러.
 * ensureRunning() 에서 Docker start 직전에 호출.
 */
export async function assertGlobalBoxBudget(): Promise<void> {
  const limit = getLiveRuntimeBoxCapacity().maxRunning;
  const current = await countRunningBoxes();
  if (current >= limit) {
    throw new RuntimeBoxError(
      `글로벌 Runtime Box 수 한도 초과: 현재 ${current}개 running (한도 ${limit}). ` +
      `다른 Box 가 idle-stop 될 때까지 기다리거나 RUNTIME_BOX_MAX_RUNNING 을 늘리세요.`,
    );
  }
}

/**
 * 특정 사용자의 running box 수가 RUNTIME_BOX_MAX_RUNNING_PER_USER 를 초과하면 에러.
 * ensureRunning() 에서 Docker start 직전에 호출.
 */
export async function assertUserBoxBudget(userId: number, targetBoxId = -1): Promise<void> {
  const limit = getLiveRuntimeBoxCapacity().maxRunningPerUser;
  const current = await countRunningBoxesByUser(userId);
  if (current >= limit) {
    const occupancy = await listUserRuntimeBoxOccupancy(userId, targetBoxId);
    throw new RuntimeBoxError(formatUserRuntimeBoxBudgetError({ current, limit, occupancy }));
  }
}

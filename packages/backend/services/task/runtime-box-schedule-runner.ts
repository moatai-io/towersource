/**
 * Owns: wake-and-run bridge from scheduled jobs to Project Runtime Box.
 * Public API: runCommandInRuntimeBox(). See services/task/README.md.
 *
 * Invariant: Runtime Box is not a scheduler. Never register crontab/systemd/
 * node-cron inside the box. Tower unified-scheduler owns due-job observation;
 * Runtime Box is woken only to execute one command/script and return result.
 */
import path from 'node:path';
import { config } from '../../config.js';
import { getProject } from '../pm/project-manager.js';
import { isProjectExcluded, isRuntimeBoxEnabled } from '../runtime-box/policy.js';
import {
  BOX_WORKDIR,
  RuntimeBoxError,
  execInBox,
  getBoxByProject,
  getOrCreateBox,
} from '../runtime-box/runtime-box-manager.js';
import type { BoxStatus } from '../runtime-box/types.js';
import type { ScheduleRunnerPolicy } from './runner-policy.js';

export interface RuntimeBoxCommandRequest {
  projectId: string;
  userId: number;
  boxSelector?: string;
  command: string;
  cwd?: string;
  timeoutSeconds: number;
  policy: ScheduleRunnerPolicy;
}

export interface RuntimeBoxCommandResult {
  status: 'success' | 'failed' | 'timeout';
  stdoutText: string | null;
  stderrText: string | null;
  exitCode: number | null;
  runnerRef: string | null;
  error: string | null;
}

const MAX_RUNTIME_BOX_CONCURRENT = 10;
const PROJECT_RUNTIME_BOX_CONCURRENCY = 1;

let globalRunning = 0;
const globalQueue: Array<() => void> = [];
const projectRunning = new Map<string, number>();
const projectQueues = new Map<string, Array<() => void>>();

/** Execute one scheduled command inside the project's Runtime Box. */
export async function runCommandInRuntimeBox(req: RuntimeBoxCommandRequest): Promise<RuntimeBoxCommandResult> {
  if (!isRuntimeBoxEnabled()) {
    throw new RuntimeBoxError('Runtime Box is disabled; cannot run scheduled job with runtime_box runner');
  }
  if (req.boxSelector && req.boxSelector !== 'default') {
    throw new RuntimeBoxError(`Runtime Box selector not supported yet: ${req.boxSelector}`);
  }

  const project = await getProject(req.projectId);
  if (!project) throw new RuntimeBoxError(`project ${req.projectId} not found`);
  if (isProjectExcluded(req.projectId, project.name)) {
    throw new RuntimeBoxError(`project ${project.name} is excluded from Runtime Box`);
  }

  return withRuntimeBoxSlot(req.projectId, async () => {
    const existing = await getBoxByProject(req.projectId);
    if (req.policy.wakePolicy === 'only_if_running' && existing?.status !== 'running') {
      throw new RuntimeBoxError(`Runtime Box is not running (status=${existing?.status || 'missing'})`);
    }

    const box = await getOrCreateBox(req.projectId, req.userId);
    const cwd = toBoxCwd(req.cwd);
    const result = await execInBox({
      boxId: box.id,
      userId: req.userId,
      cmd: req.command,
      cwd,
      timeout_sec: req.timeoutSeconds,
    });

    return {
      status: result.timed_out ? 'timeout' : result.exit_code === 0 ? 'success' : 'failed',
      stdoutText: result.stdout || null,
      stderrText: result.stderr || null,
      exitCode: result.exit_code,
      runnerRef: String(box.id),
      error: result.exit_code === 0 && !result.timed_out ? null : `Runtime Box command exited with ${result.exit_code}`,
    };
  });
}

/** Convert project-relative cwd to Runtime Box absolute cwd. */
export function toBoxCwd(cwd?: string): string {
  if (!cwd || cwd === '.') return BOX_WORKDIR;
  if (cwd.startsWith(BOX_WORKDIR)) {
    const normalized = path.posix.normalize(cwd);
    if (normalized !== BOX_WORKDIR && !normalized.startsWith(BOX_WORKDIR + '/')) {
      throw new RuntimeBoxError(`cwd escapes Runtime Box workspace: ${cwd}`);
    }
    return normalized;
  }
  if (path.isAbsolute(cwd)) {
    throw new RuntimeBoxError(`Runtime Box scheduled job cwd must be project-relative or /workspace: ${cwd}`);
  }
  const normalized = path.posix.normalize(path.posix.join(BOX_WORKDIR, cwd));
  if (normalized !== BOX_WORKDIR && !normalized.startsWith(BOX_WORKDIR + '/')) {
    throw new RuntimeBoxError(`cwd escapes Runtime Box workspace: ${cwd}`);
  }
  return normalized;
}

export function getRuntimeBoxScheduleLimits() {
  return {
    maxRuntimeBoxConcurrent: MAX_RUNTIME_BOX_CONCURRENT,
    projectRuntimeBoxConcurrency: PROJECT_RUNTIME_BOX_CONCURRENCY,
    configuredMaxRunningBoxes: config.runtimeBox.maxRunning,
  };
}

async function withRuntimeBoxSlot<T>(projectId: string, fn: () => Promise<T>): Promise<T> {
  await acquireGlobalSlot();
  await acquireProjectSlot(projectId);
  try {
    return await fn();
  } finally {
    releaseProjectSlot(projectId);
    releaseGlobalSlot();
  }
}

async function acquireGlobalSlot(): Promise<void> {
  if (globalRunning < MAX_RUNTIME_BOX_CONCURRENT) {
    globalRunning++;
    return;
  }
  await new Promise<void>((resolve) => globalQueue.push(resolve));
  globalRunning++;
}

function releaseGlobalSlot(): void {
  globalRunning = Math.max(0, globalRunning - 1);
  const next = globalQueue.shift();
  if (next) next();
}

async function acquireProjectSlot(projectId: string): Promise<void> {
  const running = projectRunning.get(projectId) || 0;
  if (running < PROJECT_RUNTIME_BOX_CONCURRENCY) {
    projectRunning.set(projectId, running + 1);
    return;
  }
  const queue = projectQueues.get(projectId) || [];
  projectQueues.set(projectId, queue);
  await new Promise<void>((resolve) => queue.push(resolve));
  projectRunning.set(projectId, (projectRunning.get(projectId) || 0) + 1);
}

function releaseProjectSlot(projectId: string): void {
  const running = Math.max(0, (projectRunning.get(projectId) || 0) - 1);
  if (running === 0) projectRunning.delete(projectId);
  else projectRunning.set(projectId, running);

  const queue = projectQueues.get(projectId);
  const next = queue?.shift();
  if (next) next();
  if (queue && queue.length === 0) projectQueues.delete(projectId);
}

export function describeBoxStatus(status?: BoxStatus | null): string {
  return status || 'missing';
}

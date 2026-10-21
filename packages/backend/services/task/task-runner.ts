/**
 * Task runner — `@task` / scheduled 백그라운드 자율 실행.
 *
 * 🔀 AI 실행 경로 3종 중 하나 (Task). 다른 둘:
 *   - Session    → packages/backend/engines/*-engine.ts:run() via getEngine()
 *   - Channel AI → packages/backend/engines/*-engine.ts:channelReply()
 * 셋 비교표 + 드리프트 핫스팟 + PR 체크리스트:
 *   docs/tower-guide/ai-execution-paths.md
 * mode='task'·rulesPreamble·report-policy 가 이 경로의 특징.
 * 옵션/가드 변경 시 비교표 §1 매트릭스를 함께 갱신.
 *
 * Engine routing (added 2026-05-17, W2): task.engine ('claude'|'pi'|'local')
 * picks the Engine implementation via getEngine(). Previously this file was
 * Claude-only via executeQuery() — the UI engine selector was silently inert.
 * See: workspace/decisions/2026-05-17-pi-claude-parity-roadmap.md
 */
import { getEngine } from '../../engines/index.js';
import type { EngineCallbacks, RunOpts, SavedMessage } from '../../engines/types.js';
import { claimEngineSessionId, createSession, getEngineSessionId, updateSession, getSession } from '../session/session-manager.js';
import { updateTask, getTask, getTasks, type WorkflowMode } from './task-manager.js';
import type { TaskMeta, TaskReportPolicy } from '@tower/shared';
import { saveMessage, attachToolResultInDb, updateMessageContent as updateMessageContentDb, updateMessageMetrics as updateMessageMetricsDb, markAgentTurnCheckpoint } from '../message-store.js';
import { type TowerRole } from '../damage-control.js';
import { buildSystemPrompt } from '../system-prompt.js';
import { recordPiUsageEvent } from '../ai-usage/usage-ledger.js';
import { isModelPolicyId } from '../ai/litellm-model-catalog.js';
import { selectSystemPromptFragmentsForMessage } from '../system-prompt-fragments.js';
import { getUserAccessiblePaths, buildToolGuard, resolveSessionProjectRoot } from '../pm/project-access.js';
import { getUserRole, getUserAllowedPath } from '../auth/auth.js';
import { queryOne } from '../../db/pg-repo.js';
import { buildUnattendedPrompt } from '../workflow-prompts.js';
import { backgroundTimeoutMessage, createSessionAskUser } from '../session/pending-questions.js';
import { v4 as uuidv4 } from 'uuid';
import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { buildJsonlPath, checkJsonlForCompletion } from '../workspace/jsonl-utils.js';
import { config as towerConfig, getModelDefaults, resolveLegacyPiModelId } from '../../config.js';

const MAX_CONCURRENT_TASKS = 30;
// engineName tracked so abortTask() can dispatch to the right Engine.abort().
// Pre-2026-05-17 this map had no engine — abort assumed Claude. After the
// Pi-engine task path was added, abort must know which engine owns the run.
const runningTasks = new Map<string, { sessionId: string; engineName: 'claude' | 'pi' | 'local'; aborted: boolean }>();
const MONITOR_POLL_INTERVAL = 3000;
const MONITOR_TIMEOUT = 60 * 60 * 1000; // 60 minutes

/**
 * Task-agent guardrails — prepended to every task's user prompt so they are
 * visible in the session UI / .jsonl and live in exactly one place (NOT split
 * between system prompt and user prompt). See
 * workspace/decisions/2026-04-20-task-agent-guardrails.md (2026-04-21 update).
 *
 * Only unattended-execution constraints belong here. Domain-specific workflow
 * and approval policy remain owned by the shared system prompt and project.
 */
function buildTaskAgentRulesPreamble(): string {
  return [
    '# Unattended task execution',
    '',
    'Follow the same project instructions, service-specific skills, credential handling, and output contracts as an interactive conversation.',
    'Execute the requested work, not an assumed software development workflow. Read relevant project context before acting; do not require architecture review, decision records, or Git commits for ordinary business tasks.',
    'Make small reversible assumptions when safe. If essential input or explicit approval is missing, report the concrete blocker and finish independent authorized work. Unattended execution does not grant additional authority.',
    'Do not claim success without verification. Distinguish completed work, unverified results, and blocked work in the final report.',
    '',
  ].join('\n');
}

interface MonitoredTask {
  taskId: string;
  sessionId: string;
  engineSessionId: string;
  jsonlPath: string;
  startTime: number;
  progressStages: string[];
  timer: ReturnType<typeof setInterval>;
  userId?: number;
  title: string;
}

// 외부 메시징(Telegram/Kakao) push 는 #58 Phase 2 에서 제거됨.
// 태스크 완료/실패 알림은 in-app notification + channel post 로만 전달.

/**
 * Decide what each policy value fans out to.
 * `default` preserves pre-2026-04-22 behaviour so old rows keep their
 * existing notification flow even after the migration.
 *
 * See: workspace/decisions/2026-04-22-task-report-policy.md
 */
interface DispatchReportInput {
  task: TaskMeta;
  status: 'done' | 'failed';
  summaryText: string;
  /** Optional error string used when no rich summary is available. */
  fallbackError?: string;
}

/**
 * Single dispatch point for task completion notifications.
 * Replaces the three copy-pasted branches that existed before 2026-04-22:
 *   1. monitor recovery (done/failed)
 *   2. normal completion (done/failed)
 *   3. exception catch (failed)
 *
 * Callers assemble `summaryText` themselves (each site has slightly
 * different context available — progressStages, completionSummary,
 * lastSummary, err.message — so we keep the formatting local).
 */
async function dispatchReport(input: DispatchReportInput): Promise<void> {
  const { task, status, summaryText } = input;

  try {
    if (task.status === 'done' && task.progressSummary?.some(line => line.startsWith('[TASK NONE]'))) return;
    const { notifyExecutionReport } = await import('../notification-hub.js');
    const { severityFromReportPolicy, routeSeverity } = await import('../tower/severity-router.js');
    const baseSeverity = severityFromReportPolicy(task.reportPolicy);
    const severity = status === 'failed' && baseSeverity === 'L2' ? 'L3' : baseSeverity;
    if (!routeSeverity(severity).notifyInApp || !task.userId) return;

    await notifyExecutionReport({
      userId: task.userId,
      kind: 'task',
      sourceId: task.id,
      name: task.title,
      status: status === 'done' ? 'completed' : 'failed',
      body: status === 'failed' && input.fallbackError
        ? `${input.fallbackError}\n\n${summaryText}`
        : summaryText,
      projectId: task.projectId ?? null,
      sessionId: task.sessionId ?? null,
      actionUrl: task.sessionId ? `/s/${task.sessionId}` : '/work',
      metadata: {
        taskId: task.id,
        reportPolicy: task.reportPolicy,
        legacySourceRoomId: task.roomId ?? null,
      },
    });
  } catch (err: any) {
    console.warn(
      `[task-runner] Notification report failed (non-fatal) for task ${task.id.slice(0, 8)}:`,
      err.message,
    );
  }
}

const monitoredTasks = new Map<string, MonitoredTask>();

type BroadcastFn = (type: string, data: any) => void;

function normalizeTaskRole(role: string | null | undefined): TowerRole {
  return (role || 'member') as TowerRole;
}

/**
 * Resolve the authority context that a background task should actually run as.
 *
 * Scheduled/automation paths usually only have `tasks.user_id`; passing no role
 * used to make task agents fall back to `member`, so admin-created schedules in
 * the Tower repo were blocked even though their run-as user was admin. Manual WS
 * starts can still pass the live actor role, but background starts must derive it
 * from the persisted run-as user.
 */
async function resolveTaskRunAuthority(userId?: number, requestedRole?: string): Promise<{ userId?: number; role: TowerRole }> {
  if (requestedRole) return { userId, role: normalizeTaskRole(requestedRole) };
  if (!userId) return { userId, role: 'member' };
  const dbRole = await getUserRole(userId);
  return { userId, role: normalizeTaskRole(dbRole) };
}

// --- Helpers for engine-specific restart recovery ---

/** Check if orphan Claude CLI processes exist. Pi runs in-process and is recovered through session auto-resume. */
function hasOrphanClaudeProcesses(): boolean {
  try {
    const result = execSync(
      `ps -eo pid,ppid,tty,args | awk '$2==1 && $3=="?" && /claude.*(--dangerously-skip-permissions|--permission-mode)/ {print $1}'`,
      { encoding: 'utf8', timeout: 3000 }
    ).trim();
    return result.length > 0;
  } catch {
    return false;
  }
}

function appendProgress(progress: string[], ...stages: string[]): string[] {
  const next = [...progress];
  for (const stage of stages) {
    if (!next.includes(stage)) next.push(stage);
  }
  return next;
}

async function recoverPiTask(task: TaskMeta, engineSessionId: string): Promise<void> {
  const progress = appendProgress(
    task.progressSummary,
    `Server restarted — Pi session delegated to session auto-resume: ${engineSessionId}`,
  );
  await updateTask(task.id, { progressSummary: progress });
  console.log(`[task-runner] Task "${task.title}" (${task.id.slice(0, 8)}) → delegated to Pi session auto-resume`);
}

async function recoverClaudeTask(task: TaskMeta, engineSessionId: string, sessionCfgDir: string | undefined, orphanClaudeProcessesExist: boolean): Promise<string | null> {
  // Try worktree path first, then original cwd.
  const cwdForJsonl = task.worktreePath && fs.existsSync(task.worktreePath) ? task.worktreePath : task.cwd;
  let jsonlPath = buildJsonlPath(cwdForJsonl, engineSessionId, sessionCfgDir);

  // Fallback: if not found at worktree path, try original cwd
  if (!fs.existsSync(jsonlPath) && cwdForJsonl !== task.cwd) {
    jsonlPath = buildJsonlPath(task.cwd, engineSessionId, sessionCfgDir);
  }

  if (!fs.existsSync(jsonlPath)) {
    await updateTask(task.id, {
      status: 'failed',
      progressSummary: appendProgress(task.progressSummary, 'Server restarted — Claude session file not found'),
    });
    console.log(`[task-runner] Task "${task.title}" (${task.id.slice(0, 8)}) → failed (no Claude .jsonl)`);
    return null;
  }

  const result = checkJsonlForCompletion(jsonlPath);

  if (result.status === 'complete') {
    const finalSummary = appendProgress(task.progressSummary, ...result.stages, 'Completed successfully');
    await updateTask(task.id, {
      status: 'done',
      progressSummary: finalSummary,
      completedAt: new Date().toISOString(),
    });
    console.log(`[task-runner] Recovered task "${task.title}" (${task.id.slice(0, 8)}) → done`);
    return null;
  }

  if (result.status === 'failed') {
    const finalSummary = appendProgress(task.progressSummary, ...result.stages, `Failed: ${result.reason}`);
    await updateTask(task.id, {
      status: 'failed',
      progressSummary: finalSummary,
    });
    console.log(`[task-runner] Recovered task "${task.title}" (${task.id.slice(0, 8)}) → failed: ${result.reason}`);
    return null;
  }

  if (orphanClaudeProcessesExist) {
    // Orphan process alive → task probably still running → monitor.
    return jsonlPath;
  }

  // No orphan processes → task crashed
  const finalSummary = appendProgress(task.progressSummary, ...result.stages, 'Server restarted — Claude process not found');
  await updateTask(task.id, {
    status: 'failed',
    progressSummary: finalSummary,
  });
  console.log(`[task-runner] Task "${task.title}" (${task.id.slice(0, 8)}) → failed (no Claude orphan process)`);
  return null;
}

// --- Recovery & Monitoring ---

/**
 * Smart recovery: check .jsonl files for in-progress tasks instead of
 * blindly marking them all as failed. Returns task IDs still running.
 */
async function recoverZombieTasks(): Promise<string[]> {
  const stillRunning: string[] = [];
  try {
    const allTasks = await getTasks();
    const zombies = allTasks.filter(t => t.status === 'in_progress');
    if (zombies.length === 0) return stillRunning;

    const orphanClaudeProcessesExist = hasOrphanClaudeProcesses();
    console.log(`[task-runner] Recovery: ${zombies.length} in_progress task(s), orphanClaudeProcesses=${orphanClaudeProcessesExist}`);

    for (const task of zombies) {
      const session = task.sessionId ? await getSession(task.sessionId) : null;
      const engineSessionId = getEngineSessionId(session);
      const sessionCfgDir = session?.configDir ?? undefined;

      if (!task.sessionId || !session || !engineSessionId) {
        await updateTask(task.id, {
          status: 'failed',
          progressSummary: appendProgress(task.progressSummary, `Server restarted — no ${task.engine} session to recover`),
        });
        console.log(`[task-runner] Task "${task.title}" (${task.id.slice(0, 8)}) → failed (no ${task.engine} engine session)`);
        continue;
      }

      if (task.engine === 'pi') {
        // Pi runs in-process. The canonical continuation is session-level
        // auto-resume from interrupted-pi-sessions / DB checkpoint, not Claude
        // CLI orphan detection or .jsonl polling. Leave the task in progress and
        // let serverSideResumeInterrupted() drive the backing session to done.
        // Do not add this to runningTasks: the Pi engine's session-level running
        // set is the source of truth after restart, and abort should target the
        // session engine rather than this stale task-local map entry.
        await recoverPiTask(task, engineSessionId);
        continue;
      }

      if (task.engine !== 'claude') {
        await updateTask(task.id, {
          status: 'failed',
          progressSummary: appendProgress(task.progressSummary, `Server restarted — ${task.engine} task recovery is not implemented`),
        });
        console.log(`[task-runner] Task "${task.title}" (${task.id.slice(0, 8)}) → failed (unsupported recovery engine=${task.engine})`);
        continue;
      }

      const jsonlPath = await recoverClaudeTask(task, engineSessionId, sessionCfgDir, orphanClaudeProcessesExist);
      if (jsonlPath) {
        stillRunning.push(task.id);
        runningTasks.set(task.id, { sessionId: task.sessionId, engineName: 'claude', aborted: false });
        console.log(`[task-runner] Task "${task.title}" (${task.id.slice(0, 8)}) → still running, will monitor`);
      }
    }

    console.log(`[task-runner] Recovery complete: ${stillRunning.length} Claude task(s) still running, ${zombies.length - stillRunning.length} resolved or delegated`);
  } catch (err: any) {
    console.error('[task-runner] Failed to recover zombie tasks:', err.message);
  }
  return stillRunning;
}

/**
 * Start monitoring .jsonl files for tasks that survived a backend restart.
 * Call from index.ts after WebSocket is ready.
 */
export async function resumeOrphanedTaskMonitoring(broadcastFn: BroadcastFn): Promise<void> {
  const stillRunning = await recoverZombieTasks();

  if (stillRunning.length === 0) {
    console.log('[task-runner] No orphaned tasks to monitor');
    return;
  }

  for (const taskId of stillRunning) {
    const task = await getTask(taskId);
    if (!task || !task.sessionId) continue;

    const session = await getSession(task.sessionId);
    const engineSessionId = getEngineSessionId(session);
    if (task.engine !== 'claude' || !engineSessionId) continue;

    // Forward session.configDir so we monitor the correct account's jsonl
    // (gmail-account project sessions write to ~/.claude-gmail/, not the
    // default ~/.claude/). See migration 053 / configdir audit decision.
    const jsonlPath = buildJsonlPath(task.cwd, engineSessionId, session?.configDir ?? undefined);
    if (!fs.existsSync(jsonlPath)) continue;

    const progressStages = [...task.progressSummary];
    const startTime = Date.now();

    const timer = setInterval(async () => {
      const monitored = monitoredTasks.get(taskId);
      if (!monitored) return;

      // Timeout check
      if (Date.now() - monitored.startTime > MONITOR_TIMEOUT) {
        clearInterval(monitored.timer);
        monitoredTasks.delete(taskId);
        runningTasks.delete(taskId);

        const finalSummary = [...monitored.progressStages, 'Timed out after 60 minutes'];
        await updateTask(taskId, { status: 'failed', progressSummary: finalSummary });
        broadcastFn('task_update', { taskId, status: 'failed', progressSummary: finalSummary });
        broadcastFn('session_status', { sessionId: monitored.sessionId, status: 'idle' });
        console.log(`[task-runner] Monitored task ${taskId.slice(0, 8)} timed out`);
        return;
      }

      // Check .jsonl for updates
      const result = checkJsonlForCompletion(monitored.jsonlPath);

      // Update stages
      for (const stage of result.stages) {
        if (!monitored.progressStages.includes(stage)) {
          monitored.progressStages.push(stage);
          await updateTask(taskId, { progressSummary: monitored.progressStages });
          broadcastFn('task_update', { taskId, status: 'in_progress', progressSummary: monitored.progressStages });
        }
      }

      if (result.status === 'complete') {
        clearInterval(monitored.timer);
        monitoredTasks.delete(taskId);
        runningTasks.delete(taskId);

        const finalSummary = [...monitored.progressStages, result.noWork ? '[TASK NONE]' : 'Completed successfully'];
        await updateTask(taskId, { status: 'done', progressSummary: finalSummary, completedAt: new Date().toISOString() });
        broadcastFn('task_update', { taskId, status: 'done', sessionId: monitored.sessionId, progressSummary: finalSummary });
        broadcastFn('session_status', { sessionId: monitored.sessionId, status: 'idle' });
        console.log(`[task-runner] Monitored task ${taskId.slice(0, 8)} → done`);

        const refreshed = await getTask(taskId);
        if (refreshed) {
          await dispatchReport({
            task: refreshed,
            status: 'done',
            summaryText: `📋 태스크: ${monitored.title}\n📊 상태: ✅ 완료 (서버 재시작 복구)`,
          });
        }
      } else if (result.status === 'failed') {
        clearInterval(monitored.timer);
        monitoredTasks.delete(taskId);
        runningTasks.delete(taskId);

        const finalSummary = [...monitored.progressStages, `Failed: ${result.reason}`];
        await updateTask(taskId, { status: 'failed', progressSummary: finalSummary });
        broadcastFn('task_update', { taskId, status: 'failed', sessionId: monitored.sessionId, progressSummary: finalSummary });
        broadcastFn('session_status', { sessionId: monitored.sessionId, status: 'idle' });
        console.log(`[task-runner] Monitored task ${taskId.slice(0, 8)} → failed: ${result.reason}`);

        const refreshed = await getTask(taskId);
        if (refreshed) {
          await dispatchReport({
            task: refreshed,
            status: 'failed',
            summaryText: `📋 태스크: ${monitored.title}\n📊 상태: ❌ 실패\n\n오류: ${result.reason}`,
          });
        }
      }
    }, MONITOR_POLL_INTERVAL);

    monitoredTasks.set(taskId, {
      taskId,
      sessionId: task.sessionId!,
      engineSessionId,
      jsonlPath,
      startTime,
      progressStages,
      timer,
      userId: task.userId ?? undefined,
      title: task.title,
    });

    console.log(`[task-runner] Monitoring orphaned task "${task.title}" (${taskId.slice(0, 8)}) via ${path.basename(jsonlPath)}`);
  }

  // Broadcast current state to connected clients
  for (const taskId of stillRunning) {
    const task = await getTask(taskId);
    if (task) {
      broadcastFn('task_update', {
        taskId,
        status: 'in_progress',
        sessionId: task.sessionId,
        progressSummary: task.progressSummary,
      });
    }
  }
}

/** Whether there are tasks being monitored after a restart */
export function hasMonitoredTasks(): boolean {
  return monitoredTasks.size > 0;
}

/**
 * Settle an in-progress task whose backing session was recovered by the
 * session-level auto-resume path. This is primarily for Pi tasks: there is no
 * orphan CLI process to monitor, so task status follows the recovered session's
 * terminal event instead of Claude jsonl polling.
 */
export async function settleRecoveredTaskSession(
  sessionId: string,
  status: 'done' | 'failed',
  broadcastFn: BroadcastFn,
  error?: string,
): Promise<void> {
  const tasks = await getTasks();
  const task = tasks.find((t) => t.sessionId === sessionId && t.status === 'in_progress');
  if (!task) return;

  const finalSummary = status === 'done'
    ? appendProgress(task.progressSummary, 'Completed successfully (session auto-resume)')
    : appendProgress(task.progressSummary, `Failed during session auto-resume: ${error || 'unknown error'}`);

  await updateTask(task.id, {
    status,
    progressSummary: finalSummary,
    completedAt: status === 'done' ? new Date().toISOString() : undefined,
  });
  runningTasks.delete(task.id);
  broadcastFn('task_update', {
    taskId: task.id,
    status,
    sessionId,
    progressSummary: finalSummary,
  });
  broadcastFn('session_status', { sessionId, status: 'idle' });

  const refreshed = await getTask(task.id);
  if (refreshed) {
    await dispatchReport({
      task: refreshed,
      status: status === 'done' ? 'done' : 'failed',
      summaryText: status === 'done'
        ? `📋 태스크: ${task.title}\n📊 상태: ✅ 완료 (세션 자동 복구)`
        : `📋 태스크: ${task.title}\n📊 상태: ❌ 실패\n\n오류: ${error || 'unknown error'}`,
      fallbackError: error,
    });
  }
}

/** Stop all monitor timers (for graceful shutdown) */
export function stopAllMonitors(): void {
  for (const m of monitoredTasks.values()) {
    clearInterval(m.timer);
  }
  monitoredTasks.clear();
}

export async function spawnTask(
  taskId: string,
  broadcastToAll: BroadcastFn,
  userId?: number,
  userRole?: string,
  allowedPath?: string,
  options: { waitForCompletion?: boolean } = {},
): Promise<void> {
  const task = await getTask(taskId);
  if (!task) throw new Error('Task not found');
  if (task.status !== 'todo' && task.status !== 'failed') throw new Error(`Task status is ${task.status}, expected todo or failed`);

  if (runningTasks.size >= MAX_CONCURRENT_TASKS) {
    throw new Error(`Max concurrent tasks (${MAX_CONCURRENT_TASKS}) reached`);
  }

  // If re-running a failed task, resume the previous Tower Session as well as
  // its native engine session. A Pi sessionFile is valid only together with the
  // immutable Harness snapshot pinned to that same Tower session id. Creating a
  // fresh row and attaching the old file would pair two different contracts and
  // fail strict resume (or, worse, silently change capability policy).
  let resumeEngineSessionId: string | undefined;
  let resumableTaskSession: Awaited<ReturnType<typeof getSession>> = null;
  if (task.status === 'failed' && task.sessionId) {
    const prevSession = await getSession(task.sessionId);
    const previousEngineSessionId = getEngineSessionId(prevSession);
    if (prevSession && prevSession.engine === task.engine && previousEngineSessionId) {
      resumeEngineSessionId = previousEngineSessionId;
      resumableTaskSession = prevSession;
      console.log(`[task-runner] Will resume task "${task.title}" in Tower session ${prevSession.id} with engineSessionId=${resumeEngineSessionId}`);
    }
  }

  // Prefer the task's explicit project_id (schedule/automation-created tasks often
  // carry it even when cwd is generic or legacy-restored). Fall back to cwd mapping
  // for older rows that predate project_id backfill.
  let taskProjectId: string | null = task.projectId || null;
  if (!taskProjectId) {
    try {
      const { findProjectByPath } = await import('../pm/project-access.js');
      taskProjectId = await findProjectByPath(task.cwd);
    } catch {}
  }
  const session = resumableTaskSession || await createSession(
    `[task] ${task.title}`,
    task.cwd,
    userId,
    taskProjectId,
    task.engine,
    undefined,
    undefined,
    undefined,
    'task',
    task.model,
  );
  const sessionId = session.id;

  await updateTask(taskId, {
    status: 'in_progress',
    sessionId,
    progressSummary: resumeEngineSessionId ? ['Resuming task...'] : ['Starting task...'],
  });

  runningTasks.set(taskId, { sessionId, engineName: task.engine, aborted: false });

  broadcastToAll('task_update', {
    taskId,
    id: taskId,
    title: task.title,
    description: task.description,
    cwd: task.cwd,
    engine: task.engine,
    model: task.model,
    status: 'in_progress',
    sessionId,
    projectId: taskProjectId,
    progressSummary: resumeEngineSessionId ? ['Resuming task...'] : ['Starting task...'],
    // Include full session data so frontend can add to session store immediately.
    // Project metadata is essential for scheduled/background sessions to land in
    // the correct sidebar group instead of the temporary/uncategorized bucket.
    session: {
      id: session.id,
      shortCode: session.shortCode,
      name: session.name,
      cwd: session.cwd,
      tags: session.tags,
      favorite: session.favorite,
      totalCost: session.totalCost,
      totalTokens: session.totalTokens,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
      projectId: session.projectId,
      engine: session.engine,
      roomId: session.roomId,
      parentSessionId: session.parentSessionId,
      sourceMessageId: session.sourceMessageId,
      ownerUsername: session.ownerUsername,
      visibility: session.visibility,
      label: session.label,
      configDir: session.configDir,
      modelUsed: session.modelUsed,
    },
  });

  const authority = await resolveTaskRunAuthority(userId, userRole);
  const effectiveAllowedPath = allowedPath ?? (authority.userId
    ? await getUserAllowedPath(authority.userId)
    : undefined);

  // Compute project-based accessible paths for this run-as user. Background
  // schedules derive the role from users.role instead of silently becoming member.
  let accessiblePaths: string[] | null | undefined;
  if (authority.userId) {
    accessiblePaths = await getUserAccessiblePaths(authority.userId, authority.role);
  }

  const completion = runTaskAgent(taskId, sessionId, task.title, task.description, task.cwd, broadcastToAll, authority.role, effectiveAllowedPath, resumeEngineSessionId, task.progressSummary, task.engine, task.model, task.workflow, accessiblePaths, taskProjectId, authority.userId);
  // UI/manual callers keep fire-and-forget semantics; schedules explicitly await
  // the real runner, including persisted terminal status and report dispatch.
  if (options.waitForCompletion) {
    await completion;
  } else {
    void completion.catch((err) => {
      console.error(`[task-runner] Task ${taskId} error:`, err.message);
    });
  }
}

async function runTaskAgent(
  taskId: string,
  sessionId: string,
  title: string,
  description: string,
  cwd: string,
  broadcastToAll: BroadcastFn,
  userRole?: string,
  allowedPath?: string,
  resumeEngineSessionId?: string,
  previousProgress?: string[],
  engineName: 'claude' | 'pi' | 'local' = (towerConfig.defaultEngine as 'claude' | 'pi' | 'local') || 'pi',
  model?: string,
  workflow?: WorkflowMode,
  accessiblePaths?: string[] | null,
  projectId?: string | null,
  runAsUserId?: number,
): Promise<void> {

  // New task runs always use the canonical project cwd. Existing tasks may resume
  // from a legacy worktree until those historical runs are retired, but workflow
  // classification must never create another worktree.
  let agentCwd = cwd;
  if (resumeEngineSessionId) {
    const existingTask = await getTask(taskId);
    if (existingTask?.worktreePath && fs.existsSync(existingTask.worktreePath)) {
      agentCwd = existingTask.worktreePath;
    }
  }

  const effectiveRole = normalizeTaskRole(userRole);

  // User prompt = [rules preamble] + [unattended task prompt].
  // Rules live here (not in system prompt) so they are visible in the session
  // UI / .jsonl and debuggable in exactly one place.
  const rulesPreamble = buildTaskAgentRulesPreamble();
  const taskBody = buildUnattendedPrompt(title, description, {
    isResume: !!resumeEngineSessionId, previousProgress,
  });
  const prompt = `${rulesPreamble}${taskBody}`;
  // Select on the actual request, not orchestration boilerplate. Both engines
  // must receive the same optional guidance as interactive user turns.
  const systemPromptFragments = selectSystemPromptFragmentsForMessage(`${title}\n${description}`);

  // Inform user about actual working directory
  const workingDirInfo = agentCwd !== cwd
    ? `Working in isolated directory: ${agentCwd} (isolated from ${cwd})`
    : `Working in directory: ${agentCwd}`;

  const progressStages: string[] = [
    resumeEngineSessionId ? 'Resuming task...' : 'Starting task...',
    `Run authority: userId=${runAsUserId ?? 'system'}, role=${effectiveRole}${projectId ? `, projectId=${projectId}` : ''}`,
    workingDirInfo,
  ];

  // Update task with working directory info
  await updateTask(taskId, { progressSummary: progressStages });
  broadcastToAll('task_update', {
    taskId,
    status: 'in_progress',
    progressSummary: progressStages,
  });

  let engineSessionId: string | undefined;
  let turnCount = 0;
  let lastSummary = '';
  let completionSummary = ''; // Richer summary for room reporting
  let sawTaskComplete = false;
  let sawTaskFailed = false;

  // Save user prompt to DB so it's visible when viewing the session and use the
  // same durable identity for any Pi continuation of this task turn.
  const rootTurnId = uuidv4();
  await saveMessage(sessionId, {
    id: rootTurnId,
    role: 'user',
    content: JSON.stringify([{ type: 'text', text: prompt }]),
  });
  if (engineName === 'pi') {
    await markAgentTurnCheckpoint(rootTurnId, {
      status: 'started',
      sessionId,
      rootTurnId,
      engine: engineName,
      model: model || null,
    });
  }

  try {
    // Notify all clients that this session is streaming (for sidebar indicators)
    broadcastToAll('session_status', { sessionId, status: 'streaming' });

    const sessionProjectRoot = resolveSessionProjectRoot(agentCwd)
      ?? (projectId
        ? (await queryOne<{ root_path: string | null }>('SELECT root_path FROM projects WHERE id = $1', [projectId]))?.root_path ?? undefined
        : undefined);
    const guard = buildToolGuard({
      role: effectiveRole,
      allowedPath,
      accessiblePaths,
      sessionProjectRoot,
    });
    if (sessionProjectRoot) {
      console.log(`[task-runner] Session write guard active for task ${taskId}: ${sessionProjectRoot}`);
    }
    const taskCanUseTool = async (toolName: string, input: Record<string, unknown>, _options: { signal: AbortSignal }) => {
      // Unified guard: damage control + session write guard + path enforcement + project ACL + TeamCreate block
      const check = guard(toolName, input);
      if (!check.allowed) {
        return { behavior: 'deny' as const, message: check.message };
      }
      // Task-specific: block EnterWorktree (worktree is managed by task-runner)
      if (toolName === 'EnterWorktree') {
        return { behavior: 'deny' as const, message: 'Worktree is managed by the task runner. Use the current working directory.' };
      }
      return { behavior: 'allow' as const, updatedInput: input };
    };
    const taskPermission = (effectiveRole === 'admin' || effectiveRole === 'operator')
      ? 'bypassPermissions' as const
      : 'acceptEdits' as const;

    // Build stable system prompt for task agent (Layer 2).
    // mode: 'task' drops the heavy visualization guide (~7KB) and collaboration
    // section — tasks rarely render charts/infographics and there's no human to
    // explain things to mid-turn. A minimal result-summary hint replaces them.
    //
    // Unattended-execution guardrails (scope, blockers, verification)
    // are prepended to the USER prompt above, not here — single source of truth.
    const runUser = runAsUserId
      ? await queryOne<{ username: string }>('SELECT username FROM users WHERE id = $1', [runAsUserId])
      : null;
    const username = runUser?.username || 'task-agent';
    const baseSystemPrompt = await buildSystemPrompt({
      username,
      role: effectiveRole,
      allowedPath,
      sessionProjectRoot,
      mode: 'task',
      optionalFragments: systemPromptFragments,
    });

    // The retired PM/Ideas feed is no longer injected into task agents.
    // Task context comes from the task prompt itself plus room context below.
    const systemPrompt = baseSystemPrompt;

    // Room context is dynamic and should live in the user prompt prefix,
    // not in the system prompt, to preserve prompt-prefix caching.
    let contextualPrompt = prompt;

    const currentTask = await getTask(taskId);
    if (currentTask?.roomId) {
      try {
        const { getMessages: getRoomMessages, getAiContexts, getRoom: fetchRoom } = await import('../room/room-manager.js');
        const { assembleRoomBackgroundContext } = await import('../room/room-context.js');

        const room = await fetchRoom(currentTask.roomId);
        const recentMsgs = await getRoomMessages(currentTask.roomId, { limit: 20 });
        const aiContexts = await getAiContexts(currentTask.roomId, 5);

        const config = {
          maxTier1Count: 5,
          maxTier1Tokens: 500,
          maxTier2Tokens: 2000,
          maxRecentMessages: 20,
          maxTotalTokens: 3000,
        };

        const aiEntries = aiContexts.map(ctx => ({
          taskId: ctx.sourceTaskId || 'unknown',
          question: '',
          answerSummary: ctx.content,
          tokenCount: ctx.tokenCount,
          createdAt: ctx.createdAt,
          expiresAt: ctx.expiresAt ?? undefined,
        }));

        const recentForContext = recentMsgs
          .filter(m => m.msgType === 'human' || m.msgType === 'ai_summary')
          .map(m => ({
            sender: m.senderName || 'system',
            content: m.content,
            timestamp: m.createdAt,
          }));

        const roomContext = assembleRoomBackgroundContext({
          roomName: room?.name || 'Unknown Room',
          roomDescription: room?.description || '',
          aiContextEntries: aiEntries,
          recentMessages: recentForContext,
          userPrompt: description,
          config,
        });

        if (roomContext) {
          // Keep rules preamble at the very top so Claude reads them before
          // room background or the task body.
          contextualPrompt = `${rulesPreamble}${roomContext}\n\n[현재 요청]\n${taskBody}`;
        }
        console.log(`[task-runner] Room context moved to prompt prefix for task "${title}" (room: ${room?.name})`);
      } catch (err: any) {
        console.error(`[task-runner] Failed to build room context for task ${taskId.slice(0, 8)}:`, err.message);
      }
    }

    // PR-3 (2026-05-09) — forward the task session's pinned configDir so the
    // engine spawns with the right account credentials. For legacy Claude runs
    // this also controls jsonl location; Pi ignores Claude-only config-home
    // details and uses its own session file path. See
    // workspace/decisions/2026-05-09-multi-account-configdir-audit.md
    const taskSessionRow = await getSession(sessionId);
    const taskCfgDir = taskSessionRow?.configDir ?? null;

    // ── Engine routing (2026-05-17, W2) ──
    // Pick the Engine implementation by task.engine. Previously hard-coded to
    // executeQuery (Claude). Pi/Local now route through the same getEngine()
    // factory used by ws-handler and spawn-rpc.
    // The engine.run() interface yields TowerMessage (engine-agnostic) instead
    // of Claude's SDKMessage — fewer engine-specific fields are accessible
    // here, but the shape is richer (tool_result / engine_done / engine_error
    // are first-class types, not buried in user-message blocks).
    const engine = await getEngine(engineName);

    const callbacks: EngineCallbacks = {
      askUser: createSessionAskUser({
        sessionId,
        recipientUserId: runAsUserId ?? undefined,
        userMessageId: rootTurnId,
        logTag: 'task-runner',
        timeoutMessage: backgroundTimeoutMessage,
      }),
      claimSessionId: async (engSid: string) => {
        if (engSid && engSid !== engineSessionId) {
          engineSessionId = engSid;
          try {
            await claimEngineSessionId(sessionId, engineName, engSid);
          } catch {}
          broadcastToAll('session_meta_update', {
            sessionId,
            updates: engineName === 'pi'
              ? { engineSessionId: engSid, piSessionFile: engSid }
              : { engineSessionId: engSid, claudeSessionId: engSid },
          });
        }
      },
      saveMessage: async (msg: SavedMessage) => {
        await saveMessage(sessionId, {
          id: msg.id,
          role: msg.role,
          content: msg.content,
          parentToolUseId: msg.parentToolUseId,
        });
        if (msg.role === 'assistant') turnCount++;
      },
      updateMessageContent: async (msgId: string, content: any) => {
        try { await updateMessageContentDb(msgId, content); } catch {}
      },
      attachToolResult: async (toolUseId: string, result: string) => {
        try { attachToolResultInDb(sessionId, toolUseId, result); } catch {}
      },
      updateMessageMetrics: async (msgId: string, metrics: any) => {
        try {
          await updateMessageMetricsDb(msgId, {
            duration_ms: metrics.durationMs,
            input_tokens: metrics.inputTokens,
            output_tokens: metrics.outputTokens,
            cache_read_tokens: metrics.cacheReadTokens,
            cache_creation_tokens: metrics.cacheCreationTokens,
            reasoning_tokens: metrics.reasoningTokens,
            cache_creation_1h_tokens: metrics.cacheCreation1hTokens,
            cache_creation_5m_tokens: metrics.cacheCreation5mTokens,
            cost_usd: metrics.costUsd,
            context_input_tokens: metrics.contextInputTokens,
            context_window_size: metrics.contextWindowSize,
            context_estimated_tokens: metrics.contextEstimatedTokens,
          context_compacted: metrics.contextCompacted,
            next_request_estimated_tokens: metrics.nextRequestEstimatedTokens,
            compact_threshold_tokens: metrics.compactThresholdTokens,
          context_snapshot: metrics.contextSnapshot,
          });
        } catch {}
      },
    };

    // Engine-specific systemPrompt + configDir passthrough.
    // RunOpts does not yet have systemPrompt/permissionMode/canUseTool fields
    // (those are Claude-internal SDK options forwarded by ClaudeEngine.run via
    // an extended opts shape). We cast through any so both engines see them
    // when defined; PiEngine ignores Claude-only fields.
    const runOpts: RunOpts & Record<string, any> = {
      cwd: agentCwd,
      model: engineName === 'pi' ? resolveLegacyPiModelId(model || getModelDefaults().session) : model || 'claude-opus-4-8',
      accessiblePaths: accessiblePaths ?? null,
      sessionProjectRoot,
      projectId: projectId || undefined,
      userId: runAsUserId,
      username,
      allowedPath,
      userRole: effectiveRole,
      engineSessionId: resumeEngineSessionId || getEngineSessionId(taskSessionRow),
      rootTurnId,
      systemPromptFragments,
      // Claude-only extras — PiEngine ignores these.
      permissionMode: taskPermission,
      canUseTool: taskCanUseTool,
      systemPrompt,
      configDir: taskCfgDir ?? undefined,
    };

    for await (const towerMsg of engine.run(sessionId, contextualPrompt, runOpts, callbacks)) {
      const running = runningTasks.get(taskId);
      if (!running || running.aborted) break;

      if (towerMsg.type === 'turn_done' && engineName === 'pi') {
        await recordPiUsageEvent({
          sessionId,
          rootTurnId,
          messageId: towerMsg.msgId,
          usage: towerMsg.usage,
          requestedModel: runOpts.model,
          modelPolicyId: isModelPolicyId(runOpts.model) ? runOpts.model!.split('/')[1] : undefined,
        }).catch((error: any) => {
          console.warn(`[task-runner] AI usage ledger write failed: task=${taskId} error=${error?.message || error}`);
        });
      }

      // Engine session id is now delivered via claimSessionId callback above.
      // Assistant / user-message persistence is via the saveMessage callback.
      // What remains here: progress marker / TodoWrite / completion extraction
      // from assistant content blocks — same regex logic as before, ported to
      // TowerMessage.content (TowerContentBlock[] is shape-compatible with
      // Claude SDK assistant content for the fields we read: type, name, input
      // for tool_use; type, text for text).
      if (towerMsg.type === 'assistant') {
        const content = (towerMsg.content || []) as any[];

        // Extract TodoWrite snapshots from tool_use blocks
        for (const block of content) {
          const b = block as any;
          if (b.type === 'tool_use' && b.name === 'TodoWrite' && b.input?.todos) {
            const todos = (b.input.todos as Array<{ content: string; status: string }>)
              .map((t: any) => ({ content: t.content, status: t.status }));
            await updateTask(taskId, { todoSnapshot: todos as any });
            broadcastToAll('task_update', { taskId, todoSnapshot: todos });
          }
        }

        // Extract progress from user-visible prose blocks. Responses/Codex can
        // surface preambles and final markers as `commentary` after the
        // commentary-preservation split; task completion logic must inspect the
        // same visible assistant text that transcripts/chat show.
        const textBlocks = content.filter((b: any) =>
          b.type === 'text' || (b.type === 'commentary' && b.visibility === 'progress')
        );
        for (const block of textBlocks) {
          const text = (block as any).text || '';

          // Detect stage markers
          const stageMatch = text.match(/\[STAGE:\s*(.+?)\]/);
          if (stageMatch) {
            const stage = stageMatch[1];
            if (!progressStages.includes(stage)) {
              progressStages.push(stage);
              await updateTask(taskId, { progressSummary: progressStages });
              broadcastToAll('task_update', {
                taskId,
                status: 'in_progress',
                progressSummary: progressStages,
              });
            }
          }

          // Detect completion — capture the full text block as rich summary.
          // Keep an explicit boolean instead of inferring final status from the
          // human summary text: failure reasons are often localized and may not
          // contain the English token "FAILED".
          if (text.includes('[TASK NONE]')) {
            sawTaskComplete = true;
            lastSummary = '[TASK NONE]';
          }
          if (text.includes('[TASK COMPLETE]')) {
            sawTaskComplete = true;
            lastSummary = 'Completed successfully';
            // Extract everything after [TASK COMPLETE] marker as the summary
            const afterMarker = text.split('[TASK COMPLETE]').pop()?.trim();
            if (afterMarker && afterMarker.length > 5) {
              completionSummary = afterMarker.slice(0, 1000);
            }
          }

          // Detect failure. A failure marker wins over completion if both ever
          // appear in one run; unattended tasks must not look green after an
          // explicit TASK FAILED report.
          const failMatch = text.match(/\[TASK FAILED:\s*(.+?)\]/);
          if (failMatch) {
            sawTaskFailed = true;
            lastSummary = failMatch[1];
            completionSummary = text.trim().slice(0, 1000);
          }

          // Keep last meaningful text as summary
          if (text.trim().length > 10 && !text.startsWith('[')) {
            lastSummary = text.trim().slice(0, 200);
            // Also accumulate for richer room summary (keep latest substantial block)
            if (text.trim().length > 30) {
              completionSummary = text.trim().slice(0, 1000);
            }
          }
        }
      } else if (towerMsg.type === 'engine_error') {
        sawTaskFailed = true;
        lastSummary = towerMsg.message || 'Engine error';
        completionSummary = lastSummary;
      }

      // Broadcast TowerMessage to anyone viewing this session. Keeping the
      // 'task_sdk_message' channel name for frontend back-compat (subscribers
      // already exist) — payload key renamed to 'towerMessage' so engine-agnostic
      // consumers can branch on towerMsg.type without legacy SDKMessage parsing.
      broadcastToAll('task_sdk_message', {
        taskId,
        sessionId,
        towerMessage: towerMsg,
        // Legacy alias for any consumer still reading sdkMessage.
        sdkMessage: towerMsg,
      });
    }

    // Task completed
    const running = runningTasks.get(taskId);
    const wasAborted = running?.aborted;
    runningTasks.delete(taskId);

    if (wasAborted) {
      await updateTask(taskId, {
        status: 'todo',
        progressSummary: [...progressStages, 'Aborted by user'],
      });
      broadcastToAll('task_update', {
        taskId,
        id: taskId,
        title,
        status: 'todo',
        sessionId,
        projectId,
        progressSummary: [...progressStages, 'Aborted by user'],
      });
    } else {
      const missingTerminalMarker = !sawTaskComplete && !sawTaskFailed;
      const missingTerminalMarkerSummary = 'Task ended without required [TASK COMPLETE] or [TASK FAILED] marker';
      const finalStatus = sawTaskFailed || missingTerminalMarker ? 'failed' : 'done';
      const finalSummary = [
        ...progressStages,
        missingTerminalMarker
          ? (lastSummary ? `${missingTerminalMarkerSummary}: ${lastSummary}` : missingTerminalMarkerSummary)
          : (lastSummary || 'Completed successfully'),
      ];

      await updateTask(taskId, {
        status: finalStatus,
        progressSummary: finalSummary,
        completedAt: new Date().toISOString(),
      });

      if (engineSessionId) {
        await claimEngineSessionId(sessionId, engineName, engineSessionId);
      }
      await updateSession(sessionId, { turnCount });

      broadcastToAll('task_update', {
        taskId,
        id: taskId,
        title,
        status: finalStatus,
        sessionId,
        projectId,
        engineSessionId,
        claudeSessionId: engineName === 'claude' ? engineSessionId : undefined,
        progressSummary: finalSummary,
      });

      // ── Build rich summary and fan out per report_policy ──
      const completedTask = await getTask(taskId);
      if (completedTask) {
        const stagesReport = progressStages
          .filter(s => s !== 'Starting task...' && s !== 'Resuming task...')
          .map(s => `• ${s}`)
          .join('\n');

        const statusLine = finalStatus === 'done' ? '✅ 완료' : '❌ 실패';
        let summaryText: string;
        if (completionSummary) {
          summaryText = `📋 태스크: ${title}\n📊 상태: ${statusLine}\n\n${completionSummary}`;
          if (stagesReport) summaryText += `\n\n🔄 진행 단계:\n${stagesReport}`;
        } else if (lastSummary && lastSummary !== 'Completed successfully') {
          summaryText = `📋 태스크: ${title}\n📊 상태: ${statusLine}\n\n${lastSummary}`;
        } else {
          summaryText = `📋 태스크: ${title}\n📊 상태: ${statusLine}`;
          if (stagesReport) summaryText += `\n\n🔄 진행 단계:\n${stagesReport}`;
        }

        await dispatchReport({
          task: completedTask,
          status: finalStatus as 'done' | 'failed',
          summaryText,
        });
      }

    }

    // Notify viewers: session done streaming (clears isStreaming in chat + sidebar indicator)
    broadcastToAll('sdk_done', { sessionId, engineSessionId, claudeSessionId: engineName === 'claude' ? engineSessionId : undefined });
    broadcastToAll('session_status', { sessionId, status: 'idle' });
  } catch (err: any) {
    runningTasks.delete(taskId);
    const errorSummary = [...progressStages, `Error: ${err.message}`];

    await updateTask(taskId, {
      status: 'failed',
      progressSummary: errorSummary,
    });

    broadcastToAll('task_update', {
      taskId,
      id: taskId,
      title,
      status: 'failed',
      sessionId,
      projectId,
      progressSummary: errorSummary,
    });

    // Fan out per report_policy (includes Kakao for policies that want it)
    const failedTask = await getTask(taskId);
    if (failedTask) {
      await dispatchReport({
        task: failedTask,
        status: 'failed',
        summaryText: `📋 태스크: ${title}\n📊 상태: ❌ 실패\n\n오류: ${err.message}`,
      });
    }

    // Notify viewers: session done streaming (even on error)
    broadcastToAll('sdk_done', { sessionId, engineSessionId, claudeSessionId: engineName === 'claude' ? engineSessionId : undefined });
    broadcastToAll('session_status', { sessionId, status: 'idle' });
  }
}

export async function abortTask(taskId: string): Promise<boolean> {
  const running = runningTasks.get(taskId);
  if (!running) return false;
  running.aborted = true;

  // If it's a monitored orphan, clean up monitoring and mark as todo
  const monitored = monitoredTasks.get(taskId);
  if (monitored) {
    clearInterval(monitored.timer);
    monitoredTasks.delete(taskId);
    runningTasks.delete(taskId);
    await updateTask(taskId, {
      status: 'todo',
      progressSummary: [...monitored.progressStages, 'Aborted by user'],
    });
    return true;
  }

  // Normal running task — dispatch abort to the engine that owns the run.
  // Engine.abort() is the engine-agnostic equivalent of the old
  // abortSession() (which was Claude-specific). Each engine maintains its
  // own running-session set and no-ops if the id is unknown to it.
  try {
    const eng = await getEngine(running.engineName);
    eng.abort(running.sessionId);
  } catch (err: any) {
    console.error(`[task-runner] Failed to abort task ${taskId.slice(0, 8)} on engine ${running.engineName}:`, err?.message);
  }
  return true;
}

export function getRunningTaskCount(): number {
  return runningTasks.size;
}

export function isTaskRunning(taskId: string): boolean {
  return runningTasks.has(taskId);
}

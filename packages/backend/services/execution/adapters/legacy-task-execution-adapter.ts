import { isNoWorkTask } from '../../task/automation-outcome.js';
import type { TaskMeta, WorkflowMode } from '@tower/shared';
import { createTask, getTask } from '../../task/task-manager.js';
import { spawnTask } from '../../task/task-runner.js';
import type { BroadcastFn } from '../../task/automation-runners.js';
import type { ExecutionRecord } from '../execution-types.js';

export type ExecutionOutcome = 'succeeded' | 'failed' | 'cancelled' | 'timed_out' | 'uncertain';

export interface LegacyTaskExecutionRequest {
  execution: ExecutionRecord;
  title: string;
  prompt: string;
  cwd: string;
  userId: number;
  model: string;
  workflow?: WorkflowMode;
  broadcast: BroadcastFn;
}

export interface LegacyTaskExecutionReceipt {
  adapterKind: 'legacy_task';
  executorRef: string;
  taskId: string;
  sessionId: string | null;
  outcome: ExecutionOutcome;
  summaryText: string;
  resultJson: Record<string, unknown>;
  errorJson: Record<string, unknown> | null;
}

interface LegacyTaskAdapterDependencies {
  createTask: typeof createTask;
  spawnTask: typeof spawnTask;
  getTask: typeof getTask;
}

const defaultDependencies: LegacyTaskAdapterDependencies = { createTask, spawnTask, getTask };

function taskOutcome(task: TaskMeta | null): ExecutionOutcome {
  if (!task) return 'uncertain';
  if (task.status === 'done') return 'succeeded';
  if (task.status === 'failed') return 'failed';
  return 'uncertain';
}

export async function executeWithLegacyTaskAdapter(
  request: LegacyTaskExecutionRequest,
  dependencies: LegacyTaskAdapterDependencies = defaultDependencies,
): Promise<LegacyTaskExecutionReceipt> {
  const projectId = request.execution.scopeKind === 'project'
    ? request.execution.projectId
    : null;
  const task = await dependencies.createTask(
    request.title,
    request.prompt,
    request.cwd,
    request.userId,
    request.model,
    undefined,
    request.workflow || 'auto',
    undefined,
    projectId,
    undefined,
    'silent',
  );

  request.broadcast('task_created', { task });
  try {
    await dependencies.spawnTask(task.id, request.broadcast, request.userId, undefined, undefined, { waitForCompletion: true });
  } catch (error) {
    const persisted = await dependencies.getTask(task.id).catch(() => null);
    return {
      adapterKind: 'legacy_task',
      executorRef: `task:${task.id}`,
      taskId: task.id,
      sessionId: persisted?.sessionId || null,
      outcome: persisted?.status === 'failed' ? 'failed' : 'uncertain',
      summaryText: persisted?.progressSummary?.join('\n') || 'Legacy Task execution did not return a terminal receipt',
      resultJson: { taskId: task.id, taskStatus: persisted?.status || 'unknown', automationOutcome: isNoWorkTask(persisted) ? 'none' : undefined },
      errorJson: { message: error instanceof Error ? error.message : String(error), retryable: false },
    };
  }

  const persisted = await dependencies.getTask(task.id);
  const outcome = taskOutcome(persisted);
  return {
    adapterKind: 'legacy_task',
    executorRef: `task:${task.id}`,
    taskId: task.id,
    sessionId: persisted?.sessionId || null,
    outcome,
    summaryText: persisted?.progressSummary?.join('\n') || `Legacy Task ended with status ${persisted?.status || 'unknown'}`,
    resultJson: { taskId: task.id, taskStatus: persisted?.status || 'unknown', automationOutcome: isNoWorkTask(persisted) ? 'none' : undefined },
    errorJson: outcome === 'succeeded' ? null : {
      message: `Legacy Task ended with status ${persisted?.status || 'unknown'}`,
      retryable: false,
    },
  };
}

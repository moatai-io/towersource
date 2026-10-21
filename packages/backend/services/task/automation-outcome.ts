/** Explicit normal no-work outcome. Never infer this from prose or a failed Task. */
export const TASK_NONE_MARKER = '[TASK NONE]';
export function isNoWorkTask(task: { status?: string; progressSummary?: string[] } | null | undefined): boolean {
  return task?.status === 'done' && task.progressSummary?.some(line => line.startsWith(TASK_NONE_MARKER)) === true;
}

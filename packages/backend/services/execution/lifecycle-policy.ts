import type { CommandClassification } from './types.js';
export type ExecutionLifecycle = 'foreground' | 'job' | 'service';
/** Routing only. Authorization and service admission remain the broker's job. */
export function chooseExecutionLifecycle(input: { explicit?: ExecutionLifecycle; managedDownload: boolean; classification: CommandClassification }): ExecutionLifecycle {
  if (input.explicit) return input.explicit;
  if (input.managedDownload) return 'job';
  if (input.classification.cls === 'long-running') return 'service';
  if (input.classification.cls === 'heavy') return 'job';
  return 'foreground';
}

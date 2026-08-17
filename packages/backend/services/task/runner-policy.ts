/**
 * Owns: runner selection policy for scheduled automation jobs.
 * Public API: getRunnerPolicy(). See services/task/README.md.
 */

export interface ScheduleRunnerPolicy {
  preference: 'auto' | 'runtime_box' | 'host' | 'webhook' | 'ai';
  fallback: 'fail' | 'admin_host';
  wakePolicy: 'wake_if_stopped' | 'only_if_running';
  boxSelector: 'default' | string;
}

export function getRunnerPolicy(definition: Record<string, unknown> = {}): ScheduleRunnerPolicy {
  const runner = isRecord((definition as any).runner) ? (definition as any).runner : {};
  return {
    preference: normalizePreference(runner.preference),
    fallback: runner.fallback === 'admin_host' ? 'admin_host' : 'fail',
    wakePolicy: runner.wakePolicy === 'only_if_running' ? 'only_if_running' : 'wake_if_stopped',
    boxSelector: typeof runner.boxSelector === 'string' && runner.boxSelector.trim() ? runner.boxSelector.trim() : 'default',
  };
}

function normalizePreference(value: unknown): ScheduleRunnerPolicy['preference'] {
  switch (value) {
    case 'runtime_box':
    case 'host':
    case 'webhook':
    case 'ai':
    case 'auto':
      return value;
    default:
      return 'auto';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

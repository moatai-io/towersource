import { queryOne } from '../../db/pg-repo.js';

export interface ExecutionControlPlaneReadiness {
  ready: boolean;
  missing: string[];
}

interface ReadinessRow {
  executions_table: string | null;
  execution_events_table: string | null;
  automation_runs_execution_id: boolean;
  process_events_execution_id: boolean;
}

export async function getExecutionControlPlaneReadiness(
  query: typeof queryOne = queryOne,
): Promise<ExecutionControlPlaneReadiness> {
  const row = await query<ReadinessRow>(`
    SELECT
      to_regclass('public.executions')::text AS executions_table,
      to_regclass('public.execution_events')::text AS execution_events_table,
      EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'automation_runs' AND column_name = 'execution_id'
      ) AS automation_runs_execution_id,
      EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'process_events' AND column_name = 'execution_id'
      ) AS process_events_execution_id
  `);
  const missing: string[] = [];
  if (!row?.executions_table) missing.push('executions');
  if (!row?.execution_events_table) missing.push('execution_events');
  if (!row?.automation_runs_execution_id) missing.push('automation_runs.execution_id');
  if (!row?.process_events_execution_id) missing.push('process_events.execution_id');
  return { ready: missing.length === 0, missing };
}

export async function assertExecutionControlPlaneReady(
  query: typeof queryOne = queryOne,
): Promise<void> {
  const readiness = await getExecutionControlPlaneReadiness(query);
  if (!readiness.ready) {
    throw new Error(`Execution Control Plane schema is not ready: missing ${readiness.missing.join(', ')}`);
  }
}

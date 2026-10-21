import { describe, expect, it, vi } from 'vitest';
import { assertExecutionControlPlaneReady, getExecutionControlPlaneReadiness } from './execution-readiness.js';

describe('Execution Control Plane schema readiness', () => {
  it('is ready only when both ledgers and both projection columns exist', async () => {
    const query = vi.fn(async () => ({
      executions_table: 'executions', execution_events_table: 'execution_events',
      automation_runs_execution_id: true, process_events_execution_id: true,
    }));
    await expect(getExecutionControlPlaneReadiness(query as any)).resolves.toEqual({ ready: true, missing: [] });
    expect(query).toHaveBeenCalledWith(expect.stringContaining("to_regclass('public.executions')"));
  });

  it('returns explicit missing schema elements without reading data rows', async () => {
    const result = await getExecutionControlPlaneReadiness(vi.fn(async () => ({
      executions_table: null, execution_events_table: null,
      automation_runs_execution_id: false, process_events_execution_id: true,
    })) as any);
    expect(result).toEqual({
      ready: false,
      missing: ['executions', 'execution_events', 'automation_runs.execution_id'],
    });
  });

  it('fails closed before admission when migration readiness is incomplete', async () => {
    await expect(assertExecutionControlPlaneReady(vi.fn(async () => ({
      executions_table: 'executions', execution_events_table: null,
      automation_runs_execution_id: true, process_events_execution_id: false,
    })) as any)).rejects.toThrow('missing execution_events, process_events.execution_id');
  });
});

import { describe, expect, it, vi } from 'vitest';
import type { Automation } from '../task/automation-manager.js';
import { admitAutomationExecution } from './automation-execution-admission.js';

const automation = {
  id: 'automation-1', userId: 7, projectId: null, scopeType: 'system',
  name: 'Fleet check', mode: 'spawn', model: 'test-model', jobType: 'ai_prompt',
} as Automation;

function executionRow() {
  return {
    id: 'execution-1', source_kind: 'automation', source_id: 'automation-1', source_run_id: null,
    scope_kind: 'system', project_id: null, actor_user_id: 7, status: 'admitted',
    adapter_kind: 'legacy_task', engine: null, model: 'test-model', session_id: null,
    executor_ref: null, parent_execution_id: null, attempt: 1, idempotency_key: 'automation:automation-1:schedule:due-1',
    input_json: {}, result_json: null, summary_text: null, error_json: null,
    admitted_at: '2026-09-22T00:00:00Z', started_at: null, finished_at: null,
    created_at: '2026-09-22T00:00:00Z', updated_at: '2026-09-22T00:00:00Z',
  };
}

function transactionHarness(options: { existingExecution?: boolean; existingRun?: boolean } = {}) {
  const calls: Array<{ sql: string; params?: any[] }> = [];
  const client = {
    query: vi.fn(async (sql: string, params?: any[]) => {
      calls.push({ sql, params });
      if (sql.includes('SELECT * FROM executions WHERE idempotency_key')) {
        return { rows: options.existingExecution ? [executionRow()] : [], rowCount: options.existingExecution ? 1 : 0 };
      }
      if (sql.includes('INSERT INTO executions')) return { rows: [executionRow()], rowCount: 1 };
      if (sql.includes('SELECT id FROM automation_runs WHERE execution_id')) {
        return { rows: options.existingRun ? [{ id: 'run-existing' }] : [], rowCount: options.existingRun ? 1 : 0 };
      }
      return { rows: [], rowCount: 1 };
    }),
  };
  const transact = async (fn: any) => fn(client as any);
  return { calls, transact };
}

describe('Automation execution admission', () => {
  it('creates the Execution before a linked admitted Automation Run', async () => {
    const { calls, transact } = transactionHarness();
    const result = await admitAutomationExecution({
      automation, trigger: 'schedule', idempotencyKey: 'automation:automation-1:schedule:due-1',
      dueAt: '2026-09-22T00:00:00Z', adapterKind: 'legacy_task',
    }, transact as any);

    expect(result.created).toBe(true);
    expect(result.execution.sourceRunId).toBe(result.automationRunId);
    expect(calls.findIndex(call => call.sql.includes('INSERT INTO executions')))
      .toBeLessThan(calls.findIndex(call => call.sql.includes('INSERT INTO automation_runs')));
  });

  it('returns the linked run without creating a duplicate occurrence', async () => {
    const { calls, transact } = transactionHarness({ existingExecution: true, existingRun: true });
    const result = await admitAutomationExecution({
      automation, trigger: 'schedule', idempotencyKey: 'automation:automation-1:schedule:due-1',
      adapterKind: 'legacy_task',
    }, transact as any);

    expect(result).toMatchObject({ created: false, automationRunId: 'run-existing' });
    expect(calls.some(call => call.sql.includes('INSERT INTO automation_runs'))).toBe(false);
  });

  it('preserves a real Project scope and rejects sentinel-free system ambiguity', async () => {
    const { calls, transact } = transactionHarness();
    await admitAutomationExecution({
      automation: { ...automation, projectId: 'project-1', scopeType: 'project' },
      trigger: 'manual', idempotencyKey: 'automation:automation-1:manual:command-1', adapterKind: 'legacy_task',
    }, transact as any);
    const insert = calls.find(call => call.sql.includes('INSERT INTO executions'))!;
    expect(insert.params).toContain('project');
    expect(insert.params).toContain('project-1');
  });
});

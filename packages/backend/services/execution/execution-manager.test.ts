import { describe, expect, it, vi } from 'vitest';
import { admitExecutionWithDb, transitionExecution } from './execution-manager.js';

function row(overrides: Record<string, unknown> = {}) {
  return {
    id: 'execution-1', source_kind: 'automation', source_id: 'automation-1', source_run_id: null,
    scope_kind: 'system', project_id: null, actor_user_id: 7, status: 'admitted',
    adapter_kind: 'legacy_task', engine: null, model: 'test', session_id: null,
    executor_ref: null, parent_execution_id: null, attempt: 1, idempotency_key: 'key-1',
    input_json: {}, result_json: null, summary_text: null, error_json: null,
    admitted_at: '2026-09-22T00:00:00Z', started_at: null, finished_at: null,
    created_at: '2026-09-22T00:00:00Z', updated_at: '2026-09-22T00:00:00Z',
    ...overrides,
  };
}

const input = {
  sourceKind: 'automation' as const,
  sourceId: 'automation-1',
  scopeKind: 'system' as const,
  projectId: null,
  actorUserId: 7,
  adapterKind: 'legacy_task' as const,
  model: 'test',
  idempotencyKey: 'key-1',
};

describe('execution admission', () => {
  it('returns the existing execution for an identical idempotent admission', async () => {
    const db = { queryOne: vi.fn(async () => row()), execute: vi.fn() };
    const result = await admitExecutionWithDb(db, input);
    expect(result.created).toBe(false);
    expect(result.execution.id).toBe('execution-1');
    expect(db.execute).not.toHaveBeenCalled();
  });

  it('reuses an Automation Execution after its Run has been linked', async () => {
    const db = { queryOne: vi.fn(async () => row({ source_run_id: 'run-1' })), execute: vi.fn() };
    const result = await admitExecutionWithDb(db, input);
    expect(result).toMatchObject({ created: false, execution: { sourceRunId: 'run-1' } });
    expect(db.execute).not.toHaveBeenCalled();
  });

  it('does not allow an explicit different Run identity or non-Automation source to reuse that link', async () => {
    const db = { queryOne: vi.fn(async () => row({ source_run_id: 'run-1' })), execute: vi.fn() };
    await expect(admitExecutionWithDb(db, { ...input, sourceRunId: 'run-2' })).rejects.toThrow('idempotency key conflicts');
    const manualDb = { queryOne: vi.fn(async () => row({ source_kind: 'manual', source_run_id: 'run-1' })), execute: vi.fn() };
    await expect(admitExecutionWithDb(manualDb, { ...input, sourceKind: 'manual' })).rejects.toThrow('idempotency key conflicts');
  });

  it('rejects the same idempotency key for a different scope', async () => {
    const db = { queryOne: vi.fn(async () => row()), execute: vi.fn() };
    await expect(admitExecutionWithDb(db, { ...input, scopeKind: 'personal' }))
      .rejects.toThrow('idempotency key conflicts');
  });

  it('requires projectId only for project scope', async () => {
    const db = { queryOne: vi.fn(), execute: vi.fn() };
    await expect(admitExecutionWithDb(db, { ...input, scopeKind: 'project', projectId: null }))
      .rejects.toThrow('requires projectId');
    await expect(admitExecutionWithDb(db, { ...input, scopeKind: 'system', projectId: 'project-1' }))
      .rejects.toThrow('cannot reference projectId');
  });

  it('persists the admission and its first event', async () => {
    const db = {
      queryOne: vi.fn()
        .mockResolvedValueOnce(undefined)
        .mockResolvedValueOnce(row()),
      execute: vi.fn(async () => ({ changes: 1 })),
    };
    const result = await admitExecutionWithDb(db, input);
    expect(result.created).toBe(true);
    expect(db.execute).toHaveBeenCalledWith(expect.stringContaining('INSERT INTO execution_events'), expect.any(Array));
  });
});

describe('execution transitions', () => {
  it('updates state and appends an event in one transaction callback', async () => {
    const queryOne = vi.fn()
      .mockResolvedValueOnce(row({ status: 'admitted' }))
      .mockResolvedValueOnce(row({ status: 'running', started_at: '2026-09-22T00:01:00Z' }));
    const execute = vi.fn(async () => ({ changes: 1 }));
    const transact = vi.fn(async (fn: any) => fn({ query: vi.fn() }));

    vi.doMock('../../db/pg-repo.js', () => ({}));
    const result = await transitionExecution({
      executionId: 'execution-1', expectedStatuses: ['admitted'], toStatus: 'running', eventType: 'execution_started',
    }, async fn => fn({
      query: async (sql: string) => ({ rows: sql.includes('UPDATE executions') ? [await queryOne()] : [await queryOne()], rowCount: 1 }),
      release: vi.fn(),
    } as any));

    expect(result.status).toBe('running');
    expect(transact).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });

  it('rejects stale expected state without overwriting terminal truth', async () => {
    await expect(transitionExecution({
      executionId: 'execution-1', expectedStatuses: ['running'], toStatus: 'failed', eventType: 'execution_failed',
    }, async fn => fn({
      query: async () => ({ rows: [row({ status: 'succeeded' })], rowCount: 1 }),
      release: vi.fn(),
    } as any))).rejects.toThrow('transition conflict');
  });
});

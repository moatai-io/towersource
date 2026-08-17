import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  queryOne: vi.fn(),
  transaction: vi.fn(),
  withClient: vi.fn(),
  storeRoot: '',
}));

vi.mock('../../db/pg-repo.js', () => ({
  query: mocks.query,
  queryOne: mocks.queryOne,
  transaction: mocks.transaction,
  withClient: mocks.withClient,
}));
vi.mock('./workbench-tool-store.js', () => ({ workbenchToolStoreRoot: () => mocks.storeRoot }));
vi.mock('./workbench-mutation-lock.js', () => ({ withWorkbenchMutationLock: vi.fn(async (_projectId: string, fn: () => Promise<unknown>) => fn()) }));
vi.mock('./workbench-tool-experiment-policy.js', () => ({ assertExperimentalWorkbenchToolAccess: vi.fn() }));

import {
  applyWorkbenchToolRecovery,
  inspectWorkbenchToolRecovery,
  previewWorkbenchToolRecovery,
} from './workbench-tool-recovery.js';

describe('Workbench tool recovery inspection', () => {
  beforeEach(() => {
    mocks.query.mockReset();
    mocks.queryOne.mockReset();
    mocks.transaction.mockReset();
    mocks.withClient.mockReset();
    mocks.storeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'workbench-recovery-'));
  });

  afterEach(() => fs.rmSync(mocks.storeRoot, { recursive: true, force: true }));

  function mockRows(state: unknown, commands: unknown[], revisions: Array<{ revision: number }> = []) {
    mocks.query.mockResolvedValueOnce(state ? [state] : []).mockResolvedValueOnce(commands).mockResolvedValueOnce(revisions);
  }

  it('reports healthy when no interrupted command exists', async () => {
    mockRows({ current_revision: 4, health: 'healthy' }, []);
    await expect(inspectWorkbenchToolRecovery({ projectId: 'project-1' })).resolves.toMatchObject({
      disposition: 'healthy', currentRevision: 4, nextAction: 'none', blockers: [],
    });
  });

  it('allows only previewed cleanup when stale command has an isolated candidate and unchanged pointer', async () => {
    const commandId = 'command-1';
    fs.mkdirSync(path.join(mocks.storeRoot, 'projects', 'project-1', 'staging', commandId), { recursive: true });
    mockRows({ current_revision: 4, health: 'healthy' }, [{
      id: commandId, status: 'running', before_revision: 4, after_revision: null,
      started_at: new Date(0), completed_at: null,
    }]);

    await expect(inspectWorkbenchToolRecovery({ projectId: 'project-1' })).resolves.toMatchObject({
      disposition: 'auto_cleanup_candidate',
      safeCleanupCandidates: [commandId],
      nextAction: 'preview_candidate_cleanup',
      blockers: [],
    });
  });

  it('requires operator review when finalized revision evidence exists', async () => {
    fs.mkdirSync(path.join(mocks.storeRoot, 'projects', 'project-1', 'revisions', '000005'), { recursive: true });
    mockRows({ current_revision: 4, health: 'healthy' }, [{
      id: 'command-2', status: 'running', before_revision: 4, after_revision: 5,
      started_at: new Date(0), completed_at: null,
    }]);

    const result = await inspectWorkbenchToolRecovery({ projectId: 'project-1' });
    expect(result.disposition).toBe('operator_review');
    expect(result.nextAction).toBe('operator_review');
    expect(result.blockers.some(blocker => blocker.includes('automatic cleanup is forbidden'))).toBe(true);
  });

  it('fails closed when pointer moved away from command before revision', async () => {
    fs.mkdirSync(path.join(mocks.storeRoot, 'projects', 'project-1', 'staging', 'command-3'), { recursive: true });
    mockRows({ current_revision: 6, health: 'healthy' }, [{
      id: 'command-3', status: 'reserved', before_revision: 4, after_revision: null,
      started_at: null, completed_at: null,
    }]);

    const result = await inspectWorkbenchToolRecovery({ projectId: 'project-1' });
    expect(result.disposition).toBe('operator_review');
    expect(result.safeCleanupCandidates).toEqual([]);
    expect(result.blockers[0]).toContain('observed current revision 6, expected 4');
  });

  it('preserves recovery_required as the strongest authority', async () => {
    mockRows({ current_revision: 4, health: 'recovery_required' }, []);
    await expect(inspectWorkbenchToolRecovery({ projectId: 'project-1' })).resolves.toMatchObject({
      disposition: 'recovery_required', nextAction: 'repair_required', health: 'recovery_required',
    });
  });

  it('uses a stale cutoff and never inspects fresh running commands', async () => {
    mockRows({ current_revision: 4, health: 'healthy' }, []);
    const staleBefore = new Date('2026-08-04T00:00:00.000Z');
    await inspectWorkbenchToolRecovery({ projectId: 'project-1', staleBefore });
    expect(mocks.query.mock.calls[1][1]).toEqual(['project-1', staleBefore]);
  });

  it('requires operator review when a finalized store revision has no DB ledger row', async () => {
    fs.mkdirSync(path.join(mocks.storeRoot, 'projects', 'project-1', 'revisions', '000005'), { recursive: true });
    mockRows({ current_revision: 4, health: 'healthy' }, [], [{ revision: 4 }]);
    const result = await inspectWorkbenchToolRecovery({ projectId: 'project-1' });
    expect(result.disposition).toBe('operator_review');
    expect(result.orphanFinalizedRevisions).toEqual([5]);
    expect(result.blockers[0]).toContain('finalized revisions without DB ledger rows: 5');
  });

  it('issues a hash-bound cleanup preview for one safe candidate', async () => {
    mocks.queryOne.mockResolvedValue({ id: 'intent-1', expires_at: '2026-08-04T00:15:00.000Z' });
    const inspect = vi.fn().mockResolvedValue({
      projectId: 'project-1', disposition: 'auto_cleanup_candidate', health: 'healthy', currentRevision: 4,
      interruptedCommands: [{ commandId: 'command-1', status: 'running', beforeRevision: 4, afterRevision: null, candidateExists: true, finalRevisionExists: false }],
      safeCleanupCandidates: ['command-1'], blockers: [], nextAction: 'preview_candidate_cleanup',
    });
    const preview = await previewWorkbenchToolRecovery({
      projectId: 'project-1', commandId: 'command-1', actor: { userId: 7, role: 'admin', sessionId: 'session-1' }, inspect,
    });
    expect(preview).toMatchObject({ intentId: 'intent-1', commandId: 'command-1', expectedRevision: 4, expectedCommandStatus: 'running' });
    expect(preview.proposalHash).toMatch(/^[0-9a-f]{64}$/);
    expect(mocks.queryOne.mock.calls[0][0]).toContain('runtime_box_workbench_recovery_intents');
  });

  it('rejects preview when cleanup evidence is ambiguous', async () => {
    const inspect = vi.fn().mockResolvedValue({
      projectId: 'project-1', disposition: 'operator_review', health: 'healthy', currentRevision: 4,
      interruptedCommands: [], safeCleanupCandidates: [], blockers: ['ambiguous'], nextAction: 'operator_review',
    });
    await expect(previewWorkbenchToolRecovery({
      projectId: 'project-1', commandId: 'command-1', actor: { userId: 7, role: 'admin' }, inspect,
    })).rejects.toMatchObject({ code: 'CLEANUP_NOT_SAFE' });
  });

  it('applies one approved cleanup and preserves command evidence', async () => {
    const candidate = path.join(mocks.storeRoot, 'projects', 'project-1', 'staging', 'command-1');
    fs.mkdirSync(candidate, { recursive: true });
    const intent = {
      id: 'intent-1', project_id: 'project-1', command_id: 'command-1', actor_user_id: 7,
      expected_revision: 4, expected_command_status: 'running', proposal_hash: 'a'.repeat(64),
      consumed_at: null, status: 'previewed',
    };
    mocks.queryOne
      .mockResolvedValueOnce(intent)
      .mockResolvedValueOnce(intent)
      .mockResolvedValueOnce({ id: 'intent-1' });
    const db = { queryOne: vi.fn().mockResolvedValue({ id: 'ok' }) };
    mocks.withClient.mockReturnValue(db);
    mocks.transaction.mockImplementation(async (fn: (client: object) => Promise<unknown>) => fn({}));
    const inspect = vi.fn().mockResolvedValue({
      projectId: 'project-1', disposition: 'auto_cleanup_candidate', health: 'healthy', currentRevision: 4,
      interruptedCommands: [{ commandId: 'command-1', status: 'running', beforeRevision: 4, afterRevision: null, candidateExists: true, finalRevisionExists: false }],
      safeCleanupCandidates: ['command-1'], blockers: [], nextAction: 'preview_candidate_cleanup',
    });

    const result = await applyWorkbenchToolRecovery({
      projectId: 'project-1', intentId: 'intent-1', proposalHash: 'a'.repeat(64), confirmed: true,
      actor: { userId: 7, role: 'admin' }, inspect,
    });
    expect(result).toEqual({ commandId: 'command-1', candidateRemoved: true, activeRevisionChanged: false, commandEvidencePreserved: true });
    expect(fs.existsSync(candidate)).toBe(false);
    expect(db.queryOne.mock.calls[0][0]).toContain("SET status='failed'");
    expect(db.queryOne.mock.calls[0][0]).not.toMatch(/DELETE FROM/i);
  });

  it('fails closed before deletion when evidence changed after preview', async () => {
    const intent = {
      id: 'intent-1', project_id: 'project-1', command_id: 'command-1', actor_user_id: 7,
      expected_revision: 4, expected_command_status: 'running', proposal_hash: 'a'.repeat(64),
      consumed_at: null, status: 'previewed',
    };
    mocks.queryOne.mockResolvedValue(intent);
    const removeCandidate = vi.fn();
    const inspect = vi.fn().mockResolvedValue({
      projectId: 'project-1', disposition: 'operator_review', health: 'healthy', currentRevision: 5,
      interruptedCommands: [], safeCleanupCandidates: [], blockers: ['pointer moved'], nextAction: 'operator_review',
    });
    await expect(applyWorkbenchToolRecovery({
      projectId: 'project-1', intentId: 'intent-1', proposalHash: 'a'.repeat(64), confirmed: true,
      actor: { userId: 7, role: 'admin' }, inspect, removeCandidate,
    })).rejects.toMatchObject({ code: 'STALE_RECOVERY_INTENT' });
    expect(removeCandidate).not.toHaveBeenCalled();
  });
});

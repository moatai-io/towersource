import { beforeEach, describe, expect, it, vi } from 'vitest';

const query = vi.fn();
const queryOne = vi.fn();
const execute = vi.fn(async () => ({ changes: 1 }));
const txQueryOne = vi.fn();
const txExecute = vi.fn(async () => ({ changes: 1 }));
vi.mock('../../db/pg-repo.js', () => ({
  query: (...args: any[]) => query(...args),
  queryOne: (...args: any[]) => queryOne(...args),
  execute: (...args: any[]) => execute(...args),
  transaction: async (fn: any) => fn({}),
  withClient: () => ({ queryOne: (...args: any[]) => txQueryOne(...args), execute: (...args: any[]) => txExecute(...args) }),
}));
vi.mock('./schedule-permissions.js', () => ({ canAccessAutomationJob: vi.fn(async () => ({ allowed: true })) }));
vi.mock('./automation-mutation-policy.js', () => ({ authorizeAutomationMutation: vi.fn(async () => ({ allowed: true, riskLevel: 'low' })) }));
vi.mock('./automation-manager.js', () => ({
  getAutomation: vi.fn(),
  getAutomationInTransaction: vi.fn(),
  getAutomationForUpdateInTransaction: vi.fn(),
  updateAutomationInTransaction: vi.fn(),
}));

import { applyAutomationChangeIntent, automationChangeProposalHash, createAutomationChangeIntent, getAutomationChangeIntentDiagnostics, reconcileAutomationChangeIntent } from './automation-change-intent.js';
import { getAutomation, getAutomationInTransaction, getAutomationForUpdateInTransaction, updateAutomationInTransaction } from './automation-manager.js';
import type { Automation } from './automation-manager.js';

const validYaml = `version: 1\nname: Updated\n\ntrigger:\n  type: manual\n\nrun:\n  type: ai_prompt\n  prompt: summarize\n\ncondition:\n  ai_when:\n    - output.ai_needed == true\n\nai:\n  prompt: summarize\n\nreport:\n  policy: auto\n`;
const automation = {
  id: 'a1', userId: 7, projectId: 'p1', scopeType: 'project', jobType: 'ai_prompt', definitionJson: {},
  configUpdatedAt: '2026-07-20T00:00:00.000Z', configUpdatedByUserId: 7,
} as Automation;

function intentRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'i1', automation_id: 'a1', project_id: 'p1', proposed_by_user_id: 7, source_session_id: 's1',
    base_config_updated_at: automation.configUpdatedAt, proposal_hash: 'h'.repeat(64), yaml_text: validYaml,
    materialized_updates: { name: 'Updated', jobType: 'ai_prompt', riskLevel: 'low' }, risk_level: 'low', warnings: [], summary: 'rename',
    status: 'proposed', expires_at: '2099-01-01T00:00:00.000Z', applying_by_user_id: null, applying_at: null, applied_by_user_id: null, applied_at: null,
    error: null, created_at: '2026-07-20T00:00:00.000Z', updated_at: '2026-07-20T00:00:00.000Z', ...overrides,
  };
}

describe('automation change intents', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getAutomation).mockResolvedValue(automation);
    vi.mocked(getAutomationInTransaction).mockResolvedValue(automation);
    vi.mocked(getAutomationForUpdateInTransaction).mockResolvedValue(automation);
    vi.mocked(updateAutomationInTransaction).mockResolvedValue({ ...automation, name: 'Updated', riskLevel: 'low', configUpdatedAt: '2026-07-20T00:01:00.000Z' } as Automation);
  });

  it('creates a deterministic preview bound to the automation config revision', async () => {
    queryOne.mockResolvedValueOnce(intentRow());
    const intent = await createAutomationChangeIntent({ automation, actorUserId: 7, actorRole: 'member', yaml: validYaml });
    expect(intent.automationId).toBe('a1');
    expect(queryOne).toHaveBeenCalledWith(expect.stringContaining('automation_change_intents'), expect.arrayContaining(['a1', 'p1', 7]));
    expect(automationChangeProposalHash({ automationId: 'a1', baseConfigUpdatedAt: 'x', updates: { b: 2, a: 1 } }))
      .toBe(automationChangeProposalHash({ automationId: 'a1', baseConfigUpdatedAt: 'x', updates: { a: 1, b: 2 } }));
  });

  it('rejects a stale preview before claiming or applying it', async () => {
    txQueryOne.mockResolvedValueOnce(intentRow());
    vi.mocked(getAutomationForUpdateInTransaction).mockResolvedValueOnce({ ...automation, configUpdatedAt: '2026-07-20T01:00:00.000Z' } as Automation);
    await expect(applyAutomationChangeIntent({ intentId: 'i1', automationId: 'a1', actorUserId: 7, proposalHash: 'h'.repeat(64) }))
      .rejects.toThrow('automation changed after this proposal');
    expect(updateAutomationInTransaction).not.toHaveBeenCalled();
  });

  it('claims an unused intent once, applies it, and marks it applied', async () => {
    txQueryOne.mockResolvedValueOnce(intentRow())
      .mockResolvedValueOnce(intentRow({ status: 'applying' }))
      .mockResolvedValueOnce({ id: 'r1' })
      .mockResolvedValueOnce(intentRow({ status: 'applied', applied_by_user_id: 7, applied_at: '2026-07-20T00:01:00.000Z' }));
    const result = await applyAutomationChangeIntent({ intentId: 'i1', automationId: 'a1', actorUserId: 7, proposalHash: 'h'.repeat(64) });
    expect(txQueryOne).toHaveBeenCalledWith(expect.stringContaining("status='applying'"), ['i1', 7]);
    expect(getAutomationForUpdateInTransaction).toHaveBeenCalledWith(expect.anything(), 'a1');
    expect(updateAutomationInTransaction).toHaveBeenCalledWith(expect.anything(), 'a1', expect.objectContaining({ name: 'Updated', updatedByUserId: 7 }));
    expect(txQueryOne).toHaveBeenCalledWith(expect.stringContaining('INSERT INTO automation_config_revisions'), expect.arrayContaining(['a1', 'i1', 7]));
    expect(result.intent.status).toBe('applied');
  });

  it('rejects an already-consumed intent', async () => {
    txQueryOne.mockResolvedValueOnce(intentRow({ status: 'applied' }));
    await expect(applyAutomationChangeIntent({ intentId: 'i1', automationId: 'a1', actorUserId: 7, proposalHash: 'h'.repeat(64) }))
      .rejects.toThrow('not unused');
  });

  it('reconciles an interrupted apply as applied only from exact revision and actor evidence', async () => {
    const applying = intentRow({ status: 'applying', applying_by_user_id: 7, applying_at: '2026-07-20T00:01:00.000Z' });
    txQueryOne.mockResolvedValueOnce(applying)
      .mockResolvedValueOnce({ id: 'r1', actor_user_id: 7, config_updated_at: '2026-07-20T00:02:00.000Z' })
      .mockResolvedValueOnce(intentRow({ ...applying, status: 'applied', applied_by_user_id: 7 }));
    vi.mocked(getAutomationInTransaction).mockResolvedValueOnce({ ...automation, name: 'Updated', riskLevel: 'low', configUpdatedAt: '2026-07-20T00:02:00.000Z', configUpdatedByUserId: 7 } as Automation);
    const result = await reconcileAutomationChangeIntent({ intentId: 'i1', automationId: 'a1', actorUserId: 7, now: new Date('2026-07-20T00:10:00.000Z') });
    expect(result.outcome).toBe('applied');
    expect(result.reason).toContain('exact change-intent revision ledger evidence');
    expect(txQueryOne).toHaveBeenCalledWith(expect.stringContaining('change_intent_id=$2'), ['a1', 'i1']);
    expect(txQueryOne).toHaveBeenLastCalledWith(expect.stringContaining("status=$2"), ['i1', 'applied', expect.any(String)]);
    expect(updateAutomationInTransaction).not.toHaveBeenCalled();
  });

  it('marks an interrupted apply failed when revision evidence does not match', async () => {
    const applying = intentRow({ status: 'applying', applying_by_user_id: 7, applying_at: '2026-07-20T00:01:00.000Z' });
    txQueryOne.mockResolvedValueOnce(applying)
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(intentRow({ ...applying, status: 'failed', error: 'missing revision' }));
    vi.mocked(getAutomationInTransaction).mockResolvedValueOnce({ ...automation, name: 'Other', riskLevel: 'low', configUpdatedAt: '2026-07-20T00:02:00.000Z', configUpdatedByUserId: 8 } as Automation);
    const result = await reconcileAutomationChangeIntent({ intentId: 'i1', automationId: 'a1', actorUserId: 7, now: new Date('2026-07-20T00:10:00.000Z') });
    expect(result.outcome).toBe('failed');
  });

  it('does not reconcile a recently applying intent', async () => {
    txQueryOne.mockResolvedValueOnce(intentRow({ status: 'applying', applying_by_user_id: 7, applying_at: '2026-07-20T00:09:30.000Z' }));
    await expect(reconcileAutomationChangeIntent({ intentId: 'i1', automationId: 'a1', actorUserId: 7, now: new Date('2026-07-20T00:10:00.000Z') }))
      .rejects.toThrow('may still be applying');
  });

  it('returns pending and interrupted intent diagnostics for authorized viewers', async () => {
    query.mockResolvedValueOnce([intentRow({ status: 'applying' }), intentRow({ id: 'i2', status: 'failed', error: 'completion failed' })]);
    const diagnostics = await getAutomationChangeIntentDiagnostics({ automationId: 'a1', actorUserId: 7, actorRole: 'member' });
    expect(query).toHaveBeenCalledWith(expect.stringContaining("status IN ('proposed','applying','failed')"), ['a1']);
    expect(diagnostics.map((item) => item.status)).toEqual(['applying', 'failed']);
  });
});

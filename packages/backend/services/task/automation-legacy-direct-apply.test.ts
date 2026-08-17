import { beforeEach, describe, expect, it, vi } from 'vitest';

const txQueryOne = vi.fn();
vi.mock('../../db/pg-repo.js', () => ({
  transaction: async (fn: any) => fn({}),
  withClient: () => ({ queryOne: (...args: any[]) => txQueryOne(...args) }),
}));
vi.mock('./automation-manager.js', () => ({
  getAutomationForUpdateInTransaction: vi.fn(),
  updateAutomationInTransaction: vi.fn(),
}));

import { applyLegacyAutomationConfig, authorizeLegacyDirectAutomationApply } from './automation-legacy-direct-apply.js';
import { getAutomationForUpdateInTransaction, updateAutomationInTransaction } from './automation-manager.js';
import type { Automation } from './automation-manager.js';

const automation = {
  id: 'a1', configUpdatedAt: '2026-07-20T00:00:00.000Z', name: 'A', description: '', prompt: '', model: 'm',
  workflow: 'auto', jobType: 'ai_prompt', scopeType: 'project', definitionJson: {}, riskLevel: 'low', timeoutSeconds: null,
  timezone: 'Asia/Seoul', mode: 'spawn', targetId: null, cwd: null, triggerType: 'manual', cronConfig: null,
  onceAt: null, enabled: true, sortOrder: 0, projectId: 'p1',
} as Automation;

describe('legacy direct automation apply', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getAutomationForUpdateInTransaction).mockResolvedValue(automation);
    vi.mocked(updateAutomationInTransaction).mockResolvedValue({ ...automation, name: 'B', configUpdatedAt: '2026-07-20T00:01:00.000Z' });
    txQueryOne.mockResolvedValue({ id: 'r1' });
  });

  it('rejects normal members even when they send confirmation', () => {
    expect(authorizeLegacyDirectAutomationApply({ role: 'member', confirmed: true, reason: 'emergency repair' })).toMatchObject({ allowed: false, status: 403 });
  });

  it('requires explicit confirmation and a material audit reason', () => {
    expect(authorizeLegacyDirectAutomationApply({ role: 'operator', confirmed: false, reason: 'emergency repair' }).allowed).toBe(false);
    expect(authorizeLegacyDirectAutomationApply({ role: 'operator', confirmed: true, reason: 'short' }).allowed).toBe(false);
    expect(authorizeLegacyDirectAutomationApply({ role: 'operator', confirmed: true, reason: 'emergency compatibility repair' })).toMatchObject({ allowed: true });
  });

  it('updates config and writes a legacy_direct revision in one transaction path', async () => {
    const changed = await applyLegacyAutomationConfig({
      automationId: 'a1', actorUserId: 7, expectedConfigUpdatedAt: automation.configUpdatedAt,
      updates: { name: 'B', riskLevel: 'low' }, reason: 'emergency compatibility repair',
    });
    expect(changed.name).toBe('B');
    expect(updateAutomationInTransaction).toHaveBeenCalledWith(expect.anything(), 'a1', expect.objectContaining({ name: 'B', updatedByUserId: 7 }));
    expect(txQueryOne).toHaveBeenCalledWith(expect.stringContaining("'legacy_direct'"), expect.arrayContaining(['a1', 7, 'emergency compatibility repair']));
  });

  it('rejects stale callers before mutation', async () => {
    vi.mocked(getAutomationForUpdateInTransaction).mockResolvedValueOnce({ ...automation, configUpdatedAt: '2026-07-20T02:00:00.000Z' });
    await expect(applyLegacyAutomationConfig({
      automationId: 'a1', actorUserId: 7, expectedConfigUpdatedAt: automation.configUpdatedAt,
      updates: { name: 'B' }, reason: 'emergency compatibility repair',
    })).rejects.toThrow('changed before legacy direct apply');
    expect(updateAutomationInTransaction).not.toHaveBeenCalled();
  });
});

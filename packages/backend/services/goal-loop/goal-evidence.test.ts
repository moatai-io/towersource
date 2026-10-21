import { describe, it, expect } from 'vitest';
import { startGoal } from './goal-loop';
import { criterionHash, verifyGoalEvidenceSnapshot, createGoalEvidenceVerifier, type EvidenceSnapshot, type GoalCheckCommand } from './goal-evidence';
const scope = { userId: 1, projectId: 'p', sessionId: 's', rootTurnId: 'r' };
const criterion = { id: 'c', description: 'fixture passes' };
function fixture() {
  const record = { scope, version: 3, receipts: {}, state: startGoal('fix', [criterion]) };
  record.state.phase = 'check';
  const receipt = { id: 'receipt-1', scope: { ...scope }, criterionId: 'c', criterionHash: criterionHash(criterion), revision: 'initial', verifierId: 'fixture-v1', status: 'passed', artifactDigest: 'a'.repeat(64), createdAt: '2026-09-07T00:00:00Z' };
  const snapshot: EvidenceSnapshot = { record, artifactDigest: 'a'.repeat(64), receipts: [receipt] };
  const command: GoalCheckCommand = { action: 'check', outcome: 'improved', evidence: [{ criterionId: 'c', revision: 'initial', reference: 'receipt-1', passed: true }] };
  const check = () => verifyGoalEvidenceSnapshot(scope, 3, command, snapshot, new Set(['fixture-v1']));
  return { receipt, snapshot, command, check };
}
describe('goal evidence receipt validation', () => {
  it('accepts an exact trusted current-artifact receipt', () => { expect(fixture().check()).toBe(true); });
  it.each(['userId', 'projectId', 'sessionId', 'rootTurnId'] as const)('rejects receipt scope mismatch %s', key => {
    const f = fixture(); Object.assign(f.receipt.scope, { [key]: key === 'userId' ? 2 : 'other' }); expect(f.check()).toBe(false);
  });
  it('rejects missing receipts', () => { const f = fixture(); f.snapshot.receipts = []; expect(f.check()).toBe(false); });
  it('rejects previous artifact even with same revision label', () => { const f = fixture(); f.snapshot.artifactDigest = 'b'.repeat(64); expect(f.check()).toBe(false); });
  it('rejects changed acceptance criterion', () => { const f = fixture(); f.snapshot.record.state.criteria[0].description = 'different'; expect(f.check()).toBe(false); });
  it('rejects stale version', () => { const f = fixture(); f.snapshot.record.version++; expect(f.check()).toBe(false); });
  it('rejects unknown verifier', () => { const f = fixture(); f.receipt.verifierId = 'model-self-report'; expect(f.check()).toBe(false); });
  it('rejects changed pass/fail claim', () => { const f = fixture(); f.receipt.status = 'failed'; expect(f.check()).toBe(false); });
  it('rejects duplicate receipt ids', () => { const f = fixture(); f.snapshot.receipts.push(f.receipt); expect(f.check()).toBe(false); });
  it('permits an empty inconclusive check, never an empty success claim', () => {
    const f = fixture(); f.command.evidence = []; expect(f.check()).toBe(false); f.command.outcome = 'inconclusive'; expect(f.check()).toBe(true);
  });
  it('fails closed when the trusted store is unavailable', async () => {
    const f = fixture(); const verify = createGoalEvidenceVerifier({ snapshot: async () => { throw new Error('offline'); } }, new Set(['fixture-v1']));
    expect(await verify(scope, f.command, 3)).toBe(false);
  });
});

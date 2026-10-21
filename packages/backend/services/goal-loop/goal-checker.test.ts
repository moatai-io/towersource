import { describe, it, expect, vi } from 'vitest';
import { issueGoalReceipt, type CheckerBinding } from './goal-checker';
function fixture() {
  const binding: CheckerBinding = { scope: { userId: 1, projectId: 'p', sessionId: 's', rootTurnId: 'r' }, criterion: { id: 'c', description: 'passes' }, revision: 'v1', verifierId: 'fixture-v1', execute: vi.fn(async () => 'passed' as const) };
  const host = { authorize: vi.fn(async () => true), digest: vi.fn(async () => 'a'.repeat(64)), commit: vi.fn(async () => true) };
  return { binding, host, controller: new AbortController() };
}
describe('host-bound checker receipt issuance', () => {
  it('issues only after execution and stable artifact check', async () => {
    const f = fixture(); const receipt = await issueGoalReceipt(f.binding, f.host, f.controller.signal);
    expect(receipt).toMatchObject({ status: 'passed', revision: 'v1', artifactDigest: 'a'.repeat(64) });
    expect(f.host.authorize).toHaveBeenCalledTimes(2); expect(f.host.commit).toHaveBeenCalledWith(receipt);
  });
  it('does not issue if artifact changed during check', async () => {
    const f = fixture(); f.host.digest.mockResolvedValueOnce('a'.repeat(64)).mockResolvedValueOnce('b'.repeat(64));
    expect(await issueGoalReceipt(f.binding, f.host, f.controller.signal)).toBeNull(); expect(f.host.commit).not.toHaveBeenCalled();
  });
  it('does not execute without authorization', async () => {
    const f = fixture(); f.host.authorize.mockResolvedValue(false);
    expect(await issueGoalReceipt(f.binding, f.host, f.controller.signal)).toBeNull(); expect(f.binding.execute).not.toHaveBeenCalled();
  });
  it('does not replay ambiguous checks', async () => {
    const f = fixture(); f.binding.execute = vi.fn(async () => { throw new Error('timeout'); });
    await expect(issueGoalReceipt(f.binding, f.host, f.controller.signal)).rejects.toThrow('timeout'); expect(f.host.commit).not.toHaveBeenCalled();
  });
  it('does not claim receipt issued if fenced commit fails', async () => {
    const f = fixture(); f.host.commit.mockResolvedValue(false);
    expect(await issueGoalReceipt(f.binding, f.host, f.controller.signal)).toBeNull();
  });
});

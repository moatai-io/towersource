import { describe, it, expect, vi } from 'vitest';
import type { PoolClient } from 'pg';
import { createTransactionalGoalGuard } from './goal-guard';
const scope = { userId: 1, projectId: 'p', sessionId: 's', rootTurnId: 'r' };
const command = { action: 'inspect' as const, decision: 'change' as const, reason: 'fix', strategyChanged: false };
function setup(enabled = true) {
  const query = vi.fn(async () => ({ rowCount: 1 }));
  const evidenceSnapshot = vi.fn(async () => null);
  const guard = createTransactionalGoalGuard({ ownerToken: 'test-token', ownerBootId: 'test-boot', goalAuthorized: enabled, trustedVerifierIds: new Set(), evidenceSnapshot });
  return { query, evidenceSnapshot, guard, client: { query } as unknown as PoolClient };
}
describe('goal transaction turn fence', () => {
  it('requires explicit host opt-in before querying', async () => {
    const f = setup(false); expect(await f.guard.validate(f.client, scope, null, command)).toBe(false); expect(f.query).not.toHaveBeenCalled();
  });
  it('requires matching owner and boot and checks stop/wait/newer-turn/uncertain-effect conditions', async () => {
    const f = setup(); expect(await f.guard.validate(f.client, scope, null, command)).toBe(true);
    const [sql, args] = (f.query.mock.calls as unknown as [string, unknown[]][])[0];
    expect(args).toEqual(['r', 's', 'test-token', 'test-boot', null]);
    for (const condition of ["t.state = 'running'", 't.lease_until > NOW()', 't.waiting_user_started_at IS NULL', 'newer.created_at >= root.created_at', "e.status = 'uncertain'", "e.tool_name = 'goal_step'", 'FOR UPDATE OF t']) expect(sql).toContain(condition);
  });
  it('does not verify evidence when the execution fence is lost', async () => {
    const f = setup(); f.query.mockResolvedValue({ rowCount: 0 });
    expect(await f.guard.validate(f.client, scope, null, command)).toBe(false); expect(f.evidenceSnapshot).not.toHaveBeenCalled();
  });
  it('cannot check without an existing goal', async () => {
    const f = setup(); expect(await f.guard.validate(f.client, scope, null, { action: 'check', outcome: 'inconclusive', evidence: [] })).toBe(false);
  });
});

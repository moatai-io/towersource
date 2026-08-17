import { beforeEach, describe, expect, it, vi } from 'vitest';

const queryOne = vi.fn();
const execute = vi.fn();
vi.mock('../../db/pg-repo.js', () => ({ queryOne, execute }));

const { claimDeliveryById, claimNextDelivery, quarantineClaimsFromPreviousBoot, renewDeliveryClaim, settleClaimedDelivery } = await import('./delivery-lease-store.js');

describe('Delivery lease store', () => {
  beforeEach(() => {
    queryOne.mockReset();
    execute.mockReset();
  });

  it('claims a known pending delivery for the legacy-compatible execution handoff', async () => {
    queryOne.mockResolvedValueOnce({ id:'delivery-0',message_id:'message-0',recipient_session_id:'session-b',owner_token:'token-0',owner_boot_id:'boot-1',attempt_count:1,lease_until:'later' });
    await expect(claimDeliveryById({deliveryId:'delivery-0',ownerBootId:'boot-1'})).resolves.toMatchObject({deliveryId:'delivery-0',ownerToken:'token-0'});
    expect(String(queryOne.mock.calls[0][0])).toContain("WHERE id = $1 AND state IN ('pending', 'retry_wait')");
  });

  it('claims one oldest due row with SKIP LOCKED without replaying ambiguous expired claims', async () => {
    queryOne.mockResolvedValueOnce({
      id: 'delivery-1', message_id: 'message-1', recipient_session_id: 'session-b',
      owner_token: 'token-1', owner_boot_id: 'boot-1', attempt_count: 2,
      lease_until: '2026-08-10T12:01:00Z',
    });

    await expect(claimNextDelivery({ recipientSessionId: 'session-b', ownerBootId: 'boot-1' }))
      .resolves.toMatchObject({ deliveryId: 'delivery-1', attemptCount: 2, ownerBootId: 'boot-1' });

    const sql = String(queryOne.mock.calls[0][0]);
    expect(sql).toContain('FOR UPDATE SKIP LOCKED');
    expect(sql).toContain("state IN ('pending', 'retry_wait')");
    expect(sql).not.toContain("OR (state = 'claimed'");
    expect(sql).toContain('ORDER BY created_at ASC, id ASC');
    expect(sql).toContain('attempt_count = attempt_count + 1');
  });

  it('bounds lease duration and returns undefined when no row is due', async () => {
    queryOne.mockResolvedValueOnce(undefined);
    await expect(claimNextDelivery({ recipientSessionId: 'session-b', ownerBootId: 'boot-1', leaseSeconds: 999 }))
      .resolves.toBeUndefined();
    expect(queryOne.mock.calls[0][1][3]).toBe(300);
  });

  it('quarantines claims owned by a previous backend boot', async () => {
    execute.mockResolvedValueOnce({ changes: 3 });
    await expect(quarantineClaimsFromPreviousBoot('boot-new')).resolves.toBe(3);
    expect(String(execute.mock.calls[0][0])).toContain("state = 'claimed' AND owner_boot_id IS DISTINCT FROM $1");
    expect(String(execute.mock.calls[0][0])).toContain("failure_class = 'ambiguous_after_restart'");
  });

  it('renews only the token and boot identity that still own the claim', async () => {
    execute.mockResolvedValueOnce({ changes: 1 }).mockResolvedValueOnce({ changes: 0 });
    await expect(renewDeliveryClaim({ deliveryId: 'delivery-1', ownerToken: 'token-1', ownerBootId: 'boot-1', leaseSeconds: 1 }))
      .resolves.toBe(true);
    await expect(renewDeliveryClaim({ deliveryId: 'delivery-1', ownerToken: 'stale', ownerBootId: 'boot-1' }))
      .resolves.toBe(false);
    expect(String(execute.mock.calls[0][0])).toContain("owner_token = $2 AND owner_boot_id = $3 AND state = 'claimed'");
    expect(execute.mock.calls[0][1][3]).toBe(15);
  });

  it('fences settlement and schedules retry_wait without marking it terminal', async () => {
    execute.mockResolvedValueOnce({ changes: 1 });
    await expect(settleClaimedDelivery({
      deliveryId: 'delivery-1', ownerToken: 'token-1', ownerBootId: 'boot-1',
      state: 'retry_wait', failureClass: 'recipient_busy', error: 'try later', retryDelaySeconds: 500,
    })).resolves.toBe(true);

    const sql = String(execute.mock.calls[0][0]);
    expect(sql).toContain("next_attempt_at = CASE WHEN $4 = 'retry_wait'");
    expect(sql).toContain("completed_at = CASE WHEN $4 IN ('completed', 'failed', 'needs_attention')");
    expect(sql).toContain("owner_token = $2 AND owner_boot_id = $3 AND state = 'claimed'");
    expect(execute.mock.calls[0][1][9]).toBe(300);
  });
});

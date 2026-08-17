import { describe, expect, it, vi } from 'vitest';
import { settleDeliveryShadow } from './delivery-shadow.js';

describe('Delivery shadow settlement', () => {
  it('records observed legacy mode, root turn, and terminal time', async () => {
    const execute = vi.fn().mockResolvedValue({ changes: 1 });

    await expect(settleDeliveryShadow({
      deliveryId: 'delivery-1', state: 'completed', mode: 'new-turn',
      recipientRootTurnId: 'turn-1', responseMessageId: 'response-1',
    }, execute)).resolves.toBe(true);

    expect(execute).toHaveBeenCalledWith(expect.stringContaining('UPDATE agent_message_deliveries'), [
      'delivery-1', 'completed', 'new-turn', 'turn-1', 'response-1', null, true,
    ]);
    expect(execute.mock.calls[0][0]).toContain('completed_at = CASE WHEN $7 THEN NOW()');
  });

  it('does not mark non-terminal active injection completed', async () => {
    const execute = vi.fn().mockResolvedValue({ changes: 1 });
    await settleDeliveryShadow({ deliveryId: 'delivery-2', state: 'injected_active', mode: 'steer' }, execute);
    expect(execute.mock.calls[0][1][6]).toBe(false);
  });

  it('keeps missing rows and database failures outside legacy delivery failures', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await expect(settleDeliveryShadow(
      { deliveryId: 'missing', state: 'started_turn', mode: 'new-turn' },
      vi.fn().mockResolvedValue({ changes: 0 }),
    )).resolves.toBe(false);
    await expect(settleDeliveryShadow(
      { deliveryId: 'broken', state: 'failed', mode: 'new-turn', error: 'boom' },
      vi.fn().mockRejectedValue(new Error('db unavailable')),
    )).resolves.toBe(false);
    expect(warn).toHaveBeenCalledTimes(2);
    warn.mockRestore();
  });
});

import { describe, expect, it } from 'vitest';
import type { WebhookVerifier } from './contract.js';
import { webhookPayloadHash } from './contract.js';

describe('Webhook provider contract', () => {
  it('supports provider-specific verification without Provider read credentials', () => {
    const slackStyle: WebhookVerifier = {
      provider: 'slack',
      verify: () => ({ ok: true, event: { provider: 'slack', deliveryId: 'event-1', eventType: 'event_callback', action: 'message', occurredAt: 1, resourceId: 'message-1' } }),
    };
    expect(slackStyle.verify({ request: { get: () => undefined } as any, rawBody: Buffer.from('{}') }))
      .toMatchObject({ ok: true, event: { provider: 'slack', deliveryId: 'event-1' } });
  });
  it('hashes exact raw bytes for dedupe conflict detection', () => {
    expect(webhookPayloadHash(Buffer.from('{"a":1}'))).not.toBe(webhookPayloadHash(Buffer.from('{"a": 1}')));
  });
});

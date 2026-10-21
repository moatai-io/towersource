import { describe, expect, it, vi } from 'vitest';
import { WebhookEventStore } from './store.js';
function pool(rowsByCall: any[][]) { let i = 0; return { query: vi.fn(async () => ({ rows: rowsByCall[i++] || [] })) } as any; }
const row = { id: 'r1', connector_id: 'linear-main', provider: 'linear', delivery_id: 'd1', payload_hash: 'h1', status: 'queued' };
const event = { provider: 'linear', deliveryId: 'd1', eventType: 'Issue', action: 'update', occurredAt: 1, resourceId: 'i1' };

describe('WebhookEventStore admission', () => {
  it('queues a normalized event once', async () => {
    const store = new WebhookEventStore(pool([[row]]));
    await expect(store.admit({ connectorId: 'linear-main', event, payloadHash: 'h1' }))
      .resolves.toMatchObject({ duplicate: false, conflict: false, receipt: { status: 'queued' } });
  });
  it('returns a durable exact replay without another execution', async () => {
    const store = new WebhookEventStore(pool([[], [row]]));
    await expect(store.admit({ connectorId: 'linear-main', event, payloadHash: 'h1' }))
      .resolves.toMatchObject({ duplicate: true, conflict: false });
  });
  it('detects a delivery id reused with different raw bytes', async () => {
    const store = new WebhookEventStore(pool([[], [row]]));
    await expect(store.admit({ connectorId: 'linear-main', event, payloadHash: 'other' }))
      .resolves.toMatchObject({ duplicate: true, conflict: true });
  });
});

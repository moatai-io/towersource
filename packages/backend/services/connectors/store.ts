import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import type { CanonicalWebhookEvent, WebhookEventStatus } from './contract.js';

export interface WebhookEventReceipt {
  id: string; connectorId: string; provider: string; deliveryId: string; payloadHash: string;
  status: WebhookEventStatus; taskId: string | null; route: string | null; reason: string | null;
}
export interface ClaimedWebhookEvent extends WebhookEventReceipt {
  claimId: string; event: CanonicalWebhookEvent; attempts: number;
}
function receipt(row: any): WebhookEventReceipt {
  return { id: row.id, connectorId: row.connector_id, provider: row.provider, deliveryId: row.delivery_id,
    payloadHash: row.payload_hash, status: row.status, taskId: row.task_id || null,
    route: row.route || null, reason: row.reason || null };
}

export class WebhookEventStore {
  constructor(private readonly pool: Pool) {}

  async admit(input: { connectorId: string; event: CanonicalWebhookEvent; payloadHash: string }): Promise<{ receipt: WebhookEventReceipt; duplicate: boolean; conflict: boolean }> {
    const inserted = await this.pool.query(`INSERT INTO webhook_events
      (id, connector_id, provider, delivery_id, payload_hash, event_type, action, resource_id, normalized_event, status)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,'queued')
      ON CONFLICT (connector_id, delivery_id) DO NOTHING RETURNING *`,
      [randomUUID(), input.connectorId, input.event.provider, input.event.deliveryId, input.payloadHash,
        input.event.eventType, input.event.action, input.event.resourceId, JSON.stringify(input.event)]);
    if (inserted.rows[0]) return { receipt: receipt(inserted.rows[0]), duplicate: false, conflict: false };
    const existing = await this.pool.query('SELECT * FROM webhook_events WHERE connector_id = $1 AND delivery_id = $2', [input.connectorId, input.event.deliveryId]);
    if (!existing.rows[0]) throw new Error('webhook_event_admission_failed');
    return { receipt: receipt(existing.rows[0]), duplicate: true, conflict: existing.rows[0].payload_hash !== input.payloadHash };
  }

  async claim(): Promise<ClaimedWebhookEvent | null> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`UPDATE webhook_events SET status='needs_review', reason='dispatch_lease_expired', claim_id=NULL,
        claim_until=NULL, updated_at=NOW() WHERE status='dispatching' AND claim_until < NOW()`);
      const selected = await client.query(`SELECT * FROM webhook_events WHERE status='queued' AND next_attempt_at <= NOW()
        ORDER BY received_at FOR UPDATE SKIP LOCKED LIMIT 1`);
      const row = selected.rows[0];
      if (!row) { await client.query('COMMIT'); return null; }
      const claimId = randomUUID();
      const updated = await client.query(`UPDATE webhook_events SET status='dispatching', attempts=attempts+1,
        claim_id=$2, claim_until=NOW()+INTERVAL '2 minutes', updated_at=NOW() WHERE id=$1 RETURNING *`, [row.id, claimId]);
      await client.query('COMMIT');
      const claimed = updated.rows[0];
      return { ...receipt(claimed), claimId, attempts: claimed.attempts,
        event: claimed.normalized_event as CanonicalWebhookEvent };
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
  }

  async settle(claim: ClaimedWebhookEvent, update: { status: Exclude<WebhookEventStatus, 'queued' | 'dispatching'>; taskId?: string; route?: string; reason?: string; resourceKey?: string }): Promise<void> {
    const result = await this.pool.query(`UPDATE webhook_events SET status=$3, task_id=$4, route=$5, reason=$6,
      resource_key=COALESCE($7,resource_key), claim_id=NULL, claim_until=NULL, dispatched_at=NOW(), updated_at=NOW()
      WHERE id=$1 AND claim_id=$2 AND status='dispatching'`, [claim.id, claim.claimId, update.status,
      update.taskId || null, update.route || null, update.reason || null, update.resourceKey || null]);
    if (result.rowCount !== 1) throw new Error('webhook_dispatch_claim_lost');
  }
}

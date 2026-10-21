import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { FeedbackError, payloadDigest, type Delivery, type IntakeStore, type Receipt, type Submission, type Tenant } from './contract.js';

type Row = Record<string, any>;
function receipt(row: Row): Receipt {
  return { id: row.id, status: row.status,
    ...(row.issue_number ? { issueNumber: Number(row.issue_number), issueUrl: row.issue_url } : {}) };
}
function tenant(row: Row): Tenant { return { id: row.id, titlePrefix: row.title_prefix, label: row.label }; }

export class PgIntakeStore implements IntakeStore {
  constructor(private readonly pool: Pool) {}
  private async transaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try { await client.query('BEGIN'); const result = await fn(client); await client.query('COMMIT'); return result; }
    catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
  }
  async authenticate(tokenHash: string): Promise<Tenant | null> {
    const { rows } = await this.pool.query('SELECT id, title_prefix, label FROM feedback_tenants WHERE token_hash = $1 AND active = true', [tokenHash]);
    return rows[0] ? tenant(rows[0]) : null;
  }
  async accept(customer: Tenant, key: string, payload: Submission): Promise<Receipt> {
    return this.transaction(async client => {
      // Serialize admission per customer, including rate limits and concurrent replay.
      const { rows: customers } = await client.query('SELECT * FROM feedback_tenants WHERE id = $1 AND active = true FOR UPDATE', [customer.id]);
      if (!customers[0]) throw new FeedbackError('feedback_unauthorized', 401);
      const hash = payloadDigest(payload);
      const existing = await client.query('SELECT * FROM feedback_receipts WHERE tenant_id = $1 AND idempotency_key = $2', [customer.id, key]);
      if (existing.rows[0]) {
        if (existing.rows[0].request_hash !== hash) throw new FeedbackError('feedback_idempotency_conflict', 409);
        return receipt(existing.rows[0]);
      }
      const allowed = await client.query(`UPDATE feedback_tenants SET
        rate_count = CASE WHEN rate_window <= now() - interval '1 minute' THEN 1 ELSE rate_count + 1 END,
        rate_window = CASE WHEN rate_window <= now() - interval '1 minute' THEN now() ELSE rate_window END
        WHERE id = $1 AND (rate_window <= now() - interval '1 minute' OR rate_count < 20) RETURNING id`, [customer.id]);
      if (!allowed.rowCount) throw new FeedbackError('feedback_rate_limited', 429);
      const { rows } = await client.query(`INSERT INTO feedback_receipts
        (id, tenant_id, idempotency_key, request_hash, reporter_user_id, payload)
        VALUES ($1, $2, $3, $4, $5, $6::jsonb) RETURNING *`, [randomUUID(), customer.id, key, hash, payload.reporter.userId, JSON.stringify(payload)]);
      return receipt(rows[0]);
    });
  }
  async status(tenantId: string, id: string, userId: number): Promise<Receipt | null> {
    const { rows } = await this.pool.query('SELECT * FROM feedback_receipts WHERE tenant_id = $1 AND id = $2 AND reporter_user_id = $3', [tenantId, id, userId]);
    return rows[0] ? receipt(rows[0]) : null;
  }
  async claim(): Promise<Delivery | null> {
    return this.transaction(async client => {
      // Process death could have happened after GitHub accepted the create. Never requeue blindly.
      await client.query(`UPDATE feedback_receipts SET status = 'needs_review', last_error_code = 'delivery_lease_expired',
        updated_at = now() WHERE status = 'delivering' AND claim_until < now()`);
      const { rows } = await client.query(`SELECT r.*, t.title_prefix, t.label FROM feedback_receipts r
        JOIN feedback_tenants t ON t.id = r.tenant_id AND t.active = true
        WHERE r.status = 'accepted' AND r.next_attempt_at <= now()
        ORDER BY r.created_at FOR UPDATE OF r SKIP LOCKED LIMIT 1`);
      const row = rows[0]; if (!row) return null;
      const claimId = randomUUID();
      await client.query(`UPDATE feedback_receipts SET status = 'delivering', attempts = attempts + 1,
        claim_id = $2, claim_until = now() + interval '2 minutes', updated_at = now() WHERE id = $1`, [row.id, claimId]);
      return { id: row.id, tenant: { id: row.tenant_id, titlePrefix: row.title_prefix, label: row.label },
        payload: row.payload, attempts: row.attempts + 1, claimId };
    });
  }
  async settle(delivery: Delivery, outcome: Parameters<IntakeStore['settle']>[1]): Promise<void> {
    const { rowCount } = await this.pool.query(`UPDATE feedback_receipts SET status = $3, last_error_code = $4,
      issue_number = $5, issue_url = $6, claim_until = NULL, updated_at = now(),
      next_attempt_at = now() + ($7 * interval '1 second')
      WHERE id = $1 AND claim_id = $2 AND status = 'delivering'`, [delivery.id, delivery.claimId,
      outcome.status, outcome.code ?? null, outcome.issueNumber ?? null, outcome.issueUrl ?? null,
      Math.min(3600, 30 * 2 ** delivery.attempts)]);
    if (rowCount !== 1) throw new FeedbackError('feedback_claim_lost');
  }
}

/**
 * Owns: Fenced lease claims for durable Agent message delivery attempts.
 * Public API: claimNextDelivery, renewDeliveryClaim, settleClaimedDelivery.
 * See README.md.
 */

import { randomUUID } from 'node:crypto';
import { queryOne, execute } from '../../db/pg-repo.js';

export interface DeliveryClaim {
  deliveryId: string;
  messageId: string;
  recipientSessionId: string;
  ownerToken: string;
  ownerBootId: string;
  attemptCount: number;
  leaseUntil: string;
}

interface DeliveryClaimRow {
  id: string;
  message_id: string;
  recipient_session_id: string;
  owner_token: string;
  owner_boot_id: string;
  attempt_count: number;
  lease_until: string;
}

function boundedLeaseSeconds(value: number | undefined): number {
  return Math.max(15, Math.min(Math.trunc(value ?? 60), 300));
}

/** Claim one known pending delivery before its legacy-compatible execution path starts. */
export async function claimDeliveryById(input: {
  deliveryId: string;
  ownerBootId: string;
  leaseSeconds?: number;
}): Promise<DeliveryClaim | undefined> {
  const ownerToken = randomUUID();
  const row = await queryOne<DeliveryClaimRow>(
    `UPDATE agent_message_deliveries
        SET state = 'claimed', owner_token = $2, owner_boot_id = $3,
            lease_until = NOW() + ($4::int * INTERVAL '1 second'),
            next_attempt_at = NULL, attempt_count = attempt_count + 1, updated_at = NOW()
      WHERE id = $1 AND state IN ('pending', 'retry_wait')
        AND (next_attempt_at IS NULL OR next_attempt_at <= NOW())
      RETURNING id, message_id, recipient_session_id, owner_token, owner_boot_id,
                attempt_count, lease_until::text`,
    [input.deliveryId, ownerToken, input.ownerBootId, boundedLeaseSeconds(input.leaseSeconds)],
  );
  return row ? {
    deliveryId: row.id, messageId: row.message_id, recipientSessionId: row.recipient_session_id,
    ownerToken: row.owner_token, ownerBootId: row.owner_boot_id,
    attemptCount: Number(row.attempt_count), leaseUntil: row.lease_until,
  } : undefined;
}

/** Claim the oldest due delivery for one recipient, fencing concurrent workers with SKIP LOCKED. */
export async function claimNextDelivery(input: {
  recipientSessionId: string;
  ownerBootId: string;
  leaseSeconds?: number;
}): Promise<DeliveryClaim | undefined> {
  const ownerToken = randomUUID();
  const leaseSeconds = boundedLeaseSeconds(input.leaseSeconds);
  const row = await queryOne<DeliveryClaimRow>(
    `WITH candidate AS (
       SELECT id
         FROM agent_message_deliveries
        WHERE recipient_session_id = $1
          AND state IN ('pending', 'retry_wait')
          AND (next_attempt_at IS NULL OR next_attempt_at <= NOW())
        ORDER BY created_at ASC, id ASC
        FOR UPDATE SKIP LOCKED
        LIMIT 1
     ), claimed AS (
       UPDATE agent_message_deliveries d
          SET state = 'claimed', owner_token = $2, owner_boot_id = $3,
              lease_until = NOW() + ($4::int * INTERVAL '1 second'),
              next_attempt_at = NULL, attempt_count = attempt_count + 1, updated_at = NOW()
         FROM candidate
        WHERE d.id = candidate.id
        RETURNING d.id, d.message_id, d.recipient_session_id, d.owner_token,
                  d.owner_boot_id, d.attempt_count, d.lease_until::text
     ) SELECT * FROM claimed`,
    [input.recipientSessionId, ownerToken, input.ownerBootId, leaseSeconds],
  );
  return row ? {
    deliveryId: row.id,
    messageId: row.message_id,
    recipientSessionId: row.recipient_session_id,
    ownerToken: row.owner_token,
    ownerBootId: row.owner_boot_id,
    attemptCount: Number(row.attempt_count),
    leaseUntil: row.lease_until,
  } : undefined;
}

/** Quarantine ambiguous in-flight claims after a backend restart instead of replaying possible side effects. */
export async function quarantineClaimsFromPreviousBoot(ownerBootId: string): Promise<number> {
  const result = await execute(
    `UPDATE agent_message_deliveries
        SET state = 'needs_attention', owner_token = NULL, owner_boot_id = NULL,
            lease_until = NULL, failure_class = 'ambiguous_after_restart',
            last_error = 'Delivery was claimed by a previous backend boot; automatic replay is disabled',
            completed_at = NOW(), updated_at = NOW()
      WHERE state = 'claimed' AND owner_boot_id IS DISTINCT FROM $1`,
    [ownerBootId],
  );
  return result.changes;
}

/** Renew an active delivery claim only when both token and boot identity still own it. */
export async function renewDeliveryClaim(input: {
  deliveryId: string;
  ownerToken: string;
  ownerBootId: string;
  leaseSeconds?: number;
}): Promise<boolean> {
  const result = await execute(
    `UPDATE agent_message_deliveries
        SET lease_until = NOW() + ($4::int * INTERVAL '1 second'), updated_at = NOW()
      WHERE id = $1 AND owner_token = $2 AND owner_boot_id = $3 AND state = 'claimed'`,
    [input.deliveryId, input.ownerToken, input.ownerBootId, boundedLeaseSeconds(input.leaseSeconds)],
  );
  return result.changes === 1;
}

/** Mark the point where the recipient engine has actually entered its turn. */
export async function markClaimedDeliveryStarted(input: {
  deliveryId: string;
  ownerToken: string;
  ownerBootId: string;
  mode?: 'steer' | 'queued-after-turn' | 'new-turn' | 'stored' | 'held' | 'refused';
  recipientRootTurnId?: string;
}): Promise<boolean> {
  const result = await execute(
    `UPDATE agent_message_deliveries
        SET state = 'started_turn',
            delivery_mode_used = COALESCE($4, delivery_mode_used),
            recipient_root_turn_id = COALESCE($5, recipient_root_turn_id),
            updated_at = NOW()
      WHERE id = $1 AND owner_token = $2 AND owner_boot_id = $3
        AND state = 'claimed'`,
    [input.deliveryId, input.ownerToken, input.ownerBootId, input.mode ?? null, input.recipientRootTurnId ?? null],
  );
  return result.changes === 1;
}

/** Settle or reschedule a claimed delivery; stale owners cannot mutate the row. */
export async function settleClaimedDelivery(input: {
  deliveryId: string;
  ownerToken: string;
  ownerBootId: string;
  state: 'completed' | 'retry_wait' | 'failed' | 'needs_attention';
  mode?: 'steer' | 'queued-after-turn' | 'new-turn' | 'stored' | 'held' | 'refused';
  recipientRootTurnId?: string;
  responseMessageId?: string;
  failureClass?: string;
  error?: string;
  retryDelaySeconds?: number;
}): Promise<boolean> {
  const retryDelaySeconds = Math.max(1, Math.min(Math.trunc(input.retryDelaySeconds ?? 20), 300));
  const result = await execute(
    `UPDATE agent_message_deliveries
        SET state = $4,
            owner_token = NULL, owner_boot_id = NULL, lease_until = NULL,
            delivery_mode_used = COALESCE($5, delivery_mode_used),
            recipient_root_turn_id = COALESCE($6, recipient_root_turn_id),
            response_message_id = COALESCE($7, response_message_id),
            failure_class = $8, last_error = $9,
            next_attempt_at = CASE WHEN $4 = 'retry_wait'
              THEN NOW() + ($10::int * INTERVAL '1 second') ELSE NULL END,
            completed_at = CASE WHEN $4 IN ('completed', 'failed', 'needs_attention')
              THEN NOW() ELSE completed_at END,
            updated_at = NOW()
      WHERE id = $1 AND owner_token = $2 AND owner_boot_id = $3
        AND state IN ('claimed', 'started_turn', 'processing', 'responded')`,
    [
      input.deliveryId, input.ownerToken, input.ownerBootId, input.state, input.mode ?? null,
      input.recipientRootTurnId ?? null, input.responseMessageId ?? null,
      input.failureClass ?? null, input.error?.slice(0, 2000) ?? null, retryDelaySeconds,
    ],
  );
  return result.changes === 1;
}

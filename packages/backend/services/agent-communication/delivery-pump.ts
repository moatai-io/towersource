/**
 * Owns: Process-local doorbell and periodic recovery pump for durable Agent inbox deliveries.
 * Public API: startDeliveryPump, stopDeliveryPump, notifyRecipientInbox.
 * See README.md.
 */

import { config } from '../../config.js';
import { query } from '../../db/pg-repo.js';
import { processRecipientInbox, type ProcessRecipientInboxDependencies } from './delivery-controller.js';
import { quarantineClaimsFromPreviousBoot } from './delivery-lease-store.js';

let timer: ReturnType<typeof setInterval> | undefined;
let dependencies: Partial<ProcessRecipientInboxDependencies> = {};
const activeRecipients = new Set<string>();

async function dueRecipients(limit = 50): Promise<string[]> {
  const rows = await query<{ recipient_session_id: string }>(
    `SELECT recipient_session_id
       FROM agent_message_deliveries
      WHERE state IN ('pending', 'retry_wait')
        AND (next_attempt_at IS NULL OR next_attempt_at <= NOW())
      GROUP BY recipient_session_id
      ORDER BY MIN(created_at)
      LIMIT $1`,
    [limit],
  );
  return rows.map(row => row.recipient_session_id);
}

async function drainRecipient(recipientSessionId: string): Promise<void> {
  if (activeRecipients.has(recipientSessionId)) return;
  activeRecipients.add(recipientSessionId);
  try {
    for (let processed = 0; processed < 20; processed += 1) {
      const result = await processRecipientInbox({
        recipientSessionId,
        ownerBootId: config.serverEpoch,
        leaseSeconds: 180,
      }, dependencies);
      if (result.outcome === 'idle' || result.outcome === 'claim_lost') break;
    }
  } catch (error) {
    console.warn(`[agent-communication] inbox drain failed for ${recipientSessionId.slice(0, 8)}:`, error);
  } finally {
    activeRecipients.delete(recipientSessionId);
  }
}

async function sweep(): Promise<void> {
  try {
    const recipients = await dueRecipients();
    await Promise.all(recipients.map(drainRecipient));
  } catch (error) {
    console.warn('[agent-communication] delivery sweep failed:', error);
  }
}

/** Notify the process that one recipient may have due durable work. PostgreSQL remains authoritative. */
export function notifyRecipientInbox(recipientSessionId: string): void {
  queueMicrotask(() => { void drainRecipient(recipientSessionId); });
}

/** Start restart reconciliation plus the periodic retry/recovery doorbell. */
export async function startDeliveryPump(input: {
  dependencies: Partial<ProcessRecipientInboxDependencies>;
  intervalMs?: number;
}): Promise<void> {
  dependencies = input.dependencies;
  if (timer) return;
  const quarantined = await quarantineClaimsFromPreviousBoot(config.serverEpoch);
  if (quarantined > 0) {
    console.warn(`[agent-communication] quarantined ${quarantined} ambiguous delivery claim(s) after restart`);
  }
  await sweep();
  timer = setInterval(() => { void sweep(); }, Math.max(1_000, input.intervalMs ?? 10_000));
  timer.unref?.();
}

/** Stop the periodic doorbell; active claims remain fenced in PostgreSQL. */
export function stopDeliveryPump(): void {
  if (timer) clearInterval(timer);
  timer = undefined;
  dependencies = {};
}

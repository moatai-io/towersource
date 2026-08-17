/**
 * Owns: Best-effort settlement of legacy delivery observations into the durable inbox shadow.
 * Public API: settleDeliveryShadow.
 * See README.md.
 */

import { execute } from '../../db/pg-repo.js';

export type ShadowDeliveryState = 'pending' | 'injected_active' | 'started_turn' | 'completed' | 'failed';
export type ShadowDeliveryMode = 'steer' | 'queued-after-turn' | 'new-turn' | 'stored';

export interface SettleDeliveryShadowInput {
  deliveryId: string;
  state: ShadowDeliveryState;
  mode: ShadowDeliveryMode;
  recipientRootTurnId?: string;
  responseMessageId?: string;
  error?: string;
}

type Execute = typeof execute;

/** Record observed legacy delivery progress without affecting legacy success or failure. */
export async function settleDeliveryShadow(
  input: SettleDeliveryShadowInput,
  runExecute: Execute = execute,
): Promise<boolean> {
  try {
    const terminal = input.state === 'completed' || input.state === 'failed';
    const result = await runExecute(
      `UPDATE agent_message_deliveries
          SET state = $2,
              delivery_mode_used = $3,
              recipient_root_turn_id = COALESCE($4, recipient_root_turn_id),
              response_message_id = COALESCE($5, response_message_id),
              last_error = $6,
              updated_at = NOW(),
              completed_at = CASE WHEN $7 THEN NOW() ELSE completed_at END
        WHERE id = $1`,
      [
        input.deliveryId,
        input.state,
        input.mode,
        input.recipientRootTurnId ?? null,
        input.responseMessageId ?? null,
        input.error ?? null,
        terminal,
      ],
    );
    if (result.changes === 0) {
      console.warn(`[agent-communication] delivery shadow row missing: ${input.deliveryId}`);
      return false;
    }
    return true;
  } catch (error) {
    console.warn(`[agent-communication] delivery shadow settlement failed for ${input.deliveryId}:`, error);
    return false;
  }
}

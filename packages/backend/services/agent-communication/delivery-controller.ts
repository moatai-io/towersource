/**
 * Owns: Explicit, dependency-injected processing of one durable recipient inbox delivery.
 * Public API: processRecipientInbox.
 * See README.md.
 */

import { claimNextDelivery, markClaimedDeliveryStarted, settleClaimedDelivery, type DeliveryClaim } from './delivery-lease-store.js';
import { getAgentMessage, type AgentMessageRecord } from './inbox-store.js';

export type DeliveryPolicyDecision =
  | { action: 'deliver' }
  | { action: 'hold'; reason: string }
  | { action: 'refuse'; reason: string };

export type DeliveryHandlerOutcome =
  | { status: 'started_turn'; mode: 'steer' | 'queued-after-turn' | 'new-turn'; recipientRootTurnId?: string; alreadyMarked?: boolean }
  | { status: 'completed'; mode: 'steer' | 'queued-after-turn' | 'new-turn' | 'stored'; recipientRootTurnId?: string; responseMessageId?: string }
  | { status: 'retry'; reason: string; retryDelaySeconds?: number }
  | { status: 'needs_attention'; reason: string };

export interface ProcessRecipientInboxDependencies {
  claimNext: typeof claimNextDelivery;
  getMessage: typeof getAgentMessage;
  markStarted: typeof markClaimedDeliveryStarted;
  settleClaim: typeof settleClaimedDelivery;
  decidePolicy(message: AgentMessageRecord): Promise<DeliveryPolicyDecision>;
  deliver(message: AgentMessageRecord, claim: DeliveryClaim): Promise<DeliveryHandlerOutcome>;
}

export interface InboxProcessSummary {
  outcome: 'idle' | 'started_turn' | 'completed' | 'held' | 'refused' | 'retry_wait' | 'needs_attention' | 'claim_lost';
  messageId?: string;
  deliveryId?: string;
}

const defaultDependencies: ProcessRecipientInboxDependencies = {
  claimNext: claimNextDelivery,
  getMessage: getAgentMessage,
  markStarted: markClaimedDeliveryStarted,
  settleClaim: settleClaimedDelivery,
  decidePolicy: async () => ({ action: 'deliver' }),
  deliver: async () => ({ status: 'needs_attention', reason: 'No delivery adapter configured' }),
};

/**
 * Process at most one due delivery for a recipient.
 * This function is never scheduled automatically; callers explicitly supply authority and adapters.
 */
export async function processRecipientInbox(input: {
  recipientSessionId: string;
  ownerBootId: string;
  leaseSeconds?: number;
}, dependencies: Partial<ProcessRecipientInboxDependencies> = {}): Promise<InboxProcessSummary> {
  const deps = { ...defaultDependencies, ...dependencies };
  const claim = await deps.claimNext(input);
  if (!claim) return { outcome: 'idle' };

  const message = await deps.getMessage(claim.messageId);
  if (!message) {
    const settled = await deps.settleClaim({
      deliveryId: claim.deliveryId, ownerToken: claim.ownerToken, ownerBootId: claim.ownerBootId,
      state: 'needs_attention', failureClass: 'message_missing', error: 'Claimed delivery references a missing Agent message',
    });
    return { outcome: settled ? 'needs_attention' : 'claim_lost', messageId: claim.messageId, deliveryId: claim.deliveryId };
  }

  if (message.deliveryPolicy === 'store-only') {
    const settled = await deps.settleClaim({
      deliveryId: claim.deliveryId, ownerToken: claim.ownerToken, ownerBootId: claim.ownerBootId,
      state: 'completed', mode: 'stored',
    });
    return { outcome: settled ? 'completed' : 'claim_lost', messageId: message.id, deliveryId: claim.deliveryId };
  }

  const decision = await deps.decidePolicy(message);
  if (decision.action === 'hold' || decision.action === 'refuse') {
    const refused = decision.action === 'refuse';
    const settled = await deps.settleClaim({
      deliveryId: claim.deliveryId, ownerToken: claim.ownerToken, ownerBootId: claim.ownerBootId,
      state: refused ? 'failed' : 'needs_attention', mode: refused ? 'refused' : 'held',
      failureClass: refused ? 'policy_refused' : 'policy_held', error: decision.reason,
    });
    return {
      outcome: settled ? (refused ? 'refused' : 'held') : 'claim_lost',
      messageId: message.id, deliveryId: claim.deliveryId,
    };
  }

  let delivery: DeliveryHandlerOutcome;
  try {
    delivery = await deps.deliver(message, claim);
  } catch (error) {
    delivery = { status: 'retry', reason: (error as Error).message || String(error) };
  }

  if (delivery.status === 'started_turn') {
    const marked = delivery.alreadyMarked || await deps.markStarted({
      deliveryId: claim.deliveryId, ownerToken: claim.ownerToken, ownerBootId: claim.ownerBootId,
      mode: delivery.mode, recipientRootTurnId: delivery.recipientRootTurnId,
    });
    return { outcome: marked ? 'started_turn' : 'claim_lost', messageId: message.id, deliveryId: claim.deliveryId };
  }

  if (delivery.status === 'completed') {
    const settled = await deps.settleClaim({
      deliveryId: claim.deliveryId, ownerToken: claim.ownerToken, ownerBootId: claim.ownerBootId,
      state: 'completed', mode: delivery.mode, recipientRootTurnId: delivery.recipientRootTurnId,
      responseMessageId: delivery.responseMessageId,
    });
    return { outcome: settled ? 'completed' : 'claim_lost', messageId: message.id, deliveryId: claim.deliveryId };
  }

  if (delivery.status === 'needs_attention') {
    const settled = await deps.settleClaim({
      deliveryId: claim.deliveryId, ownerToken: claim.ownerToken, ownerBootId: claim.ownerBootId,
      state: 'needs_attention', failureClass: 'delivery_needs_attention', error: delivery.reason,
    });
    return { outcome: settled ? 'needs_attention' : 'claim_lost', messageId: message.id, deliveryId: claim.deliveryId };
  }

  const settled = await deps.settleClaim({
    deliveryId: claim.deliveryId, ownerToken: claim.ownerToken, ownerBootId: claim.ownerBootId,
    state: 'retry_wait', failureClass: 'delivery_retry', error: delivery.reason,
    retryDelaySeconds: delivery.retryDelaySeconds,
  });
  return { outcome: settled ? 'retry_wait' : 'claim_lost', messageId: message.id, deliveryId: claim.deliveryId };
}

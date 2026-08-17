/**
 * Owns: Atomic persistence of durable Agent messages and initial delivery attempts.
 * Public API: acceptAgentMessage, getAgentMessage, listAgentInbox.
 * See README.md.
 */

import { transaction, withClient, query, queryOne } from '../../db/pg-repo.js';
import { normalizeAgentMessageEnvelope, type AgentMessageEnvelopeInput } from './message-envelope.js';

export interface AcceptedAgentMessage {
  messageId: string;
  deliveryId: string;
  acceptedAt: string;
  duplicate: boolean;
}

export interface AgentMessageRecord {
  id: string;
  senderSessionId: string;
  recipientSessionId: string;
  senderUserId: number | null;
  projectId: string | null;
  kind: string;
  body: Record<string, unknown>;
  deliveryPolicy: string;
  priority: string;
  correlationId: string;
  causationId: string | null;
  inReplyToMessageId: string | null;
  rootConversationId: string;
  workerId: string | null;
  agentRunId: string | null;
  sourceRootTurnId: string | null;
  operationId: string | null;
  status: string;
  createdAt: string;
  expiresAt: string | null;
}

interface AgentMessageRow {
  id: string;
  sender_session_id: string;
  recipient_session_id: string;
  sender_user_id: number | null;
  project_id: string | null;
  kind: string;
  body: Record<string, unknown>;
  delivery_policy: string;
  priority: string;
  correlation_id: string;
  causation_id: string | null;
  in_reply_to_message_id: string | null;
  root_conversation_id: string;
  worker_id: string | null;
  agent_run_id: string | null;
  source_root_turn_id: string | null;
  operation_id: string | null;
  status: string;
  created_at: string;
  expires_at: string | null;
}

function toRecord(row: AgentMessageRow): AgentMessageRecord {
  return {
    id: row.id,
    senderSessionId: row.sender_session_id,
    recipientSessionId: row.recipient_session_id,
    senderUserId: row.sender_user_id,
    projectId: row.project_id,
    kind: row.kind,
    body: row.body,
    deliveryPolicy: row.delivery_policy,
    priority: row.priority,
    correlationId: row.correlation_id,
    causationId: row.causation_id,
    inReplyToMessageId: row.in_reply_to_message_id,
    rootConversationId: row.root_conversation_id,
    workerId: row.worker_id,
    agentRunId: row.agent_run_id,
    sourceRootTurnId: row.source_root_turn_id,
    operationId: row.operation_id,
    status: row.status,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
  };
}

/** Atomically accept one envelope and create its first pending delivery attempt. */
export async function acceptAgentMessage(input: AgentMessageEnvelopeInput): Promise<AcceptedAgentMessage> {
  const envelope = normalizeAgentMessageEnvelope(input);
  return transaction(async client => {
    const db = withClient(client);
    const inserted = await db.queryOne<{ id: string; created_at: string }>(
      `INSERT INTO agent_messages
         (id, sender_session_id, recipient_session_id, sender_user_id, project_id,
          kind, body, delivery_policy, priority, correlation_id, causation_id,
          in_reply_to_message_id, root_conversation_id, worker_id, agent_run_id,
          source_root_turn_id, operation_id, status, expires_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,'accepted',$18)
       ON CONFLICT DO NOTHING
       RETURNING id, created_at::text`,
      [
        envelope.id, envelope.senderSessionId, envelope.recipientSessionId, envelope.senderUserId,
        envelope.projectId ?? null, envelope.kind, JSON.stringify(envelope.body), envelope.deliveryPolicy,
        envelope.priority, envelope.correlationId, envelope.causationId ?? null,
        envelope.inReplyToMessageId ?? null, envelope.rootConversationId, envelope.workerId ?? null,
        envelope.agentRunId ?? null, envelope.sourceRootTurnId ?? null, envelope.operationId ?? null,
        envelope.expiresAt ?? null,
      ],
    );

    if (!inserted) {
      const existing = await db.queryOne<{ id: string; created_at: string }>(
        `SELECT id, created_at::text FROM agent_messages
          WHERE id = $1 OR (sender_session_id = $2 AND operation_id = $3)
          ORDER BY (id = $1) DESC
          LIMIT 1`,
        [envelope.id, envelope.senderSessionId, envelope.operationId ?? null],
      );
      if (!existing) throw new Error('Agent message acceptance conflicted without a durable message');
      const delivery = await db.queryOne<{ id: string }>(
        `SELECT id FROM agent_message_deliveries WHERE message_id = $1 ORDER BY attempt_count LIMIT 1`,
        [existing.id],
      );
      if (!delivery) throw new Error('Durable Agent message exists without an initial delivery');
      return { messageId: existing.id, deliveryId: delivery.id, acceptedAt: existing.created_at, duplicate: true };
    }

    const deliveryId = `${envelope.id}:0`;
    await db.execute(
      `INSERT INTO agent_message_deliveries
         (id, message_id, recipient_session_id, state, attempt_count, next_attempt_at)
       VALUES ($1,$2,$3,'pending',0,NOW())`,
      [deliveryId, envelope.id, envelope.recipientSessionId],
    );
    return { messageId: envelope.id, deliveryId, acceptedAt: inserted.created_at, duplicate: false };
  });
}

/** Read one durable Agent message by identity. */
export async function getAgentMessage(messageId: string): Promise<AgentMessageRecord | undefined> {
  const row = await queryOne<AgentMessageRow>('SELECT * FROM agent_messages WHERE id = $1', [messageId]);
  return row ? toRecord(row) : undefined;
}

/** List a recipient inbox in stable acceptance order. */
export async function listAgentInbox(recipientSessionId: string, limit = 50): Promise<AgentMessageRecord[]> {
  const boundedLimit = Math.max(1, Math.min(200, Math.trunc(limit)));
  const rows = await query<AgentMessageRow>(
    `SELECT * FROM agent_messages
      WHERE recipient_session_id = $1
      ORDER BY created_at ASC, id ASC
      LIMIT $2`,
    [recipientSessionId, boundedLimit],
  );
  return rows.map(toRecord);
}

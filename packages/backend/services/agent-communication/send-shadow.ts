/**
 * Owns: Projection of the legacy Session send contract into the durable inbox shadow.
 * Public API: recordSessionSendShadow.
 * See README.md.
 */

import { v4 as uuidv4 } from 'uuid';
import { acceptAgentMessage, type AcceptedAgentMessage } from './inbox-store.js';

export interface SessionSendShadowInput {
  senderSessionId: string;
  recipientSessionId: string;
  senderUserId: number;
  projectId?: string | null;
  text: string;
  renderedPrompt: string;
  onComplete: 'wake' | 'inject' | 'none';
  sourceRootTurnId: string;
  workerId?: string;
  agentRunId?: string;
}

type AcceptMessage = typeof acceptAgentMessage;

function deliveryPolicyFor(mode: SessionSendShadowInput['onComplete']): 'wake' | 'inject' | 'store-only' {
  return mode === 'none' ? 'store-only' : mode;
}

/**
 * Best-effort shadow write for the existing send pipeline.
 * A shadow outage is observable but cannot widen the legacy send failure surface.
 */
export async function recordSessionSendShadow(
  input: SessionSendShadowInput,
  acceptMessage: AcceptMessage = acceptAgentMessage,
): Promise<AcceptedAgentMessage | undefined> {
  const messageId = uuidv4();
  try {
    return await acceptMessage({
      id: messageId,
      senderSessionId: input.senderSessionId,
      recipientSessionId: input.recipientSessionId,
      senderUserId: input.senderUserId,
      projectId: input.projectId ?? null,
      kind: 'request',
      body: {
        text: input.text,
        renderedPrompt: input.renderedPrompt,
        sourceType: 'agent_send',
      },
      deliveryPolicy: deliveryPolicyFor(input.onComplete),
      priority: 'normal',
      correlationId: messageId,
      rootConversationId: messageId,
      workerId: input.workerId ?? null,
      agentRunId: input.agentRunId ?? null,
      sourceRootTurnId: input.sourceRootTurnId,
      operationId: input.sourceRootTurnId,
    });
  } catch (error) {
    console.warn(
      `[agent-communication] send shadow write failed for ${input.senderSessionId.slice(0, 8)} -> ${input.recipientSessionId.slice(0, 8)}:`,
      error,
    );
    return undefined;
  }
}

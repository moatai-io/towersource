/**
 * Owns: Projection of legacy child completion callbacks into durable Agent reports.
 * Public API: recordCompletionReportShadow.
 * See README.md.
 */

import { v4 as uuidv4 } from 'uuid';
import { acceptAgentMessage, type AcceptedAgentMessage } from './inbox-store.js';

export interface CompletionReportShadowInput {
  spawnId: string;
  senderSessionId: string;
  recipientSessionId: string;
  senderUserId: number;
  projectId?: string | null;
  senderName: string;
  text: string;
  deliveryMode: 'inject-only' | 'inject-and-wake';
  workerId?: string;
  agentRunId?: string;
  detailArtifactPaths?: string[];
}

type AcceptMessage = typeof acceptAgentMessage;

/**
 * Best-effort shadow write for a completed child report.
 * spawnId is the stable operation identity so callback retries reuse one report.
 */
export async function recordCompletionReportShadow(
  input: CompletionReportShadowInput,
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
      kind: 'report',
      body: {
        text: input.text,
        senderName: input.senderName,
        sourceType: 'spawn_completion',
        detailArtifactPaths: input.detailArtifactPaths ?? [],
      },
      deliveryPolicy: input.deliveryMode === 'inject-and-wake' ? 'wake' : 'inject',
      priority: 'normal',
      correlationId: input.spawnId,
      causationId: input.spawnId,
      rootConversationId: input.spawnId,
      workerId: input.workerId ?? null,
      agentRunId: input.agentRunId ?? null,
      operationId: input.spawnId,
    });
  } catch (error) {
    console.warn(
      `[agent-communication] completion shadow write failed for ${input.senderSessionId.slice(0, 8)} -> ${input.recipientSessionId.slice(0, 8)}:`,
      error,
    );
    return undefined;
  }
}

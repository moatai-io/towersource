// Owns: user-facing create-or-continue conversation operations across Tower Sessions.
// Public API: createSessionConversation, sendSessionConversationMessage.
// See workspace/decisions/2026-08-10-all-sessions-are-persistent-addressable-conversations.md.

import {
  sendToSession,
  spawnChildSession,
  type SendOnComplete,
  type SendToSessionRequest,
  type SpawnRequest,
  type SpawnResult,
} from "./spawn-rpc.js";

export interface CreateSessionConversationInput {
  sourceSessionId: string;
  sourceUserId: number;
  sourceUsername?: string;
  sourceRole?: string;
  prompt: string;
  name: string;
  engine?: "claude" | "pi";
  model?: string;
  contextSummary?: string;
  effort?: SpawnRequest["effort"];
  modelPolicyId?: string;
  modelPolicyRevision?: number;
  requestedEffort?: SpawnRequest["requestedEffort"];
  effortDowngraded?: boolean;
  onComplete?: SpawnRequest["onComplete"];
  sourceRootTurnId?: string;
  operationId?: string;
}

export interface SendSessionConversationMessageInput {
  sourceSessionId: string;
  sourceSessionName?: string;
  sourceUserId: number;
  sourceRole?: string;
  targetSessionId: string;
  message: string;
  onComplete?: SendOnComplete;
  agentReport?: SendToSessionRequest["agentReport"];
  effort?: SendToSessionRequest["effort"];
  modelPolicyId?: string;
  modelPolicyRevision?: number;
  requestedEffort?: SendToSessionRequest["requestedEffort"];
  effortDowngraded?: boolean;
}

/** Create an ordinary persistent Session and send its first message. */
export async function createSessionConversation(
  input: CreateSessionConversationInput,
): Promise<SpawnResult> {
  return spawnChildSession({
    parentSessionId: input.sourceSessionId,
    parentUserId: input.sourceUserId,
    parentUsername: input.sourceUsername,
    parentRole: input.sourceRole || "member",
    prompt: input.prompt,
    name: input.name,
    engine: input.engine,
    model: input.model,
    contextSummary: input.contextSummary,
    effort: input.effort,
    modelPolicyId: input.modelPolicyId,
    modelPolicyRevision: input.modelPolicyRevision,
    requestedEffort: input.requestedEffort,
    effortDowngraded: input.effortDowngraded,
    onComplete: input.onComplete,
    rootTurnId: input.sourceRootTurnId,
    operationId: input.operationId,
  });
}

/** Continue any accessible existing Session through the durable Session-message path. */
export async function sendSessionConversationMessage(
  input: SendSessionConversationMessageInput,
): Promise<{ ok: true }> {
  return sendToSession({
    callerSessionId: input.sourceSessionId,
    callerSessionName:
      input.sourceSessionName || `session ${input.sourceSessionId.slice(0, 8)}`,
    callerUserId: input.sourceUserId,
    callerRole: input.sourceRole || "member",
    targetSessionId: input.targetSessionId,
    message: input.message,
    onComplete: input.onComplete,
    agentReport: input.agentReport,
    effort: input.effort,
    modelPolicyId: input.modelPolicyId,
    modelPolicyRevision: input.modelPolicyRevision,
    requestedEffort: input.requestedEffort,
    effortDowngraded: input.effortDowngraded,
  });
}

/**
 * Owns authenticated AI Service Channel turns pinned to the Channel's active Deployment.
 * Public API: createAIServiceChannelConversation, runAIServiceChannelTurn.
 */
import { queryOne } from '../../db/pg-repo.js';
import { assertAIServiceActivationReady } from './activation-gate.js';
import { appendServiceMessage, createActiveChannelConversation } from './ai-service-manager.js';
import { runAIServicePreview, type AIServicePreviewResult } from './ai-service-preview-runtime.js';
import { conversationFilesSnapshot } from './conversation-files.js';

interface ChannelConversationRow {
  service_id: string;
  deployment_id: string;
  channel_id: string;
  tenant_key: string;
  user_key: string;
  status: string;
  channel_status: string;
  active_deployment_id: string | null;
  service_status: string;
  current_deployment_id: string | null;
  deployment_status: string;
}

function requiredKey(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${label} required`);
  if (normalized.length > 200) throw new Error(`${label} exceeds 200 characters`);
  return normalized;
}

/** Create an isolated Conversation from the Channel's current active Deployment. */
export async function createAIServiceChannelConversation(input: {
  serviceId: string;
  channelId: string;
  tenantKey: string;
  userKey: string;
}): Promise<{ id: string; deploymentId: string }> {
  return createActiveChannelConversation({
    ...input,
    tenantKey: requiredKey(input.tenantKey, 'tenantKey'),
    userKey: requiredKey(input.userKey, 'userKey'),
  });
}

/** Execute one authenticated Channel turn through the same pinned runtime used by Preview. */
export async function runAIServiceChannelTurn(input: {
  serviceId: string;
  channelId: string;
  conversationId: string;
  tenantKey: string;
  userKey: string;
  prompt: string;
  userId?: number;
  username?: string;
  userRole?: string;
  onTextUpdate?: (text: string) => void | Promise<void>;
  signal?: AbortSignal;
}): Promise<AIServicePreviewResult> {
  const tenantKey = requiredKey(input.tenantKey, 'tenantKey');
  const userKey = requiredKey(input.userKey, 'userKey');
  const conversation = await queryOne<ChannelConversationRow>(
    `SELECT x.service_id,x.deployment_id,x.channel_id,x.tenant_key,x.user_key,x.status,
            c.status AS channel_status,c.active_deployment_id,s.status AS service_status,
            s.current_deployment_id,d.status AS deployment_status
       FROM ai_service_conversations x
       JOIN ai_service_channels c ON c.id=x.channel_id AND c.service_id=x.service_id
       JOIN ai_services s ON s.id=x.service_id
       JOIN ai_service_deployments d ON d.id=x.deployment_id AND d.service_id=x.service_id
      WHERE x.id=$1 AND x.service_id=$2 AND x.channel_id=$3 AND x.tenant_key=$4 AND x.user_key=$5`,
    [input.conversationId, input.serviceId, input.channelId, tenantKey, userKey],
  );
  if (!conversation) throw new Error('AI service Channel Conversation not found or inaccessible');
  if (conversation.status !== 'open') throw new Error('AI service Channel Conversation is closed');
  const deploymentCanServePinnedConversation = conversation.deployment_status === 'active' || conversation.deployment_status === 'superseded';
  if (conversation.channel_status !== 'enabled' || conversation.service_status !== 'active' || !deploymentCanServePinnedConversation ||
      !conversation.active_deployment_id || conversation.active_deployment_id !== conversation.current_deployment_id) {
    throw new Error('AI service Channel runtime is not active');
  }

  await assertAIServiceActivationReady(conversation.deployment_id, input.serviceId);
  await appendServiceMessage({
    conversationId: input.conversationId,
    serviceId: input.serviceId,
    deploymentId: conversation.deployment_id,
    channelId: input.channelId,
    role: 'user',
    content: { text: input.prompt },
  });
  const response = await runAIServicePreview({
    conversationKnowledgeSnapshot: await conversationFilesSnapshot(input.conversationId),
    serviceId: input.serviceId,
    deploymentId: conversation.deployment_id,
    conversationId: input.conversationId,
    prompt: input.prompt,
    userId: input.userId,
    username: input.username,
    userRole: input.userRole,
    recordEvaluation: false,
    runtimeMode: 'channel',
    onTextUpdate: input.onTextUpdate,
    signal: input.signal,
  });
  await appendServiceMessage({
    conversationId: input.conversationId,
    serviceId: input.serviceId,
    deploymentId: conversation.deployment_id,
    channelId: input.channelId,
    role: 'assistant',
    content: response,
  });
  return response;
}

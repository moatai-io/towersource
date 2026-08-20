/**
 * Owns: executing one AI Service Preview against its immutable Deployment Harness binding.
 * Public API: runAIServicePreview.
 */
import { createHash } from 'node:crypto';
import { v4 as uuidv4 } from 'uuid';
import { getEngine } from '../../engines/index.js';
import type { EngineCallbacks, TowerContentBlock } from '../../engines/types.js';
import { queryOne } from '../../db/pg-repo.js';
import { buildHarnessRuntimeFingerprint } from '../harness/harness-fingerprint.js';
import { expectedToolNamesForCapabilities } from '../harness/capability-provider-registry.js';
import { resolvePublishedHarnessReference } from '../harness/harness-store.js';
import { createSession, deleteSession, claimEngineSessionId, updateSession } from '../session/session-manager.js';
import { attachToolResultInDb, markAgentTurnCheckpoint, saveMessage, updateMessageContent, updateMessageMetrics } from '../message-store.js';
import { recordPassedRuntimeEvaluation } from './activation-gate.js';
import { buildServiceAgentRuntimePrompt, serviceIdentityFromExperience } from './service-identity.js';
import { buildServiceKnowledgePrompt } from './source-snapshot.js';
import { AIServiceKnowledgeCitationError, parseKnowledgeReadEvidence, validateKnowledgeAnswerCitations, type KnowledgeReadEvidence } from './knowledge-citation-validation.js';
import { config } from '../../config.js';
import { ensureRunning, getOrCreateBox } from '../runtime-box/runtime-box-manager.js';
import { isProjectExcluded } from '../runtime-box/policy.js';
import { createBackendAIServiceAgentRuntimeProvider } from './ai-service-agent-runtime-provider.js';

interface PreviewDeploymentRow {
  service_id: string;
  owner_project_id: string;
  owner_user_id: number;
  service_name: string;
  root_path: string | null;
  source_snapshot: unknown;
  policy_snapshot: unknown;
  experience_snapshot: unknown;
  snapshot_hash: string;
}

interface AIServiceRuntimeBoundary {
  readinessBoundary: 'project-runtime-box';
  agentExecutionBoundary: 'backend-process';
  agentRuntimeProvider: 'backend-engine';
  runtimeBoxId: number;
  projectId: string;
}

async function requireChannelRuntimeBox(input: {
  runtimeMode: 'preview' | 'channel';
  projectId: string;
  projectName: string;
  ownerUserId: number;
}): Promise<AIServiceRuntimeBoundary | null> {
  if (input.runtimeMode !== 'channel') return null;
  if (!config.runtimeBox.enabled) throw new Error('AI Service Channel requires Runtime Box, but Runtime Box is disabled');
  if (isProjectExcluded(input.projectId, input.projectName)) throw new Error('AI Service Channel Project is excluded from Runtime Box');
  const box = await getOrCreateBox(input.projectId, input.ownerUserId);
  const running = await ensureRunning(Number(box.id), input.ownerUserId);
  if (running.status !== 'running') throw new Error(`AI Service Channel Runtime Box is not running (status=${running.status})`);
  return { readinessBoundary: 'project-runtime-box', agentExecutionBoundary: 'backend-process', agentRuntimeProvider: 'backend-engine', runtimeBoxId: Number(running.id), projectId: input.projectId };
}

interface HarnessBindingSnapshot {
  harnessId: string;
  harnessVersion: number;
  runtimeProfileId: string;
  runtimeProfileVersion: number;
  engine: 'pi' | 'claude';
  model?: string;
  status?: string;
}

export interface AIServicePreviewResult {
  text: string;
  mode: 'harness-preview';
  citations: unknown[];
  provenance: {
    harnessId: string;
    harnessVersion: number;
    runtimeProfileId: string;
    runtimeProfileVersion: number;
    engine: string;
    model: string | null;
    promptBundleHash: string;
    toolSetHash: string;
    toolCount: number;
    tools: Array<{ name: string; input?: Record<string, unknown> }>;
    deploymentSnapshotHash: string;
    runtimeBoundary: AIServiceRuntimeBoundary | null;
    knowledgeCitationValidation?: {
      readCount: number;
      verifiedCount: number;
      invalidCount: number;
    };
  };
}

function bindingFromPolicy(policySnapshot: unknown): HarnessBindingSnapshot {
  const policy = policySnapshot && typeof policySnapshot === 'object' && !Array.isArray(policySnapshot)
    ? policySnapshot as Record<string, unknown>
    : {};
  const raw = policy.harnessBinding && typeof policy.harnessBinding === 'object' && !Array.isArray(policy.harnessBinding)
    ? policy.harnessBinding as Record<string, unknown>
    : null;
  if (!raw) throw new Error('Published Harness binding required for Preview');
  const binding: HarnessBindingSnapshot = {
    harnessId: String(raw.harnessId || ''),
    harnessVersion: Number(raw.harnessVersion),
    runtimeProfileId: String(raw.runtimeProfileId || ''),
    runtimeProfileVersion: Number(raw.runtimeProfileVersion),
    engine: raw.engine === 'claude' ? 'claude' : 'pi',
    model: typeof raw.model === 'string' && raw.model.trim() ? raw.model.trim() : undefined,
    status: typeof raw.status === 'string' ? raw.status : undefined,
  };
  if (!binding.harnessId || !Number.isInteger(binding.harnessVersion) || binding.harnessVersion < 1 ||
      !binding.runtimeProfileId || !Number.isInteger(binding.runtimeProfileVersion) || binding.runtimeProfileVersion < 1) {
    throw new Error('Valid published Harness binding required for Preview');
  }
  if (binding.status !== 'published') throw new Error('Only a published Harness can run Preview');
  return binding;
}

function previewSessionKey(conversationId: string, deploymentSnapshotHash: string): string {
  return createHash('sha256').update(`${conversationId}:${deploymentSnapshotHash}`).digest('hex').slice(0, 20);
}

async function getOrCreatePreviewRuntimeSession(input: {
  conversationId: string;
  serviceId: string;
  deploymentId: string;
  projectId: string;
  cwd: string;
  userId?: number;
  ownerUserId: number;
  serviceName: string;
  runtimeMode: 'preview' | 'channel';
  model: string | null;
  harness: Awaited<ReturnType<typeof resolvePublishedHarnessReference>>;
}): Promise<string> {
  const existing = await queryOne<{ runtime_session_id: string | null }>(
    'SELECT runtime_session_id FROM ai_service_conversations WHERE id=$1 AND service_id=$2 AND deployment_id=$3',
    [input.conversationId, input.serviceId, input.deploymentId],
  );
  if (!existing) throw new Error('AI service Preview Conversation not found');
  if (existing.runtime_session_id) return existing.runtime_session_id;

  const isDeploymentSession = input.runtimeMode === 'channel';
  const session = await createSession(
    isDeploymentSession
      ? `${input.serviceName} · 외부 대화 ${previewSessionKey(input.conversationId, input.deploymentId)}`
      : `AI Service Preview ${previewSessionKey(input.conversationId, input.deploymentId)}`,
    input.cwd,
    input.userId ?? input.ownerUserId,
    input.projectId,
    input.harness.engine,
    null,
    null,
    null,
    isDeploymentSession ? '배포 세션' : 'ai_service_preview',
    input.model,
    {
      visibility: isDeploymentSession ? 'project' : 'private',
      harness: {
        id: input.harness.id,
        version: input.harness.version,
        runtimeProfileId: input.harness.runtimeProfileId,
        runtimeProfileVersion: input.harness.runtimeProfileVersion,
      },
    },
  );
  if (isDeploymentSession) await updateSession(session.id, { kind: 'deployment' });
  const won = await queryOne<{ runtime_session_id: string | null }>(
    `UPDATE ai_service_conversations SET runtime_session_id=$2,updated_at=NOW()
      WHERE id=$1 AND runtime_session_id IS NULL RETURNING runtime_session_id`,
    [input.conversationId, session.id],
  );
  if (won?.runtime_session_id) return won.runtime_session_id;
  const winner = await queryOne<{ runtime_session_id: string | null }>(
    'SELECT runtime_session_id FROM ai_service_conversations WHERE id=$1',
    [input.conversationId],
  );
  await deleteSession(session.id);
  if (!winner?.runtime_session_id) throw new Error('AI service Preview runtime Session pin failed');
  return winner.runtime_session_id;
}

/** Execute a Preview turn with no filesystem authority and the Deployment's exact Harness tuple. */
export async function runAIServicePreview(input: {
  serviceId: string;
  deploymentId: string;
  conversationId: string;
  prompt: string;
  userId?: number;
  username?: string;
  userRole?: string;
  /** Only operator Preview/evaluation runs may mint activation evidence. Serving traffic must set false. */
  recordEvaluation?: boolean;
  runtimeMode?: 'preview' | 'channel';
  onTextUpdate?: (text: string) => void | Promise<void>;
  signal?: AbortSignal;
  /** Conversation-scoped external user files, already authorized by the caller. */
  conversationKnowledgeSnapshot?: unknown;
}): Promise<AIServicePreviewResult> {
  const deployment = await queryOne<PreviewDeploymentRow>(
    `SELECT d.service_id, d.source_snapshot, d.policy_snapshot, d.experience_snapshot, d.snapshot_hash,
            s.owner_project_id, s.owner_user_id, s.name AS service_name, p.root_path
       FROM ai_service_deployments d
       JOIN ai_services s ON s.id = d.service_id
       JOIN projects p ON p.id = s.owner_project_id
      WHERE d.id = $1 AND d.service_id = $2`,
    [input.deploymentId, input.serviceId],
  );
  if (!deployment) throw new Error('AI service Deployment not found');

  const binding = bindingFromPolicy(deployment.policy_snapshot);
  const serviceIdentity = serviceIdentityFromExperience(deployment.experience_snapshot);
  const deploymentKnowledge = buildServiceKnowledgePrompt(deployment.source_snapshot);
  const conversationKnowledge = buildServiceKnowledgePrompt(input.conversationKnowledgeSnapshot);
  const mergedKnowledgeSnapshot = deploymentKnowledge.citations.length > 0 && conversationKnowledge.citations.length > 0
    ? { kind: 'knowledge', version: 1, refs: [
        ...((deployment.source_snapshot as { refs?: unknown[] })?.refs || []),
        ...((input.conversationKnowledgeSnapshot as { refs?: unknown[] })?.refs || []),
      ], userFacingLabel: '배포 자료와 이 대화의 업로드 자료' }
    : conversationKnowledge.citations.length > 0 ? input.conversationKnowledgeSnapshot : deployment.source_snapshot;
  const knowledge = buildServiceKnowledgePrompt(mergedKnowledgeSnapshot);
  if (binding.engine !== 'pi') throw new Error('AI Service Preview currently supports Pi Harnesses only');
  const harness = await resolvePublishedHarnessReference(binding);
  const knowledgeToolNames = knowledge.citations.length > 0 ? ['knowledge_read', 'knowledge_search'] : [];
  const expectedToolNames = [...expectedToolNamesForCapabilities(harness.capabilityIds), ...knowledgeToolNames].sort();
  const fingerprint = buildHarnessRuntimeFingerprint(harness, expectedToolNames);
  const cwd = deployment.root_path || process.env.WORKSPACE_ROOT || `${process.env.HOME || '/home/tower'}/workspace`;
  const sessionId = await getOrCreatePreviewRuntimeSession({
    conversationId: input.conversationId,
    serviceId: input.serviceId,
    deploymentId: input.deploymentId,
    projectId: deployment.owner_project_id,
    cwd,
    userId: input.userId,
    ownerUserId: deployment.owner_user_id,
    serviceName: deployment.service_name,
    runtimeMode: input.runtimeMode || 'preview',
    model: binding.model || harness.defaultModel,
    harness,
  });
  const runtimeBoundary = await requireChannelRuntimeBox({
    runtimeMode: input.runtimeMode || 'preview',
    projectId: deployment.owner_project_id,
    projectName: deployment.service_name,
    ownerUserId: deployment.owner_user_id,
  });
  const engine = await getEngine(harness.engine);
  const agentRuntimeProvider = createBackendAIServiceAgentRuntimeProvider();
  const abortRuntime = () => engine.abort(sessionId);
  if (input.signal?.aborted) abortRuntime();
  else input.signal?.addEventListener('abort', abortRuntime, { once: true });
  let text = '';
  let runtimeModel: string | null = binding.model || harness.defaultModel;
  const tools: Array<{ id: string; name: string; input?: Record<string, unknown> }> = [];
  const seenToolIds = new Set<string>();
  let engineError: { message: string; retryable: boolean } | null = null;
  let engineOutcome: 'completed' | 'retryable_failure' | 'failed' | 'claim_denied' | undefined;
  const rootTurnId = uuidv4();

  await saveMessage(sessionId, {
    id: rootTurnId,
    role: 'user',
    content: [{ type: 'text', text: input.prompt }],
    username: input.username || (input.runtimeMode === 'channel' ? '외부 사용자' : 'AI Service Preview'),
    metadata: { aiServiceConversationId: input.conversationId, aiServiceId: input.serviceId, sourceType: input.runtimeMode === 'channel' ? 'ai_service_channel' : 'ai_service_preview' },
  });
  await markAgentTurnCheckpoint(rootTurnId, {
    status: 'started',
    sessionId,
    rootTurnId,
    engine: harness.engine,
    model: binding.model || harness.defaultModel || null,
  });

  const knowledgeReadEvidence: KnowledgeReadEvidence[] = [];
  const callbacks: EngineCallbacks = {
    askUser: async () => 'Preview cannot ask an interactive question. State the limitation and continue safely.',
    claimSessionId: async (engineSessionId) => { await claimEngineSessionId(sessionId, harness.engine, engineSessionId); },
    saveMessage: async (msg) => {
      await saveMessage(sessionId, {
        ...msg,
        metadata: { ...(msg.metadata || {}), aiServiceConversationId: input.conversationId, aiServiceId: input.serviceId },
      });
    },
    updateMessageContent: async (msgId, content) => { await updateMessageContent(msgId, content); },
    attachToolResult: async (toolUseId, result) => {
      await attachToolResultInDb(sessionId, toolUseId, result);
      // Pi may emit tool_execution_end before the assistant tool_use block reaches this iterator.
      // Parse by the strict knowledge_read result schema instead of depending on event order.
      const evidence = parseKnowledgeReadEvidence(result);
      if (evidence) knowledgeReadEvidence.push(evidence);
    },
    updateMessageMetrics: async (msgId, metrics) => {
      await updateMessageMetrics(msgId, {
        duration_ms: metrics.durationMs,
        finalize_completed_at: metrics.finalizeCompletedAt,
        input_tokens: metrics.inputTokens,
        output_tokens: metrics.outputTokens,
        cache_read_tokens: metrics.cacheReadTokens,
        cache_creation_tokens: metrics.cacheCreationTokens,
        cache_creation_1h_tokens: metrics.cacheCreation1hTokens,
        cache_creation_5m_tokens: metrics.cacheCreation5mTokens,
        reasoning_tokens: metrics.reasoningTokens,
        cost_usd: metrics.costUsd,
        context_input_tokens: metrics.contextInputTokens,
        context_window_size: metrics.contextWindowSize,
        context_estimated_tokens: metrics.contextEstimatedTokens,
        next_request_estimated_tokens: metrics.nextRequestEstimatedTokens,
        compact_threshold_tokens: metrics.compactThresholdTokens,
          context_snapshot: metrics.contextSnapshot,
      });
    },
  };

  const runtimeLabel = input.runtimeMode === 'channel' ? 'AI Service Channel' : 'AI Service Preview';
  const systemBoundary = `You are running inside an isolated ${runtimeLabel}. Answer the user's request directly. Use only the tools exposed by the pinned Harness. You have no filesystem, Project instructions, memory, credentials, MCP, publishing, scheduling, or orchestration capability. For material claims based on the web, name the source URLs you actually fetched and state uncertainty.${knowledge.prompt ? `\n\n${knowledge.prompt}\n\nFor precise Knowledge answers, use knowledge_search and then knowledge_read. Cite the returned path and line range. These tools can inspect only this immutable Deployment snapshot.` : ''}`;
  try {
    for await (const message of agentRuntimeProvider.run({ engine, sessionId, prompt: `${systemBoundary}\n\nUser request:\n${input.prompt}`, opts: {
      cwd,
      model: binding.model || harness.defaultModel || undefined,
      userId: input.userId,
      username: input.username,
      userRole: input.userRole || 'member',
      accessiblePaths: [],
      readOnlyPaths: [],
      denyImplicitBash: true,
      channelSafeToolsOnly: true,
      projectId: deployment.owner_project_id,
      harnessId: harness.id,
      serviceIdentityPrompt: buildServiceAgentRuntimePrompt(serviceIdentity),
      serviceKnowledgeSnapshot: knowledge.citations.length > 0 ? mergedKnowledgeSnapshot : undefined,
      rootTurnId,
    }, callbacks })) {
      if (message.type === 'assistant') {
        const blocks = (message.content || []) as TowerContentBlock[];
        const nextText = blocks.filter((block): block is TowerContentBlock & { type: 'text' } => block.type === 'text').map((block) => block.text || '').join('') || text;
        if (nextText !== text) {
          text = nextText;
          await input.onTextUpdate?.(text);
        }
        for (const block of blocks) {
          if (block.type !== 'tool_use' || !block.name || seenToolIds.has(block.id)) continue;
          seenToolIds.add(block.id);
          tools.push({ id: block.id, name: block.name, input: block.input });
        }
      } else if (message.type === 'engine_done') {
        if (message.model) runtimeModel = message.model;
        engineOutcome = message.outcome;
      } else if (message.type === 'engine_error') {
        engineError = { message: message.message, retryable: message.retryable === true };
        if (!message.recoverable) throw new Error(message.message);
      }
    }
  } finally {
    input.signal?.removeEventListener('abort', abortRuntime);
    // Keep the persisted Pi session resumable for the next Preview message.
    // The Engine cache may retain it; the DB Session + Pi session file remain canonical.
  }

  if (!text.trim()) {
    const diagnostic = engineOutcome ? ` (engine outcome: ${engineOutcome})` : '';
    const failureMessage = engineError?.message || `AI Service runtime completed without assistant text${diagnostic}`;
    await markAgentTurnCheckpoint(rootTurnId, {
      status: engineOutcome === 'retryable_failure' ? 'waiting_retry' : 'failed',
      sessionId,
      rootTurnId,
      engine: harness.engine,
      model: runtimeModel,
      error: failureMessage,
    });
    const error = new Error(failureMessage) as Error & { retryable?: boolean; code?: string };
    error.retryable = engineError?.retryable === true || engineOutcome === 'retryable_failure';
    error.code = engineOutcome === 'claim_denied' ? 'AI_SERVICE_RUNTIME_CLAIM_DENIED' : 'AI_SERVICE_RUNTIME_EMPTY_RESPONSE';
    throw error;
  }
  const unexpectedTools = tools.map((tool) => tool.name).filter((name) => !expectedToolNames.includes(name));
  if (unexpectedTools.length > 0) throw new Error(`AI Service Preview Harness mismatch: unexpected tools ${unexpectedTools.join(', ')}`);

  const citationValidation = validateKnowledgeAnswerCitations(text, knowledgeReadEvidence);
  if (citationValidation.invalid.length > 0) {
    const invalid = citationValidation.invalid.map((item) => `${item.path}#L${item.lineStart}-L${item.lineEnd}`).join(', ');
    const failureMessage = `AI Service Knowledge citation validation failed: ${invalid} [serviceId=${input.serviceId} deploymentId=${input.deploymentId} conversationId=${input.conversationId}]`;
    await markAgentTurnCheckpoint(rootTurnId, {
      status: 'failed', sessionId, rootTurnId, engine: harness.engine, model: runtimeModel, error: failureMessage,
    });
    throw new AIServiceKnowledgeCitationError(failureMessage);
  }
  await markAgentTurnCheckpoint(rootTurnId, {
    status: 'completed', sessionId, rootTurnId, engine: harness.engine, model: runtimeModel,
  });

  const provenance: AIServicePreviewResult['provenance'] = {
    harnessId: fingerprint.harnessId,
    harnessVersion: fingerprint.harnessVersion,
    runtimeProfileId: fingerprint.runtimeProfileId,
    runtimeProfileVersion: fingerprint.runtimeProfileVersion,
    engine: fingerprint.engine,
    model: runtimeModel,
    promptBundleHash: fingerprint.promptBundleHash,
    toolSetHash: fingerprint.toolSetHash,
    toolCount: fingerprint.toolCount,
    tools: tools.map(({ id: _id, ...tool }) => tool),
    deploymentSnapshotHash: deployment.snapshot_hash,
    runtimeBoundary,
    ...(knowledge.citations.length > 0 ? { knowledgeCitationValidation: {
      readCount: knowledgeReadEvidence.length,
      verifiedCount: citationValidation.verified.length,
      invalidCount: citationValidation.invalid.length,
    } } : {}),
  };
  if (input.recordEvaluation !== false) {
    if (typeof input.userId !== 'number') throw new Error('AI Service Preview evaluation requires a userId');
    await recordPassedRuntimeEvaluation({
      serviceId: input.serviceId,
      deploymentId: input.deploymentId,
      conversationId: input.conversationId,
      evaluatedByUserId: input.userId,
      provenance,
    });
  }
  return { text, mode: 'harness-preview', citations: citationValidation.verified, provenance };
}

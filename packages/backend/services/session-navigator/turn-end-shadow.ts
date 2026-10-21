import type { DecisionResult } from '../decision/decision-spec.js';
import { evaluateWithOpenRouterJev } from '../decision/openrouter-jev-adapter.js';
import { resolveGatewayProfileClient } from '../gateway-profile/gateway-profile-client.js';
import { markTurnEndShadow } from '../message-store.js';
import { parseTurnEndDecisionState, TURN_END_CONTINUATION_SHADOW_SPEC, type TurnEndDecisionState } from './turn-end.js';

export type TurnEndShadowDecision = 'continue' | 'complete' | 'inspect' | 'revise' | 'replan' | 'stop_for_human';
export type TurnEndAssessmentId = 'goalAlignment' | 'conversationContinuity' | 'evidenceSufficiency' | 'responseCompleteness';

export interface TurnEndShadowRecord {
  sessionId: string;
  responseMessageId: string;
  contextRevision: number;
  status: 'pending' | 'observed' | 'error' | 'skipped';
  decision?: TurnEndShadowDecision;
  confidence?: number;
  probabilities?: Record<TurnEndShadowDecision, number>;
  assessments?: Partial<Record<TurnEndAssessmentId, number>>;
  flags?: Array<'constraint_loss' | 'unfinished_commitment'>;
  disposition?: DecisionResult['disposition'];
  latencyMs?: number;
  errorCode?: string;
  createdAt: string;
}

const latestBySession = new Map<string, TurnEndShadowRecord>();

export function getLatestTurnEndShadowRecord(sessionId: string): TurnEndShadowRecord | null {
  return latestBySession.get(sessionId) ?? null;
}

export function parsePersistedTurnEndShadow(value: unknown): TurnEndShadowRecord | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Partial<TurnEndShadowRecord>;
  if (typeof record.sessionId !== 'string' || typeof record.responseMessageId !== 'string') return null;
  if (record.status !== 'pending' && record.status !== 'observed' && record.status !== 'error' && record.status !== 'skipped') return null;
  if (typeof record.contextRevision !== 'number' || typeof record.createdAt !== 'string') return null;
  return record as TurnEndShadowRecord;
}

export function resetTurnEndShadowRecordsForTests(): void {
  latestBySession.clear();
}

export function assembleTurnEndDecisionState(input: {
  sessionId: string;
  contextRevision: number;
  responseMessageId: string;
  userPrompt: string;
  assistantOutcome: string;
  continuationIntent: boolean;
  errorStopReason?: string;
}): TurnEndDecisionState | null {
  if (input.errorStopReason || !input.assistantOutcome.trim()) return null;
  return parseTurnEndDecisionState({
    schemaVersion: 1,
    sessionId: input.sessionId,
    contextRevision: input.contextRevision,
    responseMessageId: input.responseMessageId,
    responseEnded: true,
    activeGoal: input.userPrompt.trim().slice(0, 4_000) || 'Continue the current user-requested task.',
    completionCriteria: [],
    assistantOutcome: input.assistantOutcome.trim().slice(0, 4_000),
    completedEvidence: [],
    remainingAuthorizedSteps: input.continuationIntent ? ['The assistant explicitly indicated an unfinished next step.'] : [],
    blockers: [],
  });
}

export async function evaluateTurnEndShadow(input: {
  state: TurnEndDecisionState;
  actorUserId: number;
  projectId: string;
  evaluate?: typeof evaluateWithOpenRouterJev;
  resolveGateway?: typeof resolveGatewayProfileClient;
}): Promise<TurnEndShadowRecord> {
  const base = {
    sessionId: input.state.sessionId,
    responseMessageId: input.state.responseMessageId,
    contextRevision: input.state.contextRevision,
    createdAt: new Date().toISOString(),
  };
  try {
    const gateway = await (input.resolveGateway ?? resolveGatewayProfileClient)({ actorUserId: input.actorUserId, projectId: input.projectId });
    const result = await (input.evaluate ?? evaluateWithOpenRouterJev)(TURN_END_CONTINUATION_SHADOW_SPEC, input.state, {
      apiKey: gateway.apiKey,
      baseUrl: gateway.baseUrl,
      timeoutMs: 2_000,
    });
    const answer = result.answers.continuation;
    const score = (id: string) => {
      const value = result.answers[id];
      return value?.type === 'score' ? value.score : undefined;
    };
    const flag = (id: string) => {
      const value = result.answers[id];
      return value?.type === 'noul' ? value.noul >= 0.5 : false;
    };
    const record: TurnEndShadowRecord = {
      ...base,
      status: 'observed',
      decision: answer?.type === 'choice' ? answer.choice as TurnEndShadowDecision : 'inspect',
      confidence: answer && 'confidence' in answer ? answer.confidence : undefined,
      probabilities: answer?.type === 'choice' ? answer.probabilities as Record<TurnEndShadowDecision, number> : undefined,
      assessments: {
        goalAlignment: score('goal_alignment'),
        conversationContinuity: score('conversation_continuity'),
        evidenceSufficiency: score('evidence_sufficiency'),
        responseCompleteness: score('response_completeness'),
      },
      flags: [
        ...(flag('constraint_loss') ? ['constraint_loss' as const] : []),
        ...(flag('unfinished_commitment') ? ['unfinished_commitment' as const] : []),
      ],
      disposition: result.disposition,
      latencyMs: result.latencyMs,
    };
    latestBySession.set(input.state.sessionId, record);
    return record;
  } catch (error: any) {
    const record: TurnEndShadowRecord = { ...base, status: 'error', errorCode: String(error?.code || 'TURN_END_SHADOW_ERROR') };
    latestBySession.set(input.state.sessionId, record);
    return record;
  }
}

/** Fire-and-forget wrapper: provider latency or failure never delays terminalization. */
export function scheduleTurnEndShadow(input: Parameters<typeof evaluateTurnEndShadow>[0]): void {
  const pending: TurnEndShadowRecord = {
    sessionId: input.state.sessionId,
    responseMessageId: input.state.responseMessageId,
    contextRevision: input.state.contextRevision,
    status: 'pending',
    createdAt: new Date().toISOString(),
  };
  latestBySession.set(input.state.sessionId, pending);
  void markTurnEndShadow(pending.responseMessageId, pending)
    .then(() => evaluateTurnEndShadow(input))
    .then(record => markTurnEndShadow(record.responseMessageId, record))
    .catch(async error => {
      const record: TurnEndShadowRecord = {
        ...pending,
        status: 'error',
        errorCode: String(error?.code || 'TURN_END_SHADOW_PERSIST_ERROR'),
      };
      latestBySession.set(input.state.sessionId, record);
      await markTurnEndShadow(record.responseMessageId, record).catch(() => undefined);
    });
}

export function recordSkippedTurnEndShadow(input: {
  sessionId: string;
  responseMessageId: string;
  contextRevision: number;
  reason: string;
}): void {
  const record: TurnEndShadowRecord = {
    sessionId: input.sessionId,
    responseMessageId: input.responseMessageId,
    contextRevision: input.contextRevision,
    status: 'skipped',
    errorCode: input.reason,
    createdAt: new Date().toISOString(),
  };
  latestBySession.set(input.sessionId, record);
  void markTurnEndShadow(record.responseMessageId, record).catch(() => undefined);
}

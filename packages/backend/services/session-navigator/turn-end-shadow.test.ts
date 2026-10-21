import { describe, expect, it, vi, beforeEach } from 'vitest';
import { assembleTurnEndDecisionState, evaluateTurnEndShadow, getLatestTurnEndShadowRecord, resetTurnEndShadowRecordsForTests, scheduleTurnEndShadow } from './turn-end-shadow.js';

beforeEach(() => resetTurnEndShadowRecordsForTests());

const state = () => assembleTurnEndDecisionState({
  sessionId: 'session-1', contextRevision: 2, responseMessageId: 'message-2', userPrompt: 'Finish the feature.',
  assistantOutcome: 'Implemented the schema. Next I will run tests.', continuationIntent: true,
})!;

describe('turn-end shadow runtime', () => {
  it('assembles bounded state only for successful assistant response ends', () => {
    expect(state()).toMatchObject({ responseEnded: true, activeGoal: 'Finish the feature.', remainingAuthorizedSteps: [expect.any(String)] });
    expect(assembleTurnEndDecisionState({ sessionId: 's', contextRevision: 1, responseMessageId: 'm', userPrompt: 'x', assistantOutcome: '', continuationIntent: false })).toBeNull();
    expect(assembleTurnEndDecisionState({ sessionId: 's', contextRevision: 1, responseMessageId: 'm', userPrompt: 'x', assistantOutcome: 'failed', continuationIntent: false, errorStopReason: 'error' })).toBeNull();
  });

  it('records an observed provider decision without creating execution authority', async () => {
    const record = await evaluateTurnEndShadow({
      state: state(), actorUserId: 1, projectId: 'project-1',
      resolveGateway: vi.fn().mockResolvedValue({ apiKey: 'x', baseUrl: 'https://gateway.example', profileId: 'p', apiId: 'openrouter-jev', credentialId: 'c', readiness: 'ready' }),
      evaluate: vi.fn().mockResolvedValue({
        specId: 'tower.session-navigator.turn-end', specRevision: 1, provider: 'test', model: 'jev', latencyMs: 10, disposition: 'accepted',
        answers: {
          continuation: { type: 'choice', choice: 'continue', probabilities: { continue: .82, revise: .1, inspect: .08 }, confidence: .95 },
          goal_alignment: { type: 'score', score: 2, probabilities: {}, confidence: .9, legend: {} },
          conversation_continuity: { type: 'score', score: 2, probabilities: {}, confidence: .88, legend: {} },
          evidence_sufficiency: { type: 'score', score: 1, probabilities: {}, confidence: .8, legend: {} },
          response_completeness: { type: 'score', score: 1, probabilities: {}, confidence: .84, legend: {} },
          constraint_loss: { type: 'noul', noul: .2 },
          unfinished_commitment: { type: 'noul', noul: .91 },
        },
      }),
    });
    expect(record).toMatchObject({
      status: 'observed', decision: 'continue', confidence: .95, disposition: 'accepted',
      probabilities: { continue: .82, revise: .1, inspect: .08 },
      assessments: { goalAlignment: 2, conversationContinuity: 2, evidenceSufficiency: 1, responseCompleteness: 1 },
      flags: ['unfinished_commitment'],
    });
    expect(getLatestTurnEndShadowRecord('session-1')).toEqual(record);
    expect(JSON.stringify(record)).not.toContain('user_answer');
  });

  it('fails open and stores only an error code when gateway/provider is unavailable', async () => {
    const record = await evaluateTurnEndShadow({
      state: state(), actorUserId: 1, projectId: 'project-1',
      resolveGateway: vi.fn().mockRejectedValue(Object.assign(new Error('not ready'), { code: 'GATEWAY_API_NOT_READY' })),
    });
    expect(record).toMatchObject({ status: 'error', errorCode: 'GATEWAY_API_NOT_READY' });
    expect(record).not.toHaveProperty('decision');
  });

  it('schedules evaluation without returning or awaiting provider work', async () => {
    let resolveGateway!: (value: any) => void;
    const pending = new Promise(resolve => { resolveGateway = resolve; });
    scheduleTurnEndShadow({ state: state(), actorUserId: 1, projectId: 'project-1', resolveGateway: vi.fn(() => pending) as any });
    expect(getLatestTurnEndShadowRecord('session-1')).toMatchObject({ status: 'pending', responseMessageId: 'message-2' });
    await new Promise(resolve => setTimeout(resolve, 0));
    resolveGateway({ apiKey: 'test-key', baseUrl: 'https://gateway.example.test' });
    await new Promise(resolve => setTimeout(resolve, 0));
  });
});

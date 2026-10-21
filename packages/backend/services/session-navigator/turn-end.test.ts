import { describe, expect, it } from 'vitest';
import { parseTurnEndDecisionState, TURN_END_CONTINUATION_SHADOW_SPEC } from './turn-end.js';

function validState() {
  return {
    schemaVersion: 1 as const,
    sessionId: 'session-1',
    contextRevision: 3,
    responseMessageId: 'message-9',
    responseEnded: true as const,
    activeGoal: 'Complete the Phase 0 session navigator contract.',
    completionCriteria: ['Spec, fixture, and tests exist.'],
    assistantOutcome: 'The minimal turn-end spec was added.',
    completedEvidence: ['turn-end.ts exists'],
    remainingAuthorizedSteps: ['Run the focused tests.'],
    blockers: [],
  };
}

describe('Turn-end continuation shadow contract', () => {
  it('asks one bounded path question with atomic quality assessments after the response ended', () => {
    expect(TURN_END_CONTINUATION_SHADOW_SPEC).toMatchObject({
      schemaVersion: 1,
      id: 'tower.session-navigator.turn-end',
      revision: 1,
      mode: 'shadow',
      policy: { minConfidence: 0.9, onAbstain: 'observe_only' },
    });
    const question = TURN_END_CONTINUATION_SHADOW_SPEC.questions.continuation;
    expect(question.type === 'choice' && Object.keys(question.criteria)).toEqual([
      'continue', 'complete', 'inspect', 'revise', 'replan', 'stop_for_human',
    ]);
    expect(Object.keys(TURN_END_CONTINUATION_SHADOW_SPEC.questions)).toEqual([
      'continuation', 'goal_alignment', 'conversation_continuity', 'evidence_sufficiency',
      'response_completeness', 'constraint_loss', 'unfinished_commitment',
    ]);
    expect(parseTurnEndDecisionState(validState()).responseEnded).toBe(true);
  });

  it('rejects an in-progress response and unknown authority-like fields', () => {
    expect(() => parseTurnEndDecisionState({ ...validState(), responseEnded: false })).toThrow();
    expect(() => parseTurnEndDecisionState({ ...validState(), pendingApproval: false })).toThrow();
  });

  it('does not encode a user answer, click, approval, or executable action', () => {
    const encoded = JSON.stringify(TURN_END_CONTINUATION_SHADOW_SPEC);
    expect(encoded).not.toContain('user_answer');
    expect(encoded).not.toContain('user_click');
    expect(encoded).not.toContain('humanApproval');
    expect(encoded).not.toContain('actionId');
  });
});

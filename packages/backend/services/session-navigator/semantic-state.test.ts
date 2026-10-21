import { describe, expect, it } from 'vitest';
import { parseSessionSemanticState } from './semantic-state.js';

function validState() {
  return {
    schemaVersion: 1 as const,
    sessionId: 'session-1',
    revision: 1,
    basedOnMessageId: 'message-2',
    originalIntent: [{ id: 'intent.1', text: 'Build a shadow navigator.', sourceMessageIds: ['message-1'], status: 'active' as const, confidence: 0.99 }],
    currentGoals: [], successCriteria: [], userConstraints: [], userPreferences: [], acceptedDecisions: [], rejectedDirections: [], agentCommitments: [], unresolvedQuestions: [], currentPlan: [], completedEvidence: [], blockers: [],
    updatedAt: '2026-09-21T12:00:00Z',
  };
}

describe('SessionSemanticState', () => {
  it('parses an anchored, versioned semantic state', () => {
    expect(parseSessionSemanticState(validState())).toMatchObject({ schemaVersion: 1, revision: 1, basedOnMessageId: 'message-2' });
  });

  it('requires every fact to keep at least one source message anchor', () => {
    const state = validState();
    state.originalIntent[0].sourceMessageIds = [];
    expect(() => parseSessionSemanticState(state)).toThrow();
  });

  it('rejects duplicate fact ids across semantic sections', () => {
    const state = validState();
    state.currentGoals = [structuredClone(state.originalIntent[0])];
    expect(() => parseSessionSemanticState(state)).toThrow('duplicate anchored fact id');
  });

  it('rejects unknown fields and invalid confidence', () => {
    const state = validState() as any;
    state.canAuthorize = true;
    expect(() => parseSessionSemanticState(state)).toThrow();
    const confidence = validState();
    confidence.originalIntent[0].confidence = 1.1;
    expect(() => parseSessionSemanticState(confidence)).toThrow();
  });
});

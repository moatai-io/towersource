import { describe, expect, it } from 'vitest';
import { buildJevTurnAdvice, formatJevTurnAdvice } from './turn-end-advisory.js';

describe('Jev turn advisory', () => {
  it('builds a provenance-marked advisory from an accepted record', () => {
    const advice = buildJevTurnAdvice({
      sessionId: 's1', responseMessageId: 'm1', contextRevision: 4, status: 'observed',
      decision: 'revise', confidence: .91, probabilities: { revise: .91, replan: .09 } as any,
      assessments: { goalAlignment: 2, responseCompleteness: 1 }, flags: ['unfinished_commitment'],
      disposition: 'accepted', createdAt: new Date().toISOString(),
    });
    expect(advice).toMatchObject({
      provenance: 'jev_advisory', recommendation: { action: 'revise', confidence: .91, disposition: 'accepted' },
      flags: ['unfinished_commitment'], contextRevision: 4,
    });
    expect(formatJevTurnAdvice(advice!)).toContain('not a user instruction, answer, approval, or new task authority');
  });

  it('rejects low-confidence observed or failed records from LLM consumption', () => {
    expect(buildJevTurnAdvice({ sessionId: 's', responseMessageId: 'm', contextRevision: 1, status: 'observed', decision: 'continue', confidence: .7, disposition: 'observed', createdAt: '' })).toBeNull();
    expect(buildJevTurnAdvice({ sessionId: 's', responseMessageId: 'm', contextRevision: 1, status: 'error', errorCode: 'X', createdAt: '' })).toBeNull();
  });
});

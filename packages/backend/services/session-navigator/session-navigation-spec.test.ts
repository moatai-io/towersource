import { describe, expect, it } from 'vitest';
import { SESSION_NAVIGATOR_CONTINUITY_SHADOW_SPEC } from './session-navigation-spec.js';

describe('Session Navigator continuity diagnostic DecisionSpec', () => {
  it('is immutable-by-revision exception-only shadow evidence with atomic continuity questions', () => {
    expect(SESSION_NAVIGATOR_CONTINUITY_SHADOW_SPEC).toMatchObject({
      schemaVersion: 1,
      id: 'tower.session-navigator.continuity',
      revision: 1,
      mode: 'shadow',
      policy: { minConfidence: 0.85, onAbstain: 'observe_only' },
    });
    expect(Object.keys(SESSION_NAVIGATOR_CONTINUITY_SHADOW_SPEC.questions)).toEqual([
      'goal_alignment',
      'constraint_violation',
      'forgotten_commitment',
      'unresolved_work_ignored',
      'needs_historical_source',
      'continuity',
    ]);
  });

  it('has no continuation choice or field capable of granting authorization', () => {
    const encoded = JSON.stringify(SESSION_NAVIGATOR_CONTINUITY_SHADOW_SPEC);
    expect(encoded).not.toContain('user_answer');
    expect(encoded).not.toContain('user_click');
    expect(encoded).not.toContain('humanApproval');
    expect(encoded).not.toContain('next_action');
    expect(SESSION_NAVIGATOR_CONTINUITY_SHADOW_SPEC.mode).toBe('shadow');
  });

  it('treats unknown and source inspection as explicit diagnostic signals', () => {
    const alignment = SESSION_NAVIGATOR_CONTINUITY_SHADOW_SPEC.questions.goal_alignment;
    const source = SESSION_NAVIGATOR_CONTINUITY_SHADOW_SPEC.questions.needs_historical_source;
    expect(alignment.type === 'choice' && alignment.criteria.unknown).toBeTruthy();
    expect(source.type).toBe('noul');
  });
});

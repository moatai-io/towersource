import { describe, expect, it } from 'vitest';
import { encodeDecisionState, parseDecisionSpec } from './decision-spec.js';
import { TOWER_REQUEST_ROUTING_SPEC } from './examples.js';

describe('DecisionSpec', () => {
  it('parses a provider-neutral versioned routing spec', () => {
    expect(TOWER_REQUEST_ROUTING_SPEC).toMatchObject({
      schemaVersion: 1, id: 'tower.request-routing', revision: 1, mode: 'shadow',
      policy: { minConfidence: 0.8, confidenceQuestionIds: ['route'], onAbstain: 'fallback' },
    });
    expect(Object.keys(TOWER_REQUEST_ROUTING_SPEC.questions)).toEqual(['route', 'needs_fresh_data', 'complexity']);
  });

  it('rejects unbounded choice questions and unknown fields', () => {
    const base = structuredClone(TOWER_REQUEST_ROUTING_SPEC) as any;
    base.questions.route.criteria = { only: 'Not a real choice.' };
    expect(() => parseDecisionSpec(base)).toThrow('2..255');
    const extra = structuredClone(TOWER_REQUEST_ROUTING_SPEC) as any;
    extra.canAuthorize = true;
    expect(() => parseDecisionSpec(extra)).toThrow();
  });

  it('requires explicit abstain behavior and coherent fallback policy', () => {
    const missing = structuredClone(TOWER_REQUEST_ROUTING_SPEC) as any;
    delete missing.policy.fallbackPolicyId;
    expect(() => parseDecisionSpec(missing)).toThrow('fallbackPolicyId required');
    const misplaced = structuredClone(TOWER_REQUEST_ROUTING_SPEC) as any;
    misplaced.policy.onAbstain = 'needs_human';
    expect(() => parseDecisionSpec(misplaced)).toThrow('only valid');
  });

  it('requires disposition confidence gates to reference confidence-bearing questions', () => {
    expect(() => parseDecisionSpec({ ...TOWER_REQUEST_ROUTING_SPEC, policy: { ...TOWER_REQUEST_ROUTING_SPEC.policy, confidenceQuestionIds: ['missing'] } })).toThrow('confidence question not found');
    expect(() => parseDecisionSpec({ ...TOWER_REQUEST_ROUTING_SPEC, policy: { ...TOWER_REQUEST_ROUTING_SPEC.policy, confidenceQuestionIds: ['needs_fresh_data'] } })).toThrow('has no confidence');
  });

  it('accepts JSON state but rejects undefined and non-finite values', () => {
    expect(encodeDecisionState({ request: 'hello', attempts: [1, 2], ok: true })).toBe('{"request":"hello","attempts":[1,2],"ok":true}');
    expect(() => encodeDecisionState({ secret: undefined })).toThrow();
    expect(() => encodeDecisionState({ score: Number.POSITIVE_INFINITY })).toThrow();
  });
});

it('allows substantial instructions without expanding other short fields', () => {
  const spec = structuredClone(TOWER_REQUEST_ROUTING_SPEC) as any;
  spec.questions.route.instructions = 'x'.repeat(32_000);
  expect(parseDecisionSpec(spec).questions.route.instructions.length).toBe(32_000);
  spec.questions.route.instructions += 'x';
  expect(() => parseDecisionSpec(spec)).toThrow();
  spec.questions.route.instructions = 'Valid';
  spec.questions.route.rationale = 'x'.repeat(501);
  expect(() => parseDecisionSpec(spec)).toThrow();
});

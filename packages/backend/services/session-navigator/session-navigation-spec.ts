import { parseDecisionSpec } from '../decision/decision-spec.js';

/**
 * Exception-only Phase 0 diagnostic contract for compaction boundaries or an
 * `inspect` turn-end result. It is not called during an in-progress response.
 * This spec is evidence-only and cannot authorize or execute an action.
 */
export const SESSION_NAVIGATOR_CONTINUITY_SHADOW_SPEC = parseDecisionSpec({
  schemaVersion: 1,
  id: 'tower.session-navigator.continuity',
  revision: 1,
  purpose: 'Assess bounded session goal alignment and semantic continuity without authorizing or executing actions.',
  mode: 'shadow',
  state: {
    maxBytes: 65_536,
    allowedData: ['project', 'session'],
    prohibitedFields: [
      'api_key',
      'authorization',
      'credential',
      'password',
      'private_key',
      'secret',
      'token',
    ],
  },
  questions: {
    goal_alignment: {
      type: 'choice',
      instructions: 'Compare the current action and recent turns with the anchored active goals.',
      criteria: {
        aligned: 'The current action materially advances an active goal within the supplied constraints.',
        minor_shift: 'The action is adjacent to the goal and reversible, but does not directly advance it.',
        material_drift: 'The action changes or abandons a goal, constraint, or completion criterion without evidence of user direction.',
        unknown: 'The supplied bounded evidence is insufficient or conflicting.',
      },
    },
    constraint_violation: {
      type: 'noul',
      instructions: 'Does the proposed or current action conflict with an active anchored user constraint?',
      criteria: {
        true: 'At least one active anchored constraint is contradicted.',
        false: 'No active anchored constraint is contradicted by the supplied action.',
      },
    },
    forgotten_commitment: {
      type: 'noul',
      instructions: 'Is an active Agent commitment omitted or contradicted by the current plan or result?',
      criteria: {
        true: 'An active anchored commitment is omitted or contradicted.',
        false: 'Active anchored commitments remain represented or are supported as resolved.',
      },
    },
    unresolved_work_ignored: {
      type: 'noul',
      instructions: 'Is unresolved work being treated as complete or bypassed without supporting evidence?',
      criteria: {
        true: 'An active unresolved item is ignored or incorrectly treated as complete.',
        false: 'Unresolved work is retained, resolved with evidence, or intentionally deferred with an anchor.',
      },
    },
    needs_historical_source: {
      type: 'noul',
      instructions: 'Is an anchored historical source excerpt required before relying on this assessment?',
      criteria: {
        true: 'Semantic state and recent turns conflict, omit a key fact, or lack enough source evidence.',
        false: 'The supplied semantic state and recent turns are sufficient and mutually consistent.',
      },
    },
    continuity: {
      type: 'choice',
      instructions: 'Classify semantic continuity across the supplied compaction boundary.',
      criteria: {
        preserved: 'Goals, constraints, decisions, commitments, and unresolved work are preserved.',
        goal_shifted: 'An active goal changed or disappeared without an anchored direction change.',
        constraint_lost: 'An active user constraint disappeared or was weakened.',
        decision_lost: 'An accepted or rejected decision disappeared or was reversed.',
        commitment_lost: 'An active Agent commitment disappeared or was contradicted.',
        unresolved_work_lost: 'An active unresolved item disappeared or was incorrectly completed.',
        needs_source_check: 'The bounded evidence cannot safely distinguish preservation from loss.',
      },
    },
  },
  policy: {
    minConfidence: 0.85,
    confidenceQuestionIds: ['goal_alignment', 'continuity'],
    onAbstain: 'observe_only',
  },
  tags: ['session-navigation', 'continuity', 'compaction', 'diagnostic', 'jev-pilot'],
});

/** @deprecated Use SESSION_NAVIGATOR_CONTINUITY_SHADOW_SPEC. */
export const SESSION_NAVIGATOR_SHADOW_SPEC = SESSION_NAVIGATOR_CONTINUITY_SHADOW_SPEC;

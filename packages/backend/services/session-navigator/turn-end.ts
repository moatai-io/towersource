import { z } from 'zod';
import { parseDecisionSpec } from '../decision/decision-spec.js';

const stableId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/);
const boundedText = z.string().trim().min(1).max(4_000);

/** Minimal bounded state assembled only after an assistant response has ended. */
export const turnEndDecisionStateSchema = z.object({
  schemaVersion: z.literal(1),
  sessionId: stableId,
  contextRevision: z.number().int().positive(),
  responseMessageId: stableId,
  responseEnded: z.literal(true),
  activeGoal: boundedText,
  completionCriteria: z.array(boundedText).max(20),
  assistantOutcome: boundedText,
  completedEvidence: z.array(boundedText).max(20),
  remainingAuthorizedSteps: z.array(boundedText).max(20),
  blockers: z.array(boundedText).max(20),
}).strict();

export type TurnEndDecisionState = z.infer<typeof turnEndDecisionStateSchema>;

export function parseTurnEndDecisionState(value: unknown): TurnEndDecisionState {
  return turnEndDecisionStateSchema.parse(value);
}

/**
 * Ordinary-turn shadow decision. Tower calls it once, after the assistant response
 * has ended and deterministic stop/approval/revision/budget gates have passed.
 */
export const TURN_END_CONTINUATION_SHADOW_SPEC = parseDecisionSpec({
  schemaVersion: 1,
  id: 'tower.session-navigator.turn-end',
  revision: 1,
  purpose: 'At assistant response end, choose the next bounded collaboration path and assess alignment, continuity, evidence, and completeness.',
  mode: 'shadow',
  state: {
    maxBytes: 16_384,
    allowedData: ['project', 'session'],
    prohibitedFields: [
      'api_key',
      'authorization',
      'credential',
      'password',
      'pending_approval',
      'private_key',
      'secret',
      'token',
    ],
  },
  questions: {
    continuation: {
      type: 'choice',
      instructions: 'Classify the correct state after the assistant response has ended. Do not create a new task or authority.',
      criteria: {
        continue: 'A concrete unfinished step remains inside the active goal and already-authorized scope, with supporting progress evidence and no stated blocker.',
        complete: 'The completion criteria are supported by evidence and no authorized work remains.',
        inspect: 'The direction may be valid, but evidence is missing, stale, conflicting, or insufficient; inspect bounded context before deciding.',
        revise: 'The goal and overall approach remain valid, but the latest answer or artifact should be reconsidered and improved before continuing.',
        replan: 'The current approach is blocked, inconsistent with the goal, or materially wrong; choose a different bounded path before continuing.',
        stop_for_human: 'Automatic progress must stop because the next useful step requires a user decision, answer, approval, or material scope expansion. This is an internal control result, not a user-facing action.',
      },
    },
    goal_alignment: {
      type: 'score',
      instructions: 'Score how well the latest assistant outcome remains aligned with the active user goal.',
      criteria: ['Misaligned', 'Partially aligned', 'Strongly aligned'],
    },
    conversation_continuity: {
      type: 'score',
      instructions: 'Score whether the latest outcome preserves the known conversational intent and constraints.',
      criteria: ['Continuity is broken', 'Continuity is uncertain', 'Continuity is preserved'],
    },
    evidence_sufficiency: {
      type: 'score',
      instructions: 'Score whether the supplied evidence is sufficient for the recommended path.',
      criteria: ['Insufficient', 'Partially sufficient', 'Sufficient'],
    },
    response_completeness: {
      type: 'score',
      instructions: 'Score how completely the latest outcome satisfies the active goal at this turn boundary.',
      criteria: ['Incomplete', 'Partially complete', 'Complete'],
    },
    constraint_loss: {
      type: 'noul',
      instructions: 'Is there evidence that a material user constraint may have been lost or contradicted?',
      criteria: { true: 'A material constraint may be lost or contradicted.', false: 'No material constraint loss is evident.' },
    },
    unfinished_commitment: {
      type: 'noul',
      instructions: 'Did the assistant leave a concrete commitment unfinished?',
      criteria: { true: 'A concrete commitment remains unfinished.', false: 'No concrete unfinished commitment is evident.' },
    },
  },
  policy: {
    minConfidence: 0.9,
    confidenceQuestionIds: ['continuation'],
    onAbstain: 'observe_only',
  },
  tags: ['session-navigation', 'turn-end', 'continuation', 'jev-pilot'],
});

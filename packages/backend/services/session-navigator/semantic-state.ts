import { z } from 'zod';

const stableId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/);
const nonEmptyText = z.string().trim().min(1).max(4_000);
const probability = z.number().min(0).max(1);

export const anchoredFactStatusSchema = z.enum(['active', 'superseded', 'resolved']);

export const anchoredFactSchema = z.object({
  id: stableId,
  text: nonEmptyText,
  sourceMessageIds: z.array(stableId).min(1).max(50),
  status: anchoredFactStatusSchema,
  confidence: probability,
}).strict();

const anchoredFacts = z.array(anchoredFactSchema).max(200);

export const sessionSemanticStateSchema = z.object({
  schemaVersion: z.literal(1),
  sessionId: stableId,
  revision: z.number().int().positive(),
  basedOnMessageId: stableId,
  originalIntent: anchoredFacts,
  currentGoals: anchoredFacts,
  successCriteria: anchoredFacts,
  userConstraints: anchoredFacts,
  userPreferences: anchoredFacts,
  acceptedDecisions: anchoredFacts,
  rejectedDirections: anchoredFacts,
  agentCommitments: anchoredFacts,
  unresolvedQuestions: anchoredFacts,
  currentPlan: anchoredFacts,
  completedEvidence: anchoredFacts,
  blockers: anchoredFacts,
  updatedAt: z.iso.datetime({ offset: true }),
}).strict().superRefine((state, ctx) => {
  const facts = [
    ...state.originalIntent,
    ...state.currentGoals,
    ...state.successCriteria,
    ...state.userConstraints,
    ...state.userPreferences,
    ...state.acceptedDecisions,
    ...state.rejectedDirections,
    ...state.agentCommitments,
    ...state.unresolvedQuestions,
    ...state.currentPlan,
    ...state.completedEvidence,
    ...state.blockers,
  ];
  const ids = new Set<string>();
  for (const fact of facts) {
    if (ids.has(fact.id)) {
      ctx.addIssue({ code: 'custom', message: `duplicate anchored fact id: ${fact.id}` });
    }
    ids.add(fact.id);
  }
});

export const compactionContinuitySchema = z.enum([
  'preserved',
  'goal_shifted',
  'constraint_lost',
  'decision_lost',
  'commitment_lost',
  'unresolved_work_lost',
  'needs_source_check',
]);

export type AnchoredFact = z.infer<typeof anchoredFactSchema>;
export type SessionSemanticState = z.infer<typeof sessionSemanticStateSchema>;
export type CompactionContinuity = z.infer<typeof compactionContinuitySchema>;

export function parseSessionSemanticState(value: unknown): SessionSemanticState {
  return sessionSemanticStateSchema.parse(value);
}

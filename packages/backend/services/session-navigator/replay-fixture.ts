import { z } from 'zod';
import { compactionContinuitySchema, sessionSemanticStateSchema } from './semantic-state.js';

const stableId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/);
const boundedText = z.string().trim().min(1).max(8_000);

export const replayExpectationSchema = z.object({
  goalAlignment: z.enum(['aligned', 'minor_shift', 'material_drift', 'unknown']),
  constraintViolation: z.boolean(),
  forgottenCommitment: z.boolean(),
  unresolvedWorkIgnored: z.boolean(),
  needsHistoricalSource: z.boolean(),
  continuity: compactionContinuitySchema,
  turnEndDecision: z.enum(['continue', 'complete', 'stop_for_human', 'inspect']),
  continuityDiagnosticRequired: z.boolean(),
  autoExecutionAllowed: z.literal(false),
}).strict();

export const sessionNavigatorReplayFixtureSchema = z.object({
  schemaVersion: z.literal(1),
  id: stableId,
  category: z.enum([
    'preserved',
    'goal_shifted',
    'constraint_lost',
    'decision_lost',
    'commitment_lost',
    'unresolved_work_lost',
    'needs_source_check',
    'approval_boundary',
    'stale_revision',
    'provider_failure',
  ]),
  description: boundedText,
  before: sessionSemanticStateSchema,
  after: sessionSemanticStateSchema,
  recentTurns: z.array(z.object({
    messageId: stableId,
    role: z.enum(['user', 'assistant', 'tool']),
    text: boundedText,
  }).strict()).min(1).max(12),
  candidateAction: z.object({
    id: stableId,
    contextRevision: z.number().int().positive(),
    intent: z.enum(['continue', 'inspect', 'clarify', 'replan', 'record_decision', 'complete', 'ask_human']),
    risk: z.enum(['read_only', 'reversible', 'approval_required']),
    source: z.enum(['user_click', 'jev_auto', 'agent_default', 'tower_rule']),
  }).strict(),
  currentContextRevision: z.number().int().positive(),
  providerStatus: z.enum(['available', 'timeout', 'error']),
  expected: replayExpectationSchema,
}).strict().superRefine((fixture, ctx) => {
  if (fixture.after.revision <= fixture.before.revision) {
    ctx.addIssue({ code: 'custom', message: 'after revision must be greater than before revision', path: ['after', 'revision'] });
  }
  if (fixture.before.sessionId !== fixture.after.sessionId) {
    ctx.addIssue({ code: 'custom', message: 'before and after must belong to the same session', path: ['after', 'sessionId'] });
  }
  const stale = fixture.candidateAction.contextRevision !== fixture.currentContextRevision;
  if (fixture.category === 'stale_revision' && !stale) {
    ctx.addIssue({ code: 'custom', message: 'stale_revision fixture must use a mismatched action revision', path: ['candidateAction', 'contextRevision'] });
  }
  if (fixture.category !== 'stale_revision' && stale) {
    ctx.addIssue({ code: 'custom', message: 'only stale_revision fixtures may use a mismatched action revision', path: ['candidateAction', 'contextRevision'] });
  }
  if (fixture.category === 'provider_failure' && fixture.providerStatus === 'available') {
    ctx.addIssue({ code: 'custom', message: 'provider_failure fixture must use timeout or error', path: ['providerStatus'] });
  }
  if (fixture.category === 'approval_boundary' && fixture.candidateAction.risk !== 'approval_required') {
    ctx.addIssue({ code: 'custom', message: 'approval_boundary fixture requires approval_required risk', path: ['candidateAction', 'risk'] });
  }
});

export type SessionNavigatorReplayFixture = z.infer<typeof sessionNavigatorReplayFixtureSchema>;

export function parseSessionNavigatorReplayFixtures(value: unknown): SessionNavigatorReplayFixture[] {
  return z.array(sessionNavigatorReplayFixtureSchema).min(30).parse(value);
}

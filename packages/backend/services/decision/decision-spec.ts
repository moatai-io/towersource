/**
 * Owns: provider-neutral, versioned contracts for fast probabilistic decisions.
 * Public API: parseDecisionSpec, decisionSpecSchema, DecisionSpec, DecisionRequest, DecisionResult.
 * See README.md.
 */
import { z } from 'zod';

const identifier = z.string().regex(/^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/).max(120);
const shortText = z.string().trim().min(1).max(500);
export const MAX_DECISION_INSTRUCTION_CHARS = 32_000;
const instructionText = z.string().trim().min(1).max(MAX_DECISION_INSTRUCTION_CHARS);
const criterionText = z.string().trim().min(1).max(1_000);
const probability = z.number().min(0).max(1);
const jsonValue: z.ZodType<unknown> = z.lazy(() => z.union([
  z.string(), z.number().finite(), z.boolean(), z.null(),
  z.array(jsonValue).max(1_000),
  z.record(z.string(), jsonValue),
]));

const commonQuestion = {
  instructions: instructionText,
  /** Optional operator-facing reason for keeping this atomic question in the spec. */
  rationale: shortText.optional(),
};

const choiceQuestionSchema = z.object({
  type: z.literal('choice'),
  ...commonQuestion,
  criteria: z.record(identifier, criterionText),
}).strict().superRefine((question, ctx) => {
  const count = Object.keys(question.criteria).length;
  if (count < 2 || count > 255) ctx.addIssue({ code: 'custom', message: 'choice criteria must contain 2..255 options', path: ['criteria'] });
});

const noulQuestionSchema = z.object({
  type: z.literal('noul'),
  ...commonQuestion,
  criteria: z.object({ true: criterionText, false: criterionText }).strict(),
}).strict();

const scoreQuestionSchema = z.object({
  type: z.literal('score'),
  ...commonQuestion,
  criteria: z.array(criterionText).min(2).max(20),
}).strict();

export const decisionQuestionSchema = z.discriminatedUnion('type', [
  choiceQuestionSchema,
  noulQuestionSchema,
  scoreQuestionSchema,
]);

const decisionPolicySchema = z.object({
  /** Minimum provider confidence required before Tower may consume the answer. */
  minConfidence: probability,
  /** Only these confidence-bearing questions gate the overall disposition. Empty means all. */
  confidenceQuestionIds: z.array(identifier).max(64).default([]),
  /** A rejected or unavailable answer never silently becomes authorization. */
  onAbstain: z.enum(['fallback', 'needs_human', 'observe_only']),
  fallbackPolicyId: identifier.optional(),
}).strict().superRefine((policy, ctx) => {
  if (policy.onAbstain === 'fallback' && !policy.fallbackPolicyId) {
    ctx.addIssue({ code: 'custom', message: 'fallbackPolicyId required when onAbstain=fallback', path: ['fallbackPolicyId'] });
  }
  if (policy.onAbstain !== 'fallback' && policy.fallbackPolicyId) {
    ctx.addIssue({ code: 'custom', message: 'fallbackPolicyId is only valid when onAbstain=fallback', path: ['fallbackPolicyId'] });
  }
});

export const decisionSpecSchema = z.object({
  schemaVersion: z.literal(1),
  id: identifier,
  revision: z.number().int().positive(),
  purpose: shortText,
  /**
   * Decision output is advisory or shadow evidence only. Platform authorization,
   * approval and destructive-action gates remain deterministic Tower policy.
   */
  mode: z.enum(['shadow', 'advisory']),
  state: z.object({
    maxBytes: z.number().int().positive().max(1_000_000),
    allowedData: z.array(z.enum(['public', 'project', 'session'])).min(1),
    prohibitedFields: z.array(identifier).max(100).default([]),
  }).strict(),
  questions: z.record(identifier, decisionQuestionSchema),
  policy: decisionPolicySchema,
  tags: z.array(identifier).max(20).default([]),
}).strict().superRefine((spec, ctx) => {
  const count = Object.keys(spec.questions).length;
  if (count < 1 || count > 64) ctx.addIssue({ code: 'custom', message: 'questions must contain 1..64 atomic questions', path: ['questions'] });
  for (const id of spec.policy.confidenceQuestionIds) {
    const question = spec.questions[id];
    if (!question) ctx.addIssue({ code: 'custom', message: `confidence question not found: ${id}`, path: ['policy', 'confidenceQuestionIds'] });
    else if (question.type === 'noul') ctx.addIssue({ code: 'custom', message: `noul question has no confidence: ${id}`, path: ['policy', 'confidenceQuestionIds'] });
  }
});

export type DecisionSpec = z.infer<typeof decisionSpecSchema>;
export type DecisionQuestion = z.infer<typeof decisionQuestionSchema>;

export function parseDecisionSpec(value: unknown): DecisionSpec {
  return decisionSpecSchema.parse(value);
}

export interface DecisionRequest {
  specId: string;
  specRevision: number;
  state: unknown;
}

export type DecisionAnswer =
  | { type: 'choice'; choice: string; probabilities: Record<string, number>; confidence: number }
  | { type: 'noul'; noul: number }
  | { type: 'score'; score: number; probabilities: Record<string, number>; confidence: number; legend: Record<string, string> };

export interface DecisionResult {
  specId: string;
  specRevision: number;
  provider: string;
  model: string;
  latencyMs: number;
  answers: Record<string, DecisionAnswer>;
  disposition: 'accepted' | 'abstained' | 'fallback' | 'needs_human' | 'observed';
  usage?: { inputTokens?: number; outputTokens?: number; costUsd?: number };
}

/** Stable JSON-safe state encoding used for byte-limit enforcement by adapters. */
export function encodeDecisionState(state: unknown): string {
  return JSON.stringify(jsonValue.parse(state));
}

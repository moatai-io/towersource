/**
 * Owns: Durable Agent Session message envelope types and boundary validation.
 * Public API: AgentMessageEnvelopeInput, normalizeAgentMessageEnvelope.
 * See README.md.
 */

import { z } from 'zod';

export const agentMessageKinds = ['request', 'reply', 'report', 'status', 'coordination', 'system'] as const;
export const agentMessageDeliveryPolicies = ['wake', 'inject', 'active-only', 'store-only'] as const;
export const agentMessagePriorities = ['normal', 'high'] as const;

const agentMessageBodySchema = z.record(z.string(), z.unknown());

const agentMessageEnvelopeInputSchema = z.object({
  id: z.string().min(1),
  senderSessionId: z.string().min(1),
  recipientSessionId: z.string().min(1),
  senderUserId: z.number().int().positive().nullable(),
  projectId: z.string().min(1).nullable().optional(),
  kind: z.enum(agentMessageKinds),
  body: agentMessageBodySchema,
  deliveryPolicy: z.enum(agentMessageDeliveryPolicies),
  priority: z.enum(agentMessagePriorities).default('normal'),
  correlationId: z.string().min(1),
  causationId: z.string().min(1).nullable().optional(),
  inReplyToMessageId: z.string().min(1).nullable().optional(),
  rootConversationId: z.string().min(1),
  workerId: z.string().min(1).nullable().optional(),
  agentRunId: z.string().min(1).nullable().optional(),
  sourceRootTurnId: z.string().min(1).nullable().optional(),
  operationId: z.string().min(1).nullable().optional(),
  expiresAt: z.string().datetime({ offset: true }).nullable().optional(),
}).strict().superRefine((value, ctx) => {
  if (value.senderSessionId === value.recipientSessionId) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['recipientSessionId'], message: 'Sender and recipient Sessions must differ' });
  }
  if (value.kind === 'reply' && !value.inReplyToMessageId) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['inReplyToMessageId'], message: 'Replies require inReplyToMessageId' });
  }
});

export type AgentMessageEnvelopeInput = z.input<typeof agentMessageEnvelopeInputSchema>;
export type AgentMessageEnvelope = z.output<typeof agentMessageEnvelopeInputSchema>;

/** Validate and normalize an envelope before it crosses the persistence boundary. */
export function normalizeAgentMessageEnvelope(input: AgentMessageEnvelopeInput): AgentMessageEnvelope {
  return agentMessageEnvelopeInputSchema.parse(input);
}

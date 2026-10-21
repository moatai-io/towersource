import { Type, type TSchema } from '@sinclair/typebox';
import { z } from 'zod';
import { createGoalSession, goalCommandSchema, type GoalScope, type GoalStore } from './goal-session.js';

export const goalToolRequestSchema = z.object({
  requestId: z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/),
  expectedVersion: z.number().int().min(0), command: goalCommandSchema,
}).strict();

/** Engine-neutral protocol. Adapters may expose these as MCP or native tools.
 * Executing a tool records progress; it never invokes an engine or schedules work.
 */
export interface GoalToolDefinition {
  name: string;
  label: string;
  description: string;
  parameters: TSchema;
  execute(callId: string, input: unknown): Promise<{
    content: { type: 'text'; text: string }[];
    details: undefined;
    isError: boolean;
  }>;
}

export interface GoalToolAuthority {
  /** Closure-authorized host gate; MUST also be rechecked in the store transaction. */
  authorize(scope: GoalScope, action: string): Promise<boolean>;
  /** Trusted receipt lookup, not an LLM judging its own claim.
   * Reject missing/mismatched criterion, revision, scope, or receipt.
   */
  verifyCheck(scope: GoalScope, command: Extract<z.infer<typeof goalCommandSchema>, { action: 'check' }>, expectedVersion: number): Promise<boolean>;
}

/** Unregistered factory. Enabling it requires host authority/receipt adapters. */
export function createGoalTools(scope: GoalScope, store: GoalStore, authority: GoalToolAuthority): GoalToolDefinition[] {
  const bound = Object.freeze({ ...scope });
  const session = createGoalSession(bound, store);
  return createGoalServiceTools({
    status: async () => {
      if (!await authority.authorize(bound, 'status')) throw new GoalToolError('GOAL_ACTION_DENIED');
      return session.status();
    },
    execute: async request => {
      if (!await authority.authorize(bound, request.command.action)) throw new GoalToolError('GOAL_ACTION_DENIED');
      if (request.command.action === 'check' && !await authority.verifyCheck(bound, request.command, request.expectedVersion)) throw new GoalToolError('GOAL_EVIDENCE_UNVERIFIED');
      return session.execute(request);
    },
  });
}

export class GoalToolError extends Error {}

export interface GoalToolService {
  status(): Promise<{version:number; state: import('./goal-loop.js').GoalState} | null>;
  execute(request: z.infer<typeof goalToolRequestSchema>): Promise<{version:number; state: import('./goal-loop.js').GoalState}>;
}
/** Common surface; service must enforce authority and evidence transactionally. */
export function createGoalServiceTools(session: GoalToolService): GoalToolDefinition[] {
  const result = (value: unknown, isError = false) => ({ content: [{ type: 'text' as const, text: JSON.stringify(value) }], details: undefined, isError });
  return [{
    name: 'goal_step', label: '목표 단계 진행',
    description: 'Start or advance an explicitly requested bounded goal. Records Inspect → Change → Check; does not execute changes itself or grant action permission. Call goal_status for current version. Check evidence requires host-verifiable receipts. Use stop for approval waits or justified abandonment.',
    parameters: Type.Unsafe(z.toJSONSchema(goalToolRequestSchema, { target: 'draft-7' })),
    async execute(_id, input) {
      try {
        const request = goalToolRequestSchema.parse(input);
        const record = await session.execute(request);
        return result({ version: record.version, state: record.state });
      } catch (error) {
        if (error instanceof GoalToolError && ['GOAL_ACTION_DENIED','GOAL_EVIDENCE_UNVERIFIED'].includes(error.message)) return result({error:error.message},true);
        // No raw DB/provider error or ownership details in model-facing output.
        return result({ error: 'GOAL_COMMAND_REJECTED', next: 'Read goal_status; do not retry changes or reset the goal.' }, true);
      }
    },
  }, {
    name: 'goal_status', label: '목표 상태 확인',
    description: 'Read the current closure-bound goal state and version without advancing the loop or updating its timestamp.',
    parameters: Type.Object({}, { additionalProperties: false }),
    async execute(_id, input) {
      try {
        z.object({}).strict().parse(input);
        const record = await session.status();
        return result(record ? { version: record.version, state: record.state } : { version: 0, state: null });
      } catch { return result({ error: 'GOAL_STATUS_UNAVAILABLE' }, true); }
    },
  }];
}

import { z } from 'zod';
import type { BoundGoalRuntime } from './goal-binding.js';
import type { SkillInvocation } from '../skill/skill-invocation.js';

const requestSchema = z.object({ goal: z.string().trim().min(1).max(12000), origin: z.literal('explicit-skill') }).strict();
export type GoalExecutionRequest = z.infer<typeof requestSchema>;
/** This metadata is derived server-side from resolved slash invocation, never data.goal. */
export function goalRequestFromInvocation(invocation: Pick<SkillInvocation, 'skillName' | 'explicit' | 'args'> | null | undefined): GoalExecutionRequest | undefined {
  if (!invocation?.explicit || invocation.skillName !== 'goal' || !invocation.args.trim()) return undefined;
  const parsed = requestSchema.safeParse({ goal: invocation.args, origin: 'explicit-skill' });
  return parsed.success ? parsed.data : undefined;
}
export interface GoalAdmissionContext {
  sessionId: string; rootTurnId: string; projectId: string; userId: number;
  ownerToken: string; ownerBootId: string;
}
export interface GoalRuntimeProvider {
  /** No writes/model calls. Confirm schema, checker binding and allowed project. */
  ready(context: GoalAdmissionContext): Promise<boolean>;
  create(context: GoalAdmissionContext, request: GoalExecutionRequest): Promise<BoundGoalRuntime>;
}
export type GoalAdmission =
  | { kind: 'ordinary' }
  | { kind: 'unavailable'; reason: string }
  | { kind: 'ready'; runtime: BoundGoalRuntime };

export async function admitGoal(request: GoalExecutionRequest | undefined, context: GoalAdmissionContext, provider?: GoalRuntimeProvider): Promise<GoalAdmission> {
  if (!request) return { kind: 'ordinary' };
  if (!provider) return { kind: 'unavailable', reason: 'goal_runtime_not_installed' };
  const parsed = requestSchema.safeParse(request);
  if (!parsed.success || !context.sessionId || !context.rootTurnId || !context.projectId || !Number.isSafeInteger(context.userId)
      || context.userId <= 0 || !context.ownerToken || !context.ownerBootId) return { kind: 'unavailable', reason: 'goal_context_invalid' };
  try {
    if (!await provider.ready(context)) return { kind: 'unavailable', reason: 'goal_runtime_not_ready' };
    const runtime = await provider.create(Object.freeze({ ...context }), parsed.data);
    const names = runtime.tools.map(t => t.name);
    if (!names.includes('goal_step') || !names.includes('goal_status')) return { kind: 'unavailable', reason: 'goal_tools_missing' };
    return { kind: 'ready', runtime };
  } catch { return { kind: 'unavailable', reason: 'goal_runtime_initialization_failed' }; }
}

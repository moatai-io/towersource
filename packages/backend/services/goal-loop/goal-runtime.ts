import { createGoalTools, type GoalToolAuthority } from './goal-tools.js';
import { createGoalSession, type GoalScope, type GoalStore } from './goal-session.js';
import { continueGoal, type ContinuationContext } from './goal-continuation.js';

export interface GoalRuntimeHost {
  context(): Promise<ContinuationContext>;
  /** Atomically claim expectedVersion and recheck stop/root/owner/approval.
   * Run one model invocation with the tools provided by this runtime factory.
   * Return false on denied claim; propagate ambiguous execution errors.
   */
  invoke(expectedVersion: number, phase: string, signal: AbortSignal): Promise<boolean>;
}

/** Opt-in composition boundary. Disabled returns no tools and never touches storage.
 * Hosts must construct this per root turn (not cache it across session turns).
 * Do not call inside agent-turn transport recovery: only after normal invocation.
 */
export function createGoalRuntime(input: {
  enabled: boolean;
  scope: GoalScope;
  store: GoalStore;
  authority: GoalToolAuthority;
  host: GoalRuntimeHost;
}): {
  tools: ReturnType<typeof createGoalTools>;
  afterInvocation(signal: AbortSignal): Promise<{ invocations: number; reason: string }>;
} {
  if (!input.enabled) return { tools: [], afterInvocation: async (_signal: AbortSignal) => ({ invocations: 0, reason: 'disabled' }) };
  const session = createGoalSession(input.scope, input.store);
  let active = false;
  return {
    tools: createGoalTools(input.scope, input.store, input.authority),
    async afterInvocation(signal: AbortSignal) {
      if (active) return { invocations: 0, reason: 'already_running' };
      active = true;
      try {
        const initial = await session.status();
        if (!initial) return { invocations: 0, reason: 'no_goal' };
        return await continueGoal({
          read: async () => {
            const record = await session.status();
            if (!record) throw new Error('GOAL_DISAPPEARED');
            return record;
          },
          context: () => input.host.context(),
          dispatch: (version, phase, s) => input.host.invoke(version, phase, s),
        }, signal, 45);
      } finally { active = false; }
    },
  };
}

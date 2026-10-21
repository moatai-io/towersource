import type { GoalToolDefinition as ToolDefinition } from './goal-tools.js';
import { getCurrentRootTurn } from '../agent-turn/current-root-turn.js';

export interface BoundGoalRuntime {
  tools: ToolDefinition[];
  afterInvocation(signal: AbortSignal): Promise<{ invocations: number; reason: string }>;
}
interface Binding { root: string; token: symbol; runtime: BoundGoalRuntime; controller: AbortController }

/** Process-local bridge for cached SDK tools, not a distributed owner/ACL gate.
 * One instance belongs to one SDK session and must be disposed with that session.
 * Host still supplies transaction-fenced authority on every real action.
 */
export function createGoalTurnBinding(sessionId: string, currentRoot: () => string | undefined = () => getCurrentRootTurn(sessionId)) {
  let binding: Binding | undefined;
  let activeCalls = 0;
  let disposed = false;
  let continuationActive = false;
  const unavailable = () => ({ content: [{ type: 'text' as const, text: '{"error":"GOAL_TURN_UNAVAILABLE"}' }], details: undefined, isError: true });
  function current(): Binding | undefined {
    return !disposed && binding?.root === currentRoot() ? binding : undefined;
  }
  return {
    /** A still-running old callback is not safe to replace, even if its root changed. */
    bind(root: string, runtime: BoundGoalRuntime) {
      if (disposed || activeCalls || continuationActive || binding || !root || currentRoot() !== root) throw new Error('GOAL_BINDING_REJECTED');
      if (new Set(runtime.tools.map(t => t.name)).size !== runtime.tools.length) throw new Error('DUPLICATE_GOAL_TOOL');
      const token = Symbol(root);
      binding = { root, runtime, token, controller: new AbortController() };
      return () => {
        if (binding?.token === token) { binding.controller.abort(); binding = undefined; }
      };
    },
    /** Tool schema stays cached; execute resolves the current root at call time. */
    proxy(definition: ToolDefinition): ToolDefinition {
      return { ...definition, async execute(...args) {
        const selected = current();
        const tool = selected?.runtime.tools.find(t => t.name === definition.name);
        if (!selected || !tool || activeCalls) return unavailable();
        activeCalls++;
        try {
          const result = await tool.execute(...args);
          // Do not deliver a prior turn's result into a replaced session context.
          return current()?.token === selected.token ? result : unavailable();
        } finally { activeCalls--; }
      } };
    },
    async afterInvocation(signal: AbortSignal) {
      const selected = current();
      if (!selected || activeCalls || continuationActive || signal.aborted) return { invocations: 0, reason: 'goal_turn_unavailable' };
      // Do not hold the tool-call lock: continuation must be able to call tools.
      continuationActive = true;
      try {
        return await selected.runtime.afterInvocation(AbortSignal.any([signal, selected.controller.signal]));
      } finally { continuationActive = false; }
    },
    dispose() { disposed = true; binding?.controller.abort(); binding = undefined; },
  };
}

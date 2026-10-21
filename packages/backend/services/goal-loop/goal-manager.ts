import type { GoalState } from './goal-loop.js';

/** Persistent goal identity survives independently owned engine turns. */
export interface ManagedGoal {
  id: string;
  userId: number;
  projectId: string;
  sessionId: string;
  version: number;
  state: GoalState;
  activeExecution: { rootTurnId: string; startProgressVersion: number } | null;
  progressVersion: number;
  dispatched: number;
  maxExecutions: number;
  processedTerminalIds: string[];
}
export interface GoalTerminal {
  id: string;
  rootTurnId: string;
  outcome: 'completed' | 'failed' | 'aborted' | 'uncertain';
}
/** All observations come from durable server state, never LLM arguments. */
export interface GoalManagerSnapshot {
  goal: ManagedGoal;
  terminal: GoalTerminal;
  authorized: boolean;
  userStopped: boolean;
  waitingApproval: boolean;
  superseded: boolean;
  uncertainEffects: boolean;
  completionVerified: boolean;
}
export interface GoalDispatchIntent {
  key: string;
  goalId: string;
  expectedGoalVersion: number;
  phase: GoalState['phase'];
  userId: number;
  projectId: string;
  sessionId: string;
}
export type GoalSettlement =
  | { kind: 'ignore'; reason: string }
  | { kind: 'settle'; goal: ManagedGoal; reason: string; intent?: GoalDispatchIntent };

/** One terminal event, one decision. Never runs an engine or transport retry. */
export function decideGoalSettlement(s: GoalManagerSnapshot): GoalSettlement {
  const g = s.goal;
  if (!s.authorized) return { kind: 'ignore', reason: 'unauthorized' };
  if (g.processedTerminalIds.includes(s.terminal.id)) return { kind: 'ignore', reason: 'duplicate_terminal' };
  if (!g.activeExecution || g.activeExecution.rootTurnId !== s.terminal.rootTurnId) return { kind: 'ignore', reason: 'stale_execution' };
  if (!Number.isInteger(g.maxExecutions) || g.maxExecutions < 1 || g.maxExecutions > 45
      || !Number.isInteger(g.dispatched) || g.dispatched < 1 || g.processedTerminalIds.length >= 45) {
    return { kind: 'ignore', reason: 'invalid_execution_budget' };
  }
  const next = structuredClone(g);
  next.version++;
  next.activeExecution = null;
  next.processedTerminalIds.push(s.terminal.id);
  const stop = (status: 'stopped' | 'needs_input', reason: string): GoalSettlement => {
    next.state.status = status;
    next.state.reason = reason;
    return { kind: 'settle', goal: next, reason };
  };
  // Persisted stop is authoritative even if the observation predates it.
  if (g.state.status === 'stopped') return { kind: 'settle', goal: next, reason: g.state.reason ?? 'stopped' };
  // Safety observations outrank even a claimed completion.
  if (s.userStopped) return stop('stopped', 'user_stopped');
  if (s.superseded) return stop('stopped', 'superseded');
  if (s.waitingApproval) return stop('needs_input', 'waiting_approval');
  if (s.uncertainEffects || s.terminal.outcome === 'uncertain') return stop('needs_input', 'uncertain_effects');
  if (s.terminal.outcome !== 'completed') return stop('needs_input', 'execution_not_completed');
  if (g.state.status === 'completed') {
    if (!s.completionVerified) return stop('needs_input', 'completion_unverified');
    return { kind: 'settle', goal: next, reason: 'completed' };
  }
  if (g.state.status !== 'running') return { kind: 'settle', goal: next, reason: g.state.status };
  if (g.progressVersion <= g.activeExecution.startProgressVersion) return stop('needs_input', 'no_state_progress');
  if (g.dispatched >= g.maxExecutions) return stop('stopped', 'execution_budget_exhausted');
  if (g.state.phase === 'inspect' && g.state.cycles >= g.state.maxCycles) return stop('stopped', 'cycle_budget_exhausted');
  return { kind: 'settle', goal: next, reason: 'next_execution', intent: {
    key: `goal:${g.id}:version:${next.version}`, goalId: g.id, expectedGoalVersion: next.version,
    phase: g.state.phase, userId: g.userId, projectId: g.projectId, sessionId: g.sessionId,
  } };
}

export interface GoalManagerStore {
  /** Lock goal + read authorized durable terminal/safety/receipt state. Apply the
   * returned goal update and UNIQUE intent in the SAME transaction. Roll back both
   * on failure. Do not let a tool/client supply the snapshot. No model calls here.
   */
  settleTerminal(goalId: string, terminalId: string,
    decide: (snapshot: GoalManagerSnapshot) => GoalSettlement): Promise<GoalSettlement>;
}
export function createGoalManager(store: GoalManagerStore) {
  return {
    onTerminal(goalId: string, terminalId: string) {
      if (!goalId.trim() || !terminalId.trim()) throw new Error('INVALID_TERMINAL_REFERENCE');
      return store.settleTerminal(goalId, terminalId, snapshot => {
        if (snapshot.goal.id !== goalId || snapshot.terminal.id !== terminalId) throw new Error('GOAL_EVENT_MISMATCH');
        return decideGoalSettlement(snapshot);
      });
    },
  };
}

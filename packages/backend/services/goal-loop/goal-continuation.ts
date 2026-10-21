import type { GoalRecord } from './goal-session.js';

/** All flags are host observations, not model/tool parameters. */
export interface ContinuationContext {
  latestRootTurnId: string;
  ownerTokenValid: boolean;
  userStopped: boolean;
  waitingApproval: boolean;
  uncertainSideEffect: boolean;
  invocationOutcome: 'completed' | 'failed' | 'aborted';
}
export function decideGoalContinuation(record: GoalRecord, context: ContinuationContext): { continue: boolean; reason: string } {
  if (context.userStopped) return { continue: false, reason: 'user_stopped' };
  if (context.waitingApproval) return { continue: false, reason: 'waiting_approval' };
  if (!context.ownerTokenValid) return { continue: false, reason: 'ownership_lost' };
  if (context.latestRootTurnId !== record.scope.rootTurnId) return { continue: false, reason: 'superseded' };
  if (context.uncertainSideEffect) return { continue: false, reason: 'uncertain_side_effect' };
  if (context.invocationOutcome !== 'completed') return { continue: false, reason: 'invocation_not_completed' };
  if (record.state.status !== 'running') return { continue: false, reason: record.state.status };
  if (record.state.phase === 'inspect' && record.state.cycles >= record.state.maxCycles) return { continue: false, reason: 'cycle_budget_exhausted' };
  return { continue: true, reason: `next_${record.state.phase}` };
}

export interface ContinuationPorts {
  read(): Promise<GoalRecord>;
  context(): Promise<ContinuationContext>;
  /** Must atomically fence ownership/root/stop/approval again before model dispatch.
   * Expected version prevents two dispatchers from advancing the same record.
   * Return false when the claim was denied. Do not replay uncertain invocations.
   */
  dispatch(expectedVersion: number, nextPhase: string, signal: AbortSignal): Promise<boolean>;
}

/** Bounded model continuation driver; production host adapter is not wired yet. */
export async function continueGoal(ports: ContinuationPorts, signal: AbortSignal, maxInvocations = 15) {
  if (!Number.isInteger(maxInvocations) || maxInvocations < 1 || maxInvocations > 45) throw new Error('INVALID_INVOCATION_BUDGET');
  let invocations = 0;
  while (invocations < maxInvocations) {
    if (signal.aborted) return { invocations, reason: 'cancelled' };
    const before = await ports.read();
    const decision = decideGoalContinuation(before, await ports.context());
    if (!decision.continue) return { invocations, reason: decision.reason };
    if (signal.aborted) return { invocations, reason: 'cancelled' };
    // Errors intentionally propagate; an exception is not authorization to retry.
    const claimed = await ports.dispatch(before.version, before.state.phase, signal);
    if (!claimed) return { invocations, reason: 'claim_denied' };
    invocations++;
    if (signal.aborted) return { invocations, reason: 'cancelled' };
    const after = await ports.read();
    if (after.version <= before.version) return { invocations, reason: 'no_state_progress' };
    const next = decideGoalContinuation(after, await ports.context());
    if (!next.continue) return { invocations, reason: next.reason };
  }
  return { invocations, reason: 'invocation_budget_exhausted' };
}

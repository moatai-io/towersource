import { transitionGoal } from './goal-transition.js';
/** Engine-neutral bounded goal runner. Not registered as a production tool yet. */
export type Phase = 'inspect' | 'change' | 'check';
export type Status = 'running' | 'completed' | 'needs_input' | 'stopped';
export type Outcome = 'improved' | 'unchanged' | 'regressed' | 'inconclusive';
export interface Criterion { id: string; description: string }
export interface Evidence { criterionId: string; revision: string; reference: string; passed: boolean }
export interface GoalState {
  version: 1;
  goal: string;
  criteria: Criterion[];
  maxCycles: number;
  cycles: number;
  status: Status;
  phase: Phase;
  revision: string;
  noProgress: number;
  strategyChangeRequired: boolean;
  reason?: string;
  evidence: Evidence[];
}
export interface Observation {
  decision: 'change' | 'verify' | 'needs_input' | 'stopped';
  reason: string;
  strategyChanged?: boolean;
}
export interface CheckResult { outcome: Outcome; evidence: Evidence[] }
export interface GoalPorts {
  /** Caller supplies closure-authorized implementations and bounded commands. */
  inspect(state: Readonly<GoalState>, signal: AbortSignal): Promise<Observation>;
  change(state: Readonly<GoalState>, observation: Observation, signal: AbortSignal): Promise<{ revision: string }>;
  check(state: Readonly<GoalState>, signal: AbortSignal): Promise<CheckResult>;
  /** Persist atomically before continuing; failures must prevent further work. */
  save(state: Readonly<GoalState>): Promise<void>;
}

export function startGoal(goal: string, criteria: Criterion[], maxCycles = 5): GoalState {
  if (!goal.trim() || !criteria.length || criteria.some(c => !c.id.trim() || !c.description.trim())
    || new Set(criteria.map(c => c.id)).size !== criteria.length) throw new Error('INVALID_GOAL');
  if (!Number.isInteger(maxCycles) || maxCycles < 1 || maxCycles > 15) throw new Error('INVALID_BUDGET');
  return { version: 1, goal, criteria: structuredClone(criteria), maxCycles, cycles: 0,
    status: 'running', phase: 'inspect', revision: 'initial', noProgress: 0,
    strategyChangeRequired: false, evidence: [] };
}

export function hasCompleteEvidence(state: GoalState): boolean {
  return state.criteria.every(c => state.evidence.some(e => e.criterionId === c.id
    && e.passed && e.revision === state.revision && Boolean(e.reference.trim())));
}

/**
 * Actual code loop: one run owns the state; adapters must fence concurrent owners.
 * Abort/timeouts are cooperative. No next callback is issued after cancellation;
 * an adapter that ignores the signal must not be assumed terminated/replayed.
 * Loaded running states must be reconciled by the host, never blindly replayed.
 */
export async function runGoal(initial: GoalState, ports: GoalPorts, signal: AbortSignal): Promise<GoalState> {
  let state = structuredClone(initial);
  if (state.status !== 'running') return state;
  if (state.cycles !== 0 || state.phase !== 'inspect') throw new Error('RECONCILIATION_REQUIRED');
  const persist = async () => ports.save(structuredClone(state));
  const stop = async (status: Status, reason: string) => {
    state = { ...state, status, reason };
    await persist();
    return structuredClone(state);
  };
  const snapshot = () => structuredClone(state);
  await persist();
  while (state.cycles < state.maxCycles) {
    if (signal.aborted) return stop('stopped', 'cancelled');
    state.phase = 'inspect';
    await persist();
    let observation: Observation;
    try { observation = await ports.inspect(snapshot(), signal); }
    catch { return stop('needs_input', 'inspect_failed'); }
    if (signal.aborted) return stop('stopped', 'cancelled');
    if (observation.decision === 'needs_input' || observation.decision === 'stopped') {
      return stop(observation.decision, observation.reason);
    }
    if (observation.decision !== 'change' && observation.decision !== 'verify') {
      return stop('needs_input', 'invalid_observation');
    }
    state = transitionGoal(state, { action: 'inspect', decision: observation.decision, reason: observation.reason, strategyChanged: observation.strategyChanged ?? false });
    if (state.status !== 'running') { await persist(); return state; }
    if (observation.decision === 'change') {
      state.phase = 'change';
      await persist();
      try {
        const changed = await ports.change(snapshot(), observation, signal);
        if (!changed.revision.trim() || changed.revision === state.revision) {
          return stop('needs_input', 'invalid_change_revision');
        }
        state = transitionGoal(state, { action: 'change', revision: changed.revision });
      } catch { return stop('needs_input', 'change_result_uncertain'); }
      if (signal.aborted) return stop('needs_input', 'cancelled_after_change');
    }
    state.phase = 'check';
    await persist();
    let checked: CheckResult;
    try { checked = await ports.check(snapshot(), signal); }
    catch { return stop('needs_input', 'check_failed'); }
    if (signal.aborted) return stop('stopped', 'cancelled');
    if (!['improved', 'unchanged', 'regressed', 'inconclusive'].includes(checked.outcome)
      || !Array.isArray(checked.evidence)) return stop('needs_input', 'invalid_check');
    try { state = transitionGoal(state, { action: 'check', ...checked }); }
    catch { return stop('needs_input', 'invalid_check'); }
    if (state.status !== 'running') { await persist(); return state; }
    await persist();
  }
  return stop('stopped', 'cycle_budget_exhausted');
}

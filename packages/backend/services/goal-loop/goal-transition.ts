import { startGoal, hasCompleteEvidence, type GoalState } from './goal-loop.js';
import type { GoalCommand } from './goal-session.js';

export function transitionGoal(previous: GoalState | null, command: GoalCommand): GoalState {
  if (command.action === 'start') {
    if (previous) throw new Error('GOAL_ALREADY_EXISTS');
    return startGoal(command.goal, command.criteria, command.maxCycles);
  }
  if (!previous || previous.status !== 'running') throw new Error('GOAL_NOT_RUNNING');
  const state = structuredClone(previous);
  if (command.action === 'stop') return { ...state, status: command.status, reason: command.reason };
  if (command.action !== state.phase) throw new Error('INVALID_PHASE');
  if (command.action === 'inspect') {
    if (state.cycles >= state.maxCycles) throw new Error('BUDGET_EXHAUSTED');
    state.cycles++;
    if (state.strategyChangeRequired && !command.strategyChanged) {
      return { ...state, status: 'stopped', reason: 'strategy_change_required' };
    }
    state.phase = command.decision === 'change' ? 'change' : 'check';
  } else if (command.action === 'change') {
    if (command.revision === state.revision) throw new Error('INVALID_CHANGE_REVISION');
    state.revision = command.revision;
    state.evidence = [];
    state.phase = 'check';
  } else {
    const ids = command.evidence.map(e => e.criterionId);
    if (new Set(ids).size !== ids.length || ids.some(id => !state.criteria.some(c => c.id === id))) throw new Error('INVALID_EVIDENCE');
    state.evidence = command.evidence;
    if (!['inconclusive', 'regressed'].includes(command.outcome) && hasCompleteEvidence(state)) {
      state.status = 'completed'; state.reason = 'criteria_verified';
    } else if (command.outcome !== 'improved' && state.strategyChangeRequired) {
      state.status = 'stopped'; state.reason = 'no_progress_after_strategy_change';
    } else if (state.cycles >= state.maxCycles) {
      state.status = 'stopped'; state.reason = 'cycle_budget_exhausted';
    } else {
      state.noProgress = command.outcome === 'improved' ? 0 : state.noProgress + 1;
      state.strategyChangeRequired = state.noProgress >= 2;
      state.phase = 'inspect';
    }
  }
  return state;
}


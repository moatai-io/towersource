import { describe, expect, it } from 'vitest';
import { automationResultSessionId, isUnverifiedAiSpawn } from './automation-result-reference.js';

describe('Automation result references', () => {
  it('never treats a spawned task or command job as a session', () => {
    const result = { runnerKind: 'ai', resultId: 'task-1' };
    expect(automationResultSessionId(result, { mode: 'spawn' })).toBeNull();
    expect(automationResultSessionId({ ...result, runnerRef: 'workbench-job-1' }, { mode: 'inject' })).toBeNull();
    expect(automationResultSessionId({ ...result, runnerKind: 'system' }, { mode: 'channel' })).toBeNull();
  });
  it.each(['inject', 'channel'])('preserves %s session references', mode => {
    expect(automationResultSessionId({ runnerKind: 'ai', resultId: 'session-1' }, { mode })).toBe('session-1');
  });
  it.each(['success', 'spawned'])('does not infer completion from %s admission', status => {
    expect(isUnverifiedAiSpawn({ mode: 'spawn', runnerKind: 'ai', status }, { jobType: 'ai_prompt' })).toBe(true);
  });
  it('does not downgrade command success or hide known failure', () => {
    expect(isUnverifiedAiSpawn({ mode: 'spawn', runnerKind: 'ai', status: 'failed' }, { jobType: 'ai_prompt' })).toBe(false);
    expect(isUnverifiedAiSpawn({ mode: 'spawn', runnerKind: 'system', status: 'success' }, { jobType: 'shell' })).toBe(false);
  });
});

it('links verified terminal tasks without reclassifying historical admission', () => {
  const run = { mode: 'spawn', runnerKind: 'ai', status: 'success', resultId: 'task-1', runnerRef: 'completed-session:session-1' };
  expect(automationResultSessionId(run, { mode: 'spawn' })).toBe('session-1');
  expect(isUnverifiedAiSpawn(run, { jobType: 'ai_prompt' })).toBe(false);
});

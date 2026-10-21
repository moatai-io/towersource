import { describe, expect, it } from 'vitest';
import { isNoWorkTask } from './automation-outcome.js';
describe('explicit normal no-work result', () => {
  it('requires both successful Task completion and explicit marker', () => {
    expect(isNoWorkTask({ status: 'done', progressSummary: ['[TASK NONE]'] })).toBe(true);
    expect(isNoWorkTask({ status: 'failed', progressSummary: ['[TASK NONE]'] })).toBe(false);
    expect(isNoWorkTask({ status: 'done', progressSummary: ['nothing to do'] })).toBe(false);
    expect(isNoWorkTask(null)).toBe(false);
  });
});

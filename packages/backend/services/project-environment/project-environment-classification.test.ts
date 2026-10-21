import { describe, expect, it } from 'vitest';
import { classifyProjectEnvironment } from './project-execution-context.js';

describe('administration and execution share environment classification', () => {
  it.each([
    [undefined, false, 'canonical-project-workspace'],
    [undefined, true, 'legacy-worker-workspace'],
    ['host', true, 'canonical-project-workspace'],
    ['host', false, 'canonical-project-workspace'],
    ['worker', false, 'legacy-worker-workspace'],
    ['worker', true, 'legacy-worker-workspace'],
  ] as const)('classifies %s with legacy mode %s as %s', (storage, legacy, expected) => {
    expect(classifyProjectEnvironment(storage, legacy)).toBe(expected);
  });
});

import { describe, expect, it } from 'vitest';
import { getRunnerPolicy } from './runner-policy.js';

describe('getRunnerPolicy', () => {
  it('defaults to auto/fail/wake_if_stopped/default', () => {
    expect(getRunnerPolicy({})).toEqual({
      preference: 'auto',
      fallback: 'fail',
      wakePolicy: 'wake_if_stopped',
      boxSelector: 'default',
    });
  });

  it('accepts runtime_box runner policy', () => {
    expect(getRunnerPolicy({ runner: { preference: 'runtime_box', fallback: 'admin_host', wakePolicy: 'only_if_running', boxSelector: 'build' } })).toEqual({
      preference: 'runtime_box',
      fallback: 'admin_host',
      wakePolicy: 'only_if_running',
      boxSelector: 'build',
    });
  });

  it('normalizes unsafe values', () => {
    expect(getRunnerPolicy({ runner: { preference: 'weird', fallback: 'host', wakePolicy: 'always' } })).toEqual({
      preference: 'auto',
      fallback: 'fail',
      wakePolicy: 'wake_if_stopped',
      boxSelector: 'default',
    });
  });
});

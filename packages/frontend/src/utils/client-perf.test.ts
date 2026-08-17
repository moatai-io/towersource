// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { logClientPerf } from './client-perf';

describe('client-perf', () => {
  const originalInfo = console.info;

  beforeEach(() => {
    console.info = vi.fn();
    localStorage.clear();
  });

  afterEach(() => {
    console.info = originalInfo;
    localStorage.clear();
  });

  it('does not log below the threshold by default', () => {
    logClientPerf('fast-path', { elapsedMs: 10 }, { thresholdMs: 100 });
    expect(console.info).not.toHaveBeenCalled();
  });

  it('logs when explicitly enabled and redacts id-like fields', () => {
    localStorage.setItem('tower:perf:client', '1');
    logClientPerf('session-select', {
      sessionId: '12345678-aaaa-bbbb-cccc-123456789abc',
      messageCount: 5,
      elapsedMs: 10,
    }, { thresholdMs: 100 });

    expect(console.info).toHaveBeenCalledWith('[perf][session-select]', {
      sessionId: '12345678…',
      messageCount: 5,
      elapsedMs: 10,
    });
  });
});

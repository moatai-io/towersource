// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { finishClientPerfTrace, logClientPerf, markClientPerfTrace, startClientPerfTrace } from './client-perf';

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

  it('aggregates trace phases, emits a sanitized completion event, and only finishes once', () => {
    localStorage.setItem('tower:perf:client', '1');
    const completed = vi.fn();
    window.addEventListener('tower:client-perf', completed);
    const now = vi.spyOn(performance, 'now')
      .mockReturnValueOnce(100)
      .mockReturnValueOnce(125)
      .mockReturnValueOnce(180);

    startClientPerfTrace('session-select-to-paint', 'session-1', { sessionId: 'session-1', source: 'network' });
    markClientPerfTrace('session-select-to-paint', 'session-1', 'messagesNormalized', { messageCount: 500 });
    expect(finishClientPerfTrace('session-select-to-paint', 'session-1')).toBe(true);
    expect(finishClientPerfTrace('session-select-to-paint', 'session-1')).toBe(false);

    expect(console.info).toHaveBeenCalledWith('[perf][session-select-to-paint]', expect.objectContaining({
      sessionId: 'session-1',
      source: 'network',
      messageCount: 500,
      messagesNormalizedMs: 25,
      messagesNormalizedElapsedMs: 25,
      elapsedMs: 80,
    }));
    expect(completed).toHaveBeenCalledWith(expect.objectContaining({
      detail: expect.objectContaining({
        label: 'session-select-to-paint',
        fields: expect.objectContaining({ sessionId: 'session-1', elapsedMs: 80 }),
      }),
    }));
    window.removeEventListener('tower:client-perf', completed);
    now.mockRestore();
  });
});

import { afterEach, describe, expect, it, vi } from 'vitest';
import { createStreamWatchdog } from './pi-stream-watchdog.js';

// A finite 30-minute wait is tool execution, not a stalled model stream.
describe('sleep tool watchdog integration', () => {
  afterEach(() => { vi.useRealTimers(); });

  it('allows four 30-minute waits and resumes idle monitoring after each tool result', () => {
    vi.useFakeTimers();
    const onStuck = vi.fn();
    const watchdog = createStreamWatchdog({ streamIdleMs: 60_000, checkIntervalMs: 1_000, onStuck });
    for (let check = 0; check < 4; check += 1) {
      watchdog.observe({ type: 'tool_execution_start' });
      vi.advanceTimersByTime(30 * 60_000);
      expect(onStuck).not.toHaveBeenCalled();
      watchdog.observe({ type: 'tool_execution_end' });
      vi.advanceTimersByTime(30_000);
      expect(onStuck).not.toHaveBeenCalled();
    }
    vi.advanceTimersByTime(32_000);
    expect(onStuck).toHaveBeenCalledOnce();
    expect(onStuck.mock.calls[0][0]).toBe('idle');
    watchdog.stop();
  });
});

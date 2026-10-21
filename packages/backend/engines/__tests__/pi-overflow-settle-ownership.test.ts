import { describe, expect, it, vi } from 'vitest';
import { releasePiOverflowSettleAfterAssistant, resetPiOverflowSettleAfterCompaction } from '../pi/overflow-settle-ownership.js';

describe('Pi overflow settle ownership', () => {
  it('starts a fresh bounded wait after a long SDK compaction, then releases it on progress', () => {
    vi.useFakeTimers();
    try {
      const forced = vi.fn();
      const closingTimer = setTimeout(forced, 300_000);
      const agentEndTimer = setTimeout(forced, 300_000);
      vi.advanceTimersByTime(250_000);
      let postCompactTimer: ReturnType<typeof setTimeout> | undefined;
      expect(resetPiOverflowSettleAfterCompaction({
        pending: true, compactionSucceeded: true, terminalForced: false,
        clearClosingTimer: () => clearTimeout(closingTimer),
        clearAgentEndTimer: () => clearTimeout(agentEndTimer),
        armPostCompactTimer: () => { postCompactTimer = setTimeout(forced, 300_000); },
      })).toBe(true);
      vi.advanceTimersByTime(60_000); // past the original agent_end deadline
      expect(forced).not.toHaveBeenCalled();
      expect(releasePiOverflowSettleAfterAssistant({
        pending: true, compactionSucceeded: true, role: 'assistant', stopReason: 'toolUse',
        clearClosingTimer: () => clearTimeout(postCompactTimer),
        clearAgentEndTimer: () => {},
      })).toBe(true);
      vi.advanceTimersByTime(300_001);
      expect(forced).not.toHaveBeenCalled();
    } finally { vi.useRealTimers(); }
  });

  it('leaves both guards armed if compaction failed', () => {
    vi.useFakeTimers();
    try {
      const forced = vi.fn();
      const timer = setTimeout(forced, 300_000);
      const arm = vi.fn();
      expect(resetPiOverflowSettleAfterCompaction({
        pending: true, compactionSucceeded: false, terminalForced: false,
        clearClosingTimer: () => clearTimeout(timer),
        clearAgentEndTimer: () => clearTimeout(timer),
        armPostCompactTimer: arm,
      })).toBe(false);
      vi.advanceTimersByTime(300_001);
      expect(forced).toHaveBeenCalledOnce();
      expect(arm).not.toHaveBeenCalled();
    } finally { vi.useRealTimers(); }
  });

  it('cancels both 5-minute guards on fresh tool progress after overflow compaction', () => {
    vi.useFakeTimers();
    try {
      const forced = vi.fn();
      const closingTimer = setTimeout(forced, 300_000);
      const agentEndTimer = setTimeout(forced, 300_000);
      const released = releasePiOverflowSettleAfterAssistant({
        pending: true, compactionSucceeded: true, role: 'assistant', stopReason: 'toolUse',
        clearClosingTimer: () => clearTimeout(closingTimer),
        clearAgentEndTimer: () => clearTimeout(agentEndTimer),
      });
      expect(released).toBe(true);
      vi.advanceTimersByTime(300_001);
      expect(forced).not.toHaveBeenCalled();
    } finally { vi.useRealTimers(); }
  });

  it.each([
    { pending: false, compactionSucceeded: true, role: 'assistant', stopReason: 'toolUse' },
    { pending: true, compactionSucceeded: false, role: 'assistant', stopReason: 'toolUse' },
    { pending: true, compactionSucceeded: true, role: 'user', stopReason: 'stop' },
    { pending: true, compactionSucceeded: true, role: 'assistant', stopReason: 'error' },
    { pending: true, compactionSucceeded: true, role: 'assistant', stopReason: 'aborted' },
  ])('retains the error guard on non-recovery boundary %#', (boundary) => {
    vi.useFakeTimers();
    try {
      const forced = vi.fn();
      const timer = setTimeout(forced, 300_000);
      expect(releasePiOverflowSettleAfterAssistant({
        ...boundary,
        clearClosingTimer: () => clearTimeout(timer),
        clearAgentEndTimer: () => clearTimeout(timer),
      })).toBe(false);
      vi.advanceTimersByTime(300_001);
      expect(forced).toHaveBeenCalledOnce();
    } finally { vi.useRealTimers(); }
  });
});

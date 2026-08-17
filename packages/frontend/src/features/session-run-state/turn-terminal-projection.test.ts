import { describe, expect, it, vi } from 'vitest';
import { applyTurnTerminal } from './turn-terminal-projection';

describe('turn terminal projection', () => {
  it('projects an authoritative terminal event', () => {
    expect(applyTurnTerminal(undefined, {
      rootTurnId: 'r1', outcome: 'completed', terminalAt: '2026-08-02T00:00:00.000Z', assistantMessageId: 'a1', reason: 'durable_assistant',
    }, false)).toEqual({
      rootTurnId: 'r1', outcome: 'completed', terminalAt: Date.parse('2026-08-02T00:00:00.000Z'), assistantMessageId: 'a1', reason: 'durable_assistant', error: undefined, read: false,
    });
  });

  it('preserves the stopped reason for one chat-timeline status surface', () => {
    expect(applyTurnTerminal(undefined, {
      rootTurnId: 'r-stop', outcome: 'stopped', reason: 'forced_stop', terminalAt: 30,
    }, true)).toMatchObject({ outcome: 'stopped', reason: 'forced_stop', read: true });
  });

  it('ignores an older root turn arriving after a newer terminal', () => {
    const current = { rootTurnId: 'r2', outcome: 'completed' as const, terminalAt: 20, read: false };
    expect(applyTurnTerminal(current, { rootTurnId: 'r1', outcome: 'failed', terminalAt: 10 }, false)).toBe(current);
  });

  it('updates the same root turn only with an equal or newer terminal fact', () => {
    const current = { rootTurnId: 'r1', outcome: 'waiting_retry' as const, terminalAt: 10, read: false };
    expect(applyTurnTerminal(current, { rootTurnId: 'r1', outcome: 'completed', terminalAt: 20 }, true)).toMatchObject({ outcome: 'completed', terminalAt: 20, read: true });
    expect(applyTurnTerminal(current, { rootTurnId: 'r1', outcome: 'completed', terminalAt: 5 }, true)).toBe(current);
  });
});

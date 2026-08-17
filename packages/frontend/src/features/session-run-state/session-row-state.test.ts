import { describe, expect, it } from 'vitest';
import { deriveSessionRowActivity, deriveSessionRowState } from './session-row-state';

describe('session-row-state', () => {
  it('normalizes raw runtime signals into one activity value', () => {
    for (const phase of ['preparing', 'streaming', 'tool_running', 'stalled', 'closing', 'compacting'] as const) {
      expect(deriveSessionRowActivity({ isStreaming: false, phase, queueCount: 0 })).toEqual({ kind: 'running', summary: undefined });
    }
    expect(deriveSessionRowActivity({ isStreaming: true, phase: 'idle', queueCount: 0, summary: '문서 읽는 중' })).toEqual({ kind: 'running', summary: '문서 읽는 중' });
    expect(deriveSessionRowActivity({ isStreaming: false, phase: 'queued', queueCount: 2 })).toEqual({ kind: 'queued', count: 2 });
    expect(deriveSessionRowActivity({ isStreaming: false, phase: 'awaiting_user', queueCount: 0 })).toEqual({ kind: 'awaiting_user' });
    expect(deriveSessionRowActivity({ isStreaming: false, phase: 'error', queueCount: 0 })).toEqual({ kind: 'error' });
    expect(deriveSessionRowActivity({ isStreaming: false, phase: 'stopped', queueCount: 0 })).toEqual({ kind: 'stopped' });
    expect(deriveSessionRowActivity({ isStreaming: false, phase: 'idle', queueCount: 0 })).toEqual({ kind: 'idle' });
  });

  it('shows three dots and elapsed time while running', () => {
    expect(deriveSessionRowState({ kind: 'running', summary: '테스트 중' }, false)).toEqual({
      indicator: { kind: 'running', summary: '테스트 중' },
      bold: false,
      elapsed: 'running',
    });
  });

  it('preserves unread emphasis while activity owns the indicator', () => {
    expect(deriveSessionRowState({ kind: 'running' }, true)).toEqual({
      indicator: { kind: 'running' },
      bold: true,
      elapsed: 'running',
    });
  });

  it('shows bold plus completion check only for idle unread attention', () => {
    expect(deriveSessionRowState({ kind: 'idle' }, true)).toEqual({
      indicator: { kind: 'done' },
      bold: true,
      elapsed: 'none',
    });
    expect(deriveSessionRowState({ kind: 'idle' }, false)).toEqual({
      indicator: { kind: 'none' },
      bold: false,
      elapsed: 'none',
    });
  });

  it('shows waiting elapsed time without inventing completion attention', () => {
    expect(deriveSessionRowState({ kind: 'awaiting_user' }, false)).toEqual({
      indicator: { kind: 'awaiting_user' },
      bold: false,
      elapsed: 'waiting',
    });
  });
});

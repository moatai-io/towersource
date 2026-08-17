import { describe, expect, it, vi } from 'vitest';
import { handlePiCompactionEnd, handlePiCompactionStart } from '../pi/compaction-handler.js';

describe('Pi compaction event handlers', () => {
  it('maps compaction_start to boundary and compacting messages', () => {
    expect(handlePiCompactionStart({ event: { reason: 'auto' }, sessionId: 'session-12345678' })).toEqual([
      { type: 'compact', sessionId: 'session-12345678', phase: 'boundary' },
      { type: 'compact', sessionId: 'session-12345678', phase: 'compacting' },
    ]);
  });

  it('maps successful compaction_end to done and forgets context hints', () => {
    const forgetContextHint = vi.fn();

    const result = handlePiCompactionEnd({
      event: { aborted: false, reason: 'auto', result: { summary: 'short summary', firstKeptEntryId: 'entry-1', tokensBefore: 123 } },
      sessionId: 'session-12345678',
      forgetContextHint,
      getSdkSessionId: () => 'sdk-session-id',
    });

    expect(result).toEqual({
      outcome: 'compacted',
      succeeded: true,
      messages: [{ type: 'compact', sessionId: 'session-12345678', phase: 'done' }],
    });
    expect(forgetContextHint).toHaveBeenCalledWith('session-12345678');
    expect(forgetContextHint).toHaveBeenCalledWith('sdk-session-id');
  });

  it('does not mark compaction_end without a real result as success', () => {
    const forgetContextHint = vi.fn();

    const result = handlePiCompactionEnd({
      event: { aborted: false, reason: 'threshold', result: undefined },
      sessionId: 'session-12345678',
      forgetContextHint,
    });

    expect(result.outcome).toBe('failed');
    expect(result.succeeded).toBe(false);
    expect(result.messages).toEqual([
      { type: 'compact', sessionId: 'session-12345678', phase: 'failed' },
      {
        type: 'engine_error',
        sessionId: 'session-12345678',
        message: 'Pi context compaction did not complete: no compaction result was produced',
        recoverable: true,
      },
    ]);
    expect(forgetContextHint).not.toHaveBeenCalled();
  });

  it('maps Nothing to compact to a non-fatal skipped outcome', () => {
    const forgetContextHint = vi.fn();

    const result = handlePiCompactionEnd({
      event: { aborted: false, reason: 'manual', result: undefined, errorMessage: 'Nothing to compact (session too small)' },
      sessionId: 'session-12345678',
      forgetContextHint,
    });

    expect(result).toEqual({
      outcome: 'skipped',
      succeeded: false,
      messages: [{ type: 'compact', sessionId: 'session-12345678', phase: 'skipped' }],
    });
    expect(forgetContextHint).not.toHaveBeenCalled();
  });

  it('maps aborted compaction_end to recoverable engine_error', () => {
    const forgetContextHint = vi.fn();

    const result = handlePiCompactionEnd({
      event: { aborted: true, reason: 'overflow', willRetry: false, errorMessage: 'too large' },
      sessionId: 'session-12345678',
      forgetContextHint,
    });

    expect(result.outcome).toBe('failed');
    expect(result.succeeded).toBe(false);
    expect(result.messages).toEqual([
      { type: 'compact', sessionId: 'session-12345678', phase: 'failed' },
      {
        type: 'engine_error',
        sessionId: 'session-12345678',
        message: 'Pi context compaction did not complete: too large',
        recoverable: true,
      },
    ]);
    expect(forgetContextHint).not.toHaveBeenCalled();
  });
});

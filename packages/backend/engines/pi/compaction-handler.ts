// Owns Pi compaction_start/compaction_end event adaptation to Tower messages.
// Public API: handlePiCompactionStart, handlePiCompactionEnd.

import type { TowerMessage } from '../types.js';
import { isPiCompactionNoOpMessage } from './compaction-outcome.js';

export function handlePiCompactionStart(params: {
  event: any;
  sessionId: string;
}): TowerMessage[] {
  const { event, sessionId } = params;
  console.log(`[Pi] compaction_start: session=${sessionId.slice(0, 8)} reason=${event.reason}`);
  return [
    { type: 'compact', sessionId, phase: 'boundary' },
    { type: 'compact', sessionId, phase: 'compacting' },
  ];
}

export function handlePiCompactionEnd(params: {
  event: any;
  sessionId: string;
  forgetContextHint: (id: string | undefined) => void;
  getSdkSessionId?: () => string | undefined;
}): { messages: TowerMessage[]; outcome: 'compacted' | 'skipped' | 'failed'; succeeded: boolean } {
  const { event, sessionId, forgetContextHint, getSdkSessionId } = params;
  const hasUsableResult = !event.aborted
    && event.result
    && typeof event.result.summary === 'string'
    && event.result.summary.trim().length > 0
    && typeof event.result.firstKeptEntryId === 'string'
    && event.result.firstKeptEntryId.trim().length > 0;
  const detail = event.aborted
    ? `aborted=true willRetry=${event.willRetry}${event.errorMessage ? ' err=' + event.errorMessage.slice(0, 120) : ''}`
    : `tokens_before=${event.result?.tokensBefore ?? 'n/a'} result=${hasUsableResult ? 'ok' : 'missing'}${event.errorMessage ? ' err=' + String(event.errorMessage).slice(0, 120) : ''}`;
  console.log(`[Pi] compaction_end: session=${sessionId.slice(0, 8)} reason=${event.reason} ${detail}`);

  // Pi SDK emits compaction_end(aborted=false, result=undefined) for several
  // no-op/failure paths (missing auth, prepareCompaction() returned undefined,
  // summarizer error caught by SDK). Treating that as success creates the exact
  // bad loop users see: Tower shows “compacted”, clears context hints, but the
  // Pi session file has no `type:"compaction"` entry and the next turn compacts
  // again. Success requires a real compaction result.
  if (hasUsableResult) {
    forgetContextHint(sessionId);
    try {
      forgetContextHint(getSdkSessionId?.());
    } catch { /* best-effort */ }
    return {
      outcome: 'compacted',
      succeeded: true,
      messages: [{ type: 'compact', sessionId, phase: 'done' }],
    };
  }

  const reason = event.errorMessage
    ? String(event.errorMessage).slice(0, 240)
    : 'no compaction result was produced';
  if (isPiCompactionNoOpMessage(reason)) {
    console.log(`[Pi] compaction_noop: session=${sessionId.slice(0, 8)} reason=${reason}`);
    return {
      outcome: 'skipped',
      succeeded: false,
      messages: [{ type: 'compact', sessionId, phase: 'skipped' }],
    };
  }

  return {
    outcome: 'failed',
    succeeded: false,
    messages: [
      { type: 'compact', sessionId, phase: 'failed' },
      {
        type: 'engine_error',
        sessionId,
        message: `Pi context compaction did not complete: ${reason}`,
        recoverable: true,
      },
    ],
  };
}

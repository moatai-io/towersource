// Owns: the small display model shared by session rows and chat tabs.
// Public API: deriveSessionRowState. See README.md.

import type { TurnPhase } from '../../stores/chat-store';

export type SessionRowActivity =
  | { kind: 'running'; summary?: string }
  | { kind: 'queued'; count: number }
  | { kind: 'awaiting_user' }
  | { kind: 'error' }
  | { kind: 'stopped' }
  | { kind: 'idle' };

export type SessionRowIndicator =
  | { kind: 'running'; summary?: string }
  | { kind: 'queued'; count: number }
  | { kind: 'awaiting_user' }
  | { kind: 'done' }
  | { kind: 'error' }
  | { kind: 'stopped' }
  | { kind: 'none' };

export interface SessionRowState {
  indicator: SessionRowIndicator;
  bold: boolean;
  elapsed: 'running' | 'waiting' | 'none';
}

const RUNNING_PHASES = new Set<TurnPhase>([
  'preparing',
  'streaming',
  'tool_running',
  'stalled',
  'closing',
  'compacting',
]);

/** Convert raw runtime signals into the one activity value consumed by row UI. */
export function deriveSessionRowActivity(input: {
  isStreaming: boolean;
  phase: TurnPhase | undefined;
  queueCount: number;
  summary?: string;
}): SessionRowActivity {
  const phase = input.phase || 'idle';
  if (phase === 'awaiting_user') return { kind: 'awaiting_user' };
  if (input.isStreaming || RUNNING_PHASES.has(phase)) return { kind: 'running', summary: input.summary };
  if (input.queueCount > 0 || phase === 'queued') return { kind: 'queued', count: Math.max(1, input.queueCount) };
  if (phase === 'error') return { kind: 'error' };
  if (phase === 'stopped') return { kind: 'stopped' };
  return { kind: 'idle' };
}

/**
 * Decide the complete row presentation from two independent facts:
 * current activity and whether this user has unread attention.
 */
export function deriveSessionRowState(activity: SessionRowActivity, unread: boolean): SessionRowState {
  if (activity.kind === 'running') {
    return { indicator: activity, bold: unread, elapsed: 'running' };
  }
  if (activity.kind === 'awaiting_user') {
    return { indicator: activity, bold: unread, elapsed: 'waiting' };
  }
  if (activity.kind !== 'idle') {
    return { indicator: activity, bold: unread, elapsed: 'none' };
  }
  return {
    indicator: unread ? { kind: 'done' } : { kind: 'none' },
    bold: unread,
    elapsed: 'none',
  };
}

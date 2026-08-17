import { describe, expect, it } from 'vitest';
import {
  canAcceptSteer,
  classifyPiSteer,
  isTerminalRunState,
  markPiRunClosing,
  shouldBufferInput,
} from './pi-run-lifecycle.js';

describe('Pi run lifecycle', () => {
  it('keeps terminal runs terminal when asked to close again', () => {
    expect(markPiRunClosing('closed')).toBe('closed');
    expect(markPiRunClosing('error')).toBe('error');
  });

  it('moves non-terminal states into closing', () => {
    expect(markPiRunClosing('starting')).toBe('closing');
    expect(markPiRunClosing('running')).toBe('closing');
    expect(markPiRunClosing('tool_running')).toBe('closing');
    expect(markPiRunClosing('stalled')).toBe('closing');
    expect(markPiRunClosing(undefined)).toBe('closing');
  });

  it('classifies terminal states explicitly', () => {
    expect(isTerminalRunState('closed')).toBe(true);
    expect(isTerminalRunState('error')).toBe(true);
    expect(isTerminalRunState('closing')).toBe(false);
    expect(isTerminalRunState('running')).toBe(false);
    expect(isTerminalRunState(undefined)).toBe(false);
  });

  it('accepts steers only while prompt is active in running/tool_running states', () => {
    expect(canAcceptSteer({ state: 'running', promptActive: true })).toBe(true);
    expect(canAcceptSteer({ state: 'tool_running', promptActive: true })).toBe(true);
    expect(canAcceptSteer({ state: 'starting', promptActive: true })).toBe(false);
    expect(canAcceptSteer({ state: 'running', promptActive: false })).toBe(false);
  });

  it('delivers steers only when prompt is active and run state can accept steers', () => {
    expect(classifyPiSteer({ phase: 'running', promptActive: true, isRunning: true })).toEqual({ kind: 'deliver' });
    expect(classifyPiSteer({ phase: 'tool_running', promptActive: true, isRunning: true })).toEqual({ kind: 'deliver' });
  });

  it('buffers steers during claimed startup before prompt accepts steering', () => {
    expect(shouldBufferInput({ isStarting: true, promptActive: false })).toBe(true);
    expect(shouldBufferInput({ state: 'starting', isRunning: true, promptActive: false })).toBe(true);
    expect(classifyPiSteer({ isStarting: true, promptActive: false })).toEqual({ kind: 'buffer' });
    expect(classifyPiSteer({ phase: 'starting', isRunning: true, promptActive: false })).toEqual({ kind: 'buffer' });
  });

  it('rejects closing/zombie runs so callers can queue instead of orphaning pending chips', () => {
    const result = classifyPiSteer({ phase: 'closing', promptActive: false, isRunning: true });
    expect(result.kind).toBe('reject');
    if (result.kind === 'reject') {
      expect(result.reason).toBe('closing');
      expect(result.message).toMatch(/Queue this message for the next turn/);
    }
  });

  it('rejects promptActive states that cannot accept steers as an invariant violation', () => {
    const result = classifyPiSteer({ phase: 'starting', promptActive: true, isRunning: true });
    expect(result.kind).toBe('reject');
    if (result.kind === 'reject') {
      expect(result.reason).toBe('inactive');
      expect(result.message).toContain('state=starting');
    }
  });

  it('rejects idle sessions', () => {
    const result = classifyPiSteer({ phase: 'closed', promptActive: false, isRunning: false });
    expect(result.kind).toBe('reject');
    if (result.kind === 'reject') expect(result.reason).toBe('idle');
  });
});

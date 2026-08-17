import { describe, expect, it } from 'vitest';
import { classifyPiSafeStopRequest, shouldStopPiAtToolBoundary } from './safe-stop.js';

describe('Pi safe-stop boundary', () => {
  it('rejects a request when no Pi prompt is actively running', () => {
    expect(classifyPiSafeStopRequest({ isRunning: false, promptActive: false, runPhase: 'closed', alreadyRequested: false }))
      .toEqual({ accepted: false, reason: 'not_running' });
    expect(classifyPiSafeStopRequest({ isRunning: true, promptActive: false, runPhase: 'closing', alreadyRequested: false }))
      .toEqual({ accepted: false, reason: 'not_running' });
  });

  it('waits for the active foreground tool but not for a later inference batch', () => {
    expect(classifyPiSafeStopRequest({ isRunning: true, promptActive: true, runPhase: 'tool_running', alreadyRequested: false }))
      .toEqual({ accepted: true, waitingFor: 'active_tool', duplicate: false });
    expect(classifyPiSafeStopRequest({ isRunning: true, promptActive: true, runPhase: 'running', alreadyRequested: false }))
      .toEqual({ accepted: true, waitingFor: 'engine_boundary', duplicate: false });
  });

  it('is idempotent for duplicate requests', () => {
    expect(classifyPiSafeStopRequest({ isRunning: true, promptActive: true, runPhase: 'tool_running', alreadyRequested: true }))
      .toEqual({ accepted: true, waitingFor: 'active_tool', duplicate: true });
  });

  it('stops exactly when nested foreground tool depth returns to zero', () => {
    expect(shouldStopPiAtToolBoundary({ toolRunDepth: 2, safeStopRequested: true, abortRequested: false })).toBe(false);
    expect(shouldStopPiAtToolBoundary({ toolRunDepth: 1, safeStopRequested: true, abortRequested: false })).toBe(false);
    expect(shouldStopPiAtToolBoundary({ toolRunDepth: 0, safeStopRequested: true, abortRequested: false })).toBe(true);
    expect(shouldStopPiAtToolBoundary({ toolRunDepth: 0, safeStopRequested: false, abortRequested: false })).toBe(false);
    expect(shouldStopPiAtToolBoundary({ toolRunDepth: 0, safeStopRequested: true, abortRequested: true })).toBe(false);
  });
});

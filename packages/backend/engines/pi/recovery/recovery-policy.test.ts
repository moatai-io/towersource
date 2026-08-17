import { describe, expect, it } from 'vitest';
import { decidePiContinuationRecovery, decidePiRestartRecovery, decidePiRetryOwnership, inspectPiRecoveryState, isIncompleteToolBoundaryContinuationEnabled } from './recovery-policy.js';

describe('Pi recovery policy', () => {
  it('uses the same primitive policy for restart and in-run continuation', () => {
    const assistantState = { leafRole: 'assistant' as const, idle: true, queuedMessages: false };
    expect(decidePiContinuationRecovery(assistantState))
      .toEqual({ action: 'recovery_prompt', reason: 'assistant_leaf' });
    expect(decidePiRestartRecovery(assistantState))
      .toEqual(decidePiContinuationRecovery(assistantState));
    expect(decidePiContinuationRecovery({ leafRole: 'toolResult', idle: true, queuedMessages: false }))
      .toEqual({ action: 'native_continue', reason: 'continuable_leaf' });
  });

  it('fails all continuation triggers closed for queued or unknown transcript state', () => {
    expect(decidePiContinuationRecovery({ leafRole: 'assistant', idle: false, queuedMessages: true }))
      .toEqual({ action: 'needs_attention', reason: 'queued_messages' });
    expect(decidePiContinuationRecovery({ leafRole: 'unknown', idle: true, queuedMessages: false }))
      .toEqual({ action: 'needs_attention', reason: 'unknown_leaf' });
  });

  it('keeps incomplete tool-boundary continuation opt-in', () => {
    expect(isIncompleteToolBoundaryContinuationEnabled({} as NodeJS.ProcessEnv)).toBe(false);
    expect(isIncompleteToolBoundaryContinuationEnabled({ PI_AUTO_CONTINUE_INCOMPLETE_TOOL_BOUNDARY: '0' } as NodeJS.ProcessEnv)).toBe(false);
    expect(isIncompleteToolBoundaryContinuationEnabled({ PI_AUTO_CONTINUE_INCOMPLETE_TOOL_BOUNDARY: '1' } as NodeJS.ProcessEnv)).toBe(true);
  });

  it('gives Pi SDK exclusive retry ownership once its lifecycle retry is observed', () => {
    expect(decidePiRetryOwnership(false)).toEqual({
      owner: 'tower',
      towerRetryAllowed: true,
      reason: 'tower_fallback',
    });
    expect(decidePiRetryOwnership(true)).toEqual({
      owner: 'pi_sdk',
      towerRetryAllowed: false,
      reason: 'sdk_retry_observed',
    });
  });

  it('summarizes SDK recovery evidence without transcript content', () => {
    const state = inspectPiRecoveryState({
      isIdle: true,
      agent: {
        state: {
          messages: [
            { role: 'user', content: 'secret user text' },
            { role: 'toolResult', content: [{ type: 'text', text: 'secret tool result' }] },
          ],
        },
        hasQueuedMessages: () => true,
      },
    });

    expect(state).toEqual({ leafRole: 'toolResult', idle: true, queuedMessages: true });
    expect(JSON.stringify(state)).not.toContain('secret');
  });

  it('fails closed when private SDK state is unavailable', () => {
    expect(inspectPiRecoveryState(null)).toEqual({
      leafRole: 'empty',
      idle: false,
      queuedMessages: false,
    });
  });
});

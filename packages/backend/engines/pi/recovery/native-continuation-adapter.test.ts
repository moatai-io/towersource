import { describe, expect, it, vi } from 'vitest';
import { continuePiNativeLifecycle, isPiNativeContinuationUnavailable } from './native-continuation-adapter.js';

describe('Pi native continuation adapter', () => {
  it('runs Pi post-agent lifecycle until no continuation remains', async () => {
    const agentContinue = vi.fn().mockResolvedValue(undefined);
    const handlePostAgentRun = vi.fn()
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false);
    const emitAgentSettled = vi.fn().mockResolvedValue(undefined);
    const flushPendingBashMessages = vi.fn();
    const session: any = {
      agent: { continue: agentContinue },
      _handlePostAgentRun: handlePostAgentRun,
      _emitAgentSettled: emitAgentSettled,
      _flushPendingBashMessages: flushPendingBashMessages,
      _systemPromptOverride: 'temporary',
      _agentRunAbortRequested: true,
    };

    await continuePiNativeLifecycle(session, 'test');

    expect(agentContinue).toHaveBeenCalledTimes(2);
    expect(session._agentRunAbortRequested).toBe(false);
    expect(handlePostAgentRun).toHaveBeenCalledTimes(2);
    expect(session._isAgentRunActive).toBe(true);
    expect(session._systemPromptOverride).toBeUndefined();
    expect(flushPendingBashMessages).toHaveBeenCalledOnce();
    expect(emitAgentSettled).toHaveBeenCalledOnce();
  });

  it('maps assistant-leaf rejection to stable unavailable error and still settles', async () => {
    const emitAgentSettled = vi.fn().mockResolvedValue(undefined);
    const session = {
      agent: { continue: vi.fn().mockRejectedValue(new Error('Cannot continue from message role: assistant')) },
      _handlePostAgentRun: vi.fn(),
      _emitAgentSettled: emitAgentSettled,
    };

    await expect(continuePiNativeLifecycle(session, 'restart')).rejects.toSatisfy((error: Error) => {
      expect(isPiNativeContinuationUnavailable(error.message)).toBe(true);
      expect(error.message).toContain('transcript ends with assistant');
      return true;
    });
    expect(emitAgentSettled).toHaveBeenCalledOnce();
  });

  it('fails closed when required Pi private lifecycle methods are unavailable', async () => {
    await expect(continuePiNativeLifecycle({ agent: { continue: vi.fn() } }, 'missing-methods'))
      .rejects.toSatisfy((error: Error) => isPiNativeContinuationUnavailable(error.message));
  });
});

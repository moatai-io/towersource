// Owns: the only Tower access to Pi SDK private native-continuation lifecycle fields.
// Public API: continuePiNativeLifecycle, isPiNativeContinuationUnavailable. See README.md.

const UNAVAILABLE_PREFIX = 'Pi native continuation could not resume the current transcript';

function unavailable(reason: string): Error {
  return new Error(`${UNAVAILABLE_PREFIX} (${reason}). Manual retry may be needed.`);
}

/** Returns true for the adapter's stable typed-by-message boundary error. */
export function isPiNativeContinuationUnavailable(message: unknown): boolean {
  return String(message || '').includes(UNAVAILABLE_PREFIX);
}

/**
 * Continues an interrupted Pi Session through the same internal post-run loop
 * used by Pi 0.82.1. Keep all private SDK access in this adapter.
 */
export async function continuePiNativeLifecycle(session: unknown, reason: string): Promise<void> {
  const sdkSession = session as any;
  const agent = sdkSession?.agent;
  if (!agent || typeof agent.continue !== 'function') {
    throw unavailable(reason);
  }
  if (typeof sdkSession._handlePostAgentRun !== 'function' || typeof sdkSession._emitAgentSettled !== 'function') {
    throw unavailable(reason);
  }

  // SDK abort() leaves this latch set. A deliberate continuation owns a new run.
  sdkSession._agentRunAbortRequested = false;
  sdkSession._isAgentRunActive = true;
  try {
    await agent.continue();
    while (await sdkSession._handlePostAgentRun()) {
      await agent.continue();
    }
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    if (/Cannot continue from message role:\s*assistant/i.test(message)) {
      throw unavailable(`${reason}; transcript ends with assistant`);
    }
    throw error;
  } finally {
    sdkSession._systemPromptOverride = undefined;
    try {
      sdkSession._flushPendingBashMessages?.();
    } catch {
      // Best-effort cleanup mirrors Pi 0.82.1 _runAgentPrompt().
    }
    await sdkSession._emitAgentSettled();
  }
}

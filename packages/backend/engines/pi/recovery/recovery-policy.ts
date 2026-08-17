// Owns: read-only Pi SDK recovery evidence and conservative continuation policy.
// Public API: inspectPiRecoveryState, decidePiContinuationRecovery, decidePiRetryOwnership. See README.md.

export type PiRecoveryLeafRole = 'user' | 'assistant' | 'toolResult' | 'system' | 'other' | 'empty' | 'unknown';

export interface PiRecoveryState {
  leafRole: PiRecoveryLeafRole;
  idle: boolean;
  queuedMessages: boolean;
}

export interface PiRetryOwnershipDecision {
  owner: 'pi_sdk' | 'tower';
  towerRetryAllowed: boolean;
  reason: 'sdk_retry_observed' | 'tower_fallback';
}

export type PiContinuationRecoveryDecision =
  | { action: 'native_continue'; reason: 'continuable_leaf' }
  | { action: 'recovery_prompt'; reason: 'assistant_leaf' }
  | { action: 'needs_attention'; reason: 'queued_messages' | 'unknown_leaf' | 'empty_leaf' };

export type PiRestartRecoveryDecision = PiContinuationRecoveryDecision;

function normalizeLeafRole(role: unknown): PiRecoveryLeafRole {
  if (role === undefined || role === null) return 'empty';
  if (role === 'user' || role === 'assistant' || role === 'toolResult' || role === 'system') return role;
  if (typeof role === 'string') return 'other';
  return 'unknown';
}

/**
 * Summarizes only low-cardinality recovery evidence from a Pi SDK Session.
 * Transcript text and tool arguments never leave this boundary.
 */
export function inspectPiRecoveryState(session: unknown): PiRecoveryState {
  const sdkSession = session as any;
  let leafRole: PiRecoveryLeafRole = 'unknown';
  try {
    const messages = sdkSession?.agent?.state?.messages;
    leafRole = Array.isArray(messages) && messages.length > 0
      ? normalizeLeafRole(messages[messages.length - 1]?.role)
      : 'empty';
  } catch {
    leafRole = 'unknown';
  }

  let queuedMessages = false;
  try {
    queuedMessages = Boolean(sdkSession?.agent?.hasQueuedMessages?.());
  } catch {
    queuedMessages = false;
  }

  return {
    leafRole,
    idle: Boolean(sdkSession?.isIdle),
    queuedMessages,
  };
}

/**
 * Chooses the safe execution primitive before touching Pi's native continuation API.
 * An assistant leaf is structurally not continuable in Pi, so eligible triggers
 * may resume it with one recovery prompt under the same root-turn/side-effect fence.
 */
export function decidePiContinuationRecovery(state: PiRecoveryState): PiContinuationRecoveryDecision {
  if (state.queuedMessages) return { action: 'needs_attention', reason: 'queued_messages' };
  if (state.leafRole === 'assistant') return { action: 'recovery_prompt', reason: 'assistant_leaf' };
  if (state.leafRole === 'user' || state.leafRole === 'toolResult' || state.leafRole === 'system') {
    return { action: 'native_continue', reason: 'continuable_leaf' };
  }
  if (state.leafRole === 'empty') return { action: 'needs_attention', reason: 'empty_leaf' };
  return { action: 'needs_attention', reason: 'unknown_leaf' };
}

/** Backward-compatible name for the server-restart entry point. */
export function decidePiRestartRecovery(state: PiRecoveryState): PiRestartRecoveryDecision {
  return decidePiContinuationRecovery(state);
}

/**
 * Legacy escape hatch for controlled diagnosis. Defaults off because a normal
 * prompt resolve must not be reinterpreted from Tower's DB projection alone.
 */
export function isIncompleteToolBoundaryContinuationEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.PI_AUTO_CONTINUE_INCOMPLETE_TOOL_BOUNDARY === '1';
}

/** Pi SDK retry wins whenever its lifecycle reports ownership of the run. */
export function decidePiRetryOwnership(sdkRetryObserved: boolean): PiRetryOwnershipDecision {
  return sdkRetryObserved
    ? { owner: 'pi_sdk', towerRetryAllowed: false, reason: 'sdk_retry_observed' }
    : { owner: 'tower', towerRetryAllowed: true, reason: 'tower_fallback' };
}

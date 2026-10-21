/** Value-free voice latency milestones. No input text, raw events, errors, paths or credentials. */
export const VOICE_TIMING_STAGES = [
  'admission_live_busy', 'admission_recovery_required', 'gateway_received', 'gateway_authority_ready', 'chat_dispatch', 'chat_lock_wait', 'chat_lock_acquired',
  'chat_admitted', 'chat_prepared', 'engine_enter', 'engine_claimed', 'engine_session_ready',
  'engine_model_ready', 'sdk_prompt_start', 'sdk_first_event', 'sdk_first_text',
  'sdk_first_unknown_text', 'sdk_first_commentary', 'sdk_first_final_phase', 'sdk_first_eligible_text',
  'sdk_first_tool', 'sdk_first_usage', 'gateway_first_text', 'chat_complete', 'gateway_terminal', 'gateway_failed',
] as const;
export type VoiceTimingStage = typeof VOICE_TIMING_STAGES[number];
export interface VoiceTimingSignal {
  stage: VoiceTimingStage;
  model?: string;
  effort?: string;
  contextWindow?: number;
  contextInputTokens?: number;
  messageCount?: number;
  cacheHit?: boolean;
  source?: 'text_delta' | 'text_end' | 'message_end';
}
export interface VoiceEngineTimingSignal extends VoiceTimingSignal { rootTurnId: string; sessionId: string }

export function createVoiceTurnTelemetry(identity: { turnId: string; revision: number }, options: {
  now?: () => number; write?: (line: string) => void;
} = {}) {
  const now = options.now ?? Date.now;
  const startedAt = now();
  const seen = new Set<string>();
  const write = options.write ?? ((line) => console.info(line));
  return (signal: VoiceTimingSignal) => {
    if (!VOICE_TIMING_STAGES.includes(signal.stage) || seen.has(signal.stage)) return;
    seen.add(signal.stage);
    const row: Record<string, unknown> = { turnId: identity.turnId, revision: identity.revision, stage: signal.stage, elapsedMs: Math.max(0, now() - startedAt) };
    // Allowlist and constrain every field even when callers pass unexpected object properties.
    // Model is an operator model identifier, never URL/user input or full provider config.
    if (typeof signal.model === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,159}$/.test(signal.model)
      && !signal.model.includes('://')) row.model = signal.model;
    if (['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'off'].includes(signal.effort || '')) row.effort = signal.effort;
    for (const field of ['contextWindow', 'contextInputTokens', 'messageCount'] as const) {
      const value = signal[field];
      if (typeof value === 'number' && Number.isFinite(value) && value >= 0) row[field] = Math.floor(value);
    }
    if (typeof signal.cacheHit === 'boolean') row.cacheHit = signal.cacheHit;
    if (['text_delta', 'text_end', 'message_end'].includes(signal.source || '')) row.source = signal.source;
    try { write(`[voice-latency] ${JSON.stringify(row)}`); } catch { /* metrics must not break a turn */ }
  };
}

/** Observe SDK event timing without exposing any SDK event contents. */
import { parseTextSignaturePhase } from './message-adapter.js';
import { confirmedVoiceAnswerSnapshot } from './voice-answer-stream.js';
import type { VoiceTimingSignal } from '../../services/voice-runtime/voice-turn-telemetry.js';

export function createVoiceSdkTimingObserver(emit: (signal: VoiceTimingSignal) => void) {
  const seen = new Set<string>();
  const once = (signal: VoiceTimingSignal) => {
    if (seen.has(signal.stage)) return;
    seen.add(signal.stage);
    emit(signal);
  };
  return (event: any) => {
    // First SDK event is not a network first-byte measurement (agent_start may be local).
    once({ stage: 'sdk_first_event' });
    const update = event?.assistantMessageEvent;
    const source = event?.type === 'message_update' && ['text_delta', 'text_end'].includes(update?.type) ? update.type
      : event?.type === 'message_end' && event.message?.role === 'assistant' ? 'message_end' : undefined;
    const message = source === 'message_end' ? event.message : source ? update.partial : undefined;
    if (source && Array.isArray(message?.content)) {
      const blocks = source === 'text_delta' ? [message.content[update.contentIndex]] : message.content;
      for (const block of blocks) {
        if (block?.type !== 'text' || (!block.text && !update?.delta)) continue;
        once({ stage: 'sdk_first_text', source });
        const phase = parseTextSignaturePhase(block);
        if (phase === 'final_answer') once({ stage: 'sdk_first_final_phase', source });
        else if (phase === 'commentary') once({ stage: 'sdk_first_commentary', source });
        else if (!phase) once({ stage: 'sdk_first_unknown_text', source });
      }
      if (confirmedVoiceAnswerSnapshot(event)) once({ stage: 'sdk_first_eligible_text', source });
    }
    if (event?.type === 'tool_execution_start') once({ stage: 'sdk_first_tool' });
    const usage = event?.type === 'message_end' && event.message?.role === 'assistant' ? event.message.usage : undefined;
    if (usage && typeof usage.input === 'number') {
      const cacheRead = typeof usage.cacheRead === 'number' ? usage.cacheRead : 0;
      const cacheWrite = typeof usage.cacheWrite === 'number' ? usage.cacheWrite : 0;
      once({ stage: 'sdk_first_usage', contextInputTokens: usage.input + cacheRead + cacheWrite });
    }
  };
}

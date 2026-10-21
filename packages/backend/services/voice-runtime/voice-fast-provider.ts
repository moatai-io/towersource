/** Backend adapter: existing server AI Router connection, no Session tools or credentials passed to the model. */
import { boundedVoiceFastReply } from '../../engines/pi/voice-fast-reply.js';
import type { FastVoiceProvider } from './voice-fast-router.js';
export const voiceFastProvider: FastVoiceProvider = {
  decide: (request) => boundedVoiceFastReply({ model: request.model, systemPrompt: request.instructions,
    intent: request.intent, signal: request.signal, maxOutputTokens: request.maxOutputTokens }),
};

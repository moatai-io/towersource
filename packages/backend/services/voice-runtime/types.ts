/**
 * Owns: Provider-neutral contracts for Tower voice sessions.
 * Public API: VoiceRuntimeConfig, VoiceSessionDescriptor, StreamingTtsProvider. See README.md.
 */

/** External provider selection for one voice session. */
export interface VoiceRuntimeConfig {
  sttProvider: 'clova';
  ttsProvider: 'typecast' | 'elevenlabs';
  language: 'ko-KR';
  maxSpokenSeconds: number;
}

/** Short-lived voice connection linked to one durable Tower Session. */
export interface VoiceSessionDescriptor {
  id: string;
  towerSessionId: string;
  userId: number;
  status: 'connecting' | 'listening' | 'thinking' | 'speaking' | 'stopped';
  createdAt: string;
  expiresAt: string;
  config: VoiceRuntimeConfig;
}

/** One chunk from a streaming TTS provider. */
export interface TtsAudioChunk {
  audio: Uint8Array;
  contentType: string;
}

/** Minimal provider contract so Korean TTS can be changed without changing orchestration. */
export interface StreamingTtsProvider {
  readonly name: VoiceRuntimeConfig['ttsProvider'];
  synthesize(text: string, signal?: AbortSignal): AsyncIterable<TtsAudioChunk>;
}

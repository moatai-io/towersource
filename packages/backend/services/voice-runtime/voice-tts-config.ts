/** Owns: safe selection of the LiveKit Inference TTS model and voice. */

export const DEFAULT_CARTESIA_KOREAN_VOICE = '9626c31c-bec5-4cca-baa8-f8ba9e84c8bc';

export interface VoiceTtsConfig {
  provider: 'cartesia' | 'inworld';
  model: string;
  voice: string;
  language: string;
  modelOptions?: Record<string, unknown>;
}

/** Resolve an opt-in TTS provider; unknown values safely retain the proven Cartesia path. */
export function resolveVoiceTtsConfig(env: NodeJS.ProcessEnv = process.env, requestedProvider?: string): VoiceTtsConfig {
  const provider = requestedProvider?.trim().toLowerCase() || env.TOWER_VOICE_TTS_PROVIDER?.trim().toLowerCase();
  if (provider === 'inworld') {
    return {
      provider: 'inworld',
      model: 'inworld/inworld-tts-2',
      voice: env.TOWER_VOICE_INWORLD_VOICE?.trim() || 'Seojun',
      language: 'ko-KR',
    };
  }
  return {
    provider: 'cartesia',
    model: 'cartesia/sonic-3',
    voice: env.TOWER_VOICE_CARTESIA_ID?.trim() || DEFAULT_CARTESIA_KOREAN_VOICE,
    language: 'ko',
    modelOptions: { speed: 0.9 },
  };
}

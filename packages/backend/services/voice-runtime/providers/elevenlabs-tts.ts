/**
 * Owns: ElevenLabs streaming TTS fallback adapter.
 * Public API: ElevenLabsTtsProvider. See ../README.md.
 */

import type { StreamingTtsProvider, TtsAudioChunk } from '../types.js';

export interface ElevenLabsTtsOptions {
  apiKey: string;
  voiceId: string;
  modelId?: string;
  endpointBase?: string;
}

/** Provides a provider-compatible fallback and blind-comparison path for Korean TTS. */
export class ElevenLabsTtsProvider implements StreamingTtsProvider {
  readonly name = 'elevenlabs' as const;

  constructor(private readonly options: ElevenLabsTtsOptions) {}

  async *synthesize(text: string, signal?: AbortSignal): AsyncIterable<TtsAudioChunk> {
    const base = this.options.endpointBase ?? 'https://api.elevenlabs.io/v1';
    const response = await fetch(`${base}/text-to-speech/${encodeURIComponent(this.options.voiceId)}/stream`, {
      method: 'POST',
      signal,
      headers: {
        'Content-Type': 'application/json',
        'xi-api-key': this.options.apiKey,
      },
      body: JSON.stringify({
        text,
        model_id: this.options.modelId ?? 'eleven_multilingual_v2',
      }),
    });
    if (!response.ok || !response.body) {
      throw new Error(`ElevenLabs TTS failed (${response.status})`);
    }
    const contentType = response.headers.get('content-type') || 'audio/mpeg';
    for await (const chunk of response.body as any as AsyncIterable<Uint8Array>) {
      yield { audio: chunk, contentType };
    }
  }
}

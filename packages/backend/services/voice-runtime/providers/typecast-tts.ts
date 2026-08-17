/**
 * Owns: Typecast streaming TTS HTTP adapter.
 * Public API: TypecastTtsProvider. See ../README.md.
 */

import type { StreamingTtsProvider, TtsAudioChunk } from '../types.js';

export interface TypecastTtsOptions {
  apiKey: string;
  voiceId: string;
  model?: string;
  endpoint?: string;
  emotionType?: 'normal' | 'smart';
}

/** Streams Korean speech from Typecast without exposing its credential to the browser. */
export class TypecastTtsProvider implements StreamingTtsProvider {
  readonly name = 'typecast' as const;

  constructor(private readonly options: TypecastTtsOptions) {}

  async *synthesize(text: string, signal?: AbortSignal): AsyncIterable<TtsAudioChunk> {
    const response = await fetch(this.options.endpoint ?? 'https://api.typecast.ai/v1/text-to-speech', {
      method: 'POST',
      signal,
      headers: {
        'Content-Type': 'application/json',
        'X-API-KEY': this.options.apiKey,
      },
      body: JSON.stringify({
        text,
        voice_id: this.options.voiceId,
        model: this.options.model ?? 'ssfm-v30',
        prompt: { emotion_type: this.options.emotionType ?? 'normal' },
      }),
    });
    if (!response.ok || !response.body) {
      throw new Error(`Typecast TTS failed (${response.status})`);
    }
    const contentType = response.headers.get('content-type') || 'audio/wav';
    for await (const chunk of response.body as any as AsyncIterable<Uint8Array>) {
      yield { audio: chunk, contentType };
    }
  }
}

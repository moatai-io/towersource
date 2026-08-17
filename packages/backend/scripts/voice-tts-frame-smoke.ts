/** Verify LiveKit Inference TTS returns non-empty PCM frames for the configured Korean voice. */
import { ReadableStream } from 'node:stream/web';
import { inference, initializeLogger } from '@livekit/agents';
import { queryOne } from '../db/pg-repo.js';
import { resolveProjectApiKeySecretValue } from '../services/credential-vault/credential-vault-service.js';
import { DEFAULT_KOREAN_TTS_VOICE } from '../services/voice-runtime/livekit-inference-worker.js';

async function main() {
  const projectId = process.argv[2];
  const actor = await queryOne<{ user_id: number }>(`SELECT user_id FROM sessions WHERE project_id=$1 AND user_id IS NOT NULL ORDER BY updated_at DESC LIMIT 1`, [projectId]);
  if (!actor) throw new Error('actor unavailable');
  const targetType = 'voice_tts_frame_smoke';
  const [url, key, secret] = await Promise.all(['LIVEKIT_URL','LIVEKIT_API_KEY','LIVEKIT_API_SECRET'].map(envName => resolveProjectApiKeySecretValue({ projectId, userId: actor.user_id, envName, targetType })));
  if (!url || !key || !secret) throw new Error('connection unavailable');
  initializeLogger({ pretty: false, level: 'error' });
  const provider = process.argv.includes('--inworld') ? 'inworld' : process.argv.includes('--elevenlabs') ? 'elevenlabs' : 'cartesia';
  const selected = {
    cartesia: { model: 'cartesia/sonic-3', voice: DEFAULT_KOREAN_TTS_VOICE, language: 'ko' },
    inworld: { model: 'inworld/inworld-tts-2', voice: 'Seojun', language: 'ko-KR' },
    elevenlabs: { model: 'elevenlabs/eleven_flash_v2', voice: 'Xb7hH8MSUJpSbSDYk0k2', language: 'ko' },
  }[provider];
  const { model, voice, language } = selected;
  process.env.LIVEKIT_URL = url.value;
  const tts = new inference.TTS({ model, voice, language, apiKey: key.value, apiSecret: secret.value });
  let events = 0; let samples = 0;
  const stream = tts.stream();
  stream.updateInputStream(new ReadableStream<string>({
    start(controller) {
      controller.enqueue('연결됐어요. 말씀해 주세요.');
      controller.close();
    },
  }));
  try {
    for await (const event of stream) {
      if (!event || typeof event !== 'object' || !('frame' in event)) continue;
      events += 1;
      samples += event.frame.data.length;
    }
  } finally { stream.close(); await tts.close(); }
  console.log(`tts_pcm=${samples > 0 ? 'pass' : 'fail'} provider=${provider} model=${model} voice=${voice} events=${events} samples=${samples}`);
  if (!samples) process.exit(1);
}
main().catch(error => { console.error(`tts_pcm=fail reason=${error?.message || 'unknown'}`); process.exit(1); });

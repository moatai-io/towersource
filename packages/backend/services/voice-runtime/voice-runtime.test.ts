import fs from 'fs';
import path from 'path';
import { describe, expect, it, vi } from 'vitest';
import { VoiceSessionManager } from './voice-session-manager.js';
import { buildSafeAcknowledgement, normalizeSpokenAnswer } from './voice-response-policy.js';
import { TypecastTtsProvider } from './providers/typecast-tts.js';
import { createLiveKitAccessFactory } from './livekit-access.js';
import { buildLiveKitAccessFromEnv } from './voice-runtime-env.js';
import { createTowerVoiceDelegate } from './tower-voice-delegate.js';
import { DEFAULT_KOREAN_TTS_VOICE, TOWER_VOICE_AGENT_INSTRUCTIONS } from './livekit-inference-worker.js';
import { resolveVoiceTtsConfig } from './voice-tts-config.js';
import { createVoiceTurnToken, verifyVoiceTurnToken } from './voice-turn-token.js';

const voiceGatewaySource = fs.readFileSync(path.join(process.cwd(), 'packages/backend/services/voice-runtime/tower-session-turn-gateway.ts'), 'utf8');
const livekitAgentSource = fs.readFileSync(path.join(process.cwd(), 'packages/backend/services/voice-runtime/livekit-agent-entry.ts'), 'utf8');

describe('VoiceSessionManager', () => {
  it('links ephemeral voice state to a durable Tower Session and clamps spoken duration', () => {
    const manager = new VoiceSessionManager();
    const voice = manager.start('tower-session-1', 7, { maxSpokenSeconds: 90 });
    expect(voice.towerSessionId).toBe('tower-session-1');
    expect(voice.userId).toBe(7);
    expect(voice.config).toMatchObject({ sttProvider: 'clova', ttsProvider: 'typecast', language: 'ko-KR', maxSpokenSeconds: 30 });
    expect(manager.stop(voice.id, 8)).toBe(false);
    expect(manager.stop(voice.id, 7)).toBe(true);
  });
});

describe('voice runtime authority and turn timing', () => {
  it('uses the token user identity and avoids an aggressive endpointing ceiling', () => {
    expect(voiceGatewaySource).toContain("SELECT username, role FROM users WHERE id = $1");
    expect(voiceGatewaySource).toContain("username: actor?.username || 'voice'");
    expect(voiceGatewaySource).toContain("userRole: actor?.role || 'member'");
    expect(voiceGatewaySource).not.toContain("userRole: 'member'");
    expect(livekitAgentSource).toContain("minDelay: 1300, maxDelay: 3000");
    expect(livekitAgentSource).toContain('minDuration: 500');
    expect(livekitAgentSource).toContain('minWords: 2');
    expect(livekitAgentSource).toContain('falseInterruptionTimeout: 2000');
    expect(livekitAgentSource).toContain('AgentSessionEventTypes.OverlappingSpeech');
    expect(livekitAgentSource).toContain('VoiceTurnOrchestrator');
    expect(livekitAgentSource).toContain('stage: \'tower_supersede_requested\'');
    expect(livekitAgentSource).toContain('requestVoiceTurnCancellation(towerSessionId)');
    expect(voiceGatewaySource).toContain('requestAgentTurnStop');
    expect(voiceGatewaySource).toContain('rejectAgentTurnStopRequest');
    expect(voiceGatewaySource).toContain('requestStopAtBoundary');
    expect(livekitAgentSource).toContain('signal: requestController.signal');
    expect(livekitAgentSource).toContain('attempt < 30');
    expect(livekitAgentSource).not.toContain('잠깐 확인해볼게요.');
    expect(livekitAgentSource).toContain('turnOrchestrator.hasPendingTranscript()');
    expect(livekitAgentSource).toContain('turnOrchestrator.takeTranscript()');
    expect(livekitAgentSource).toContain('VoiceTurnOrchestrator.DEFAULT_SILENCE_MS');
    expect(livekitAgentSource).not.toContain('pendingTranscripts');
    expect(livekitAgentSource).toContain('activeRequestController?.abort()');
    expect(livekitAgentSource).toContain("stage: 'tower_superseded'");
    expect(livekitAgentSource).not.toContain('tower_cancelled');
  });
});

describe('voice turn capability', () => {
  it('binds the token to the active voice session and exact expiry', () => {
    const manager = new VoiceSessionManager(60_000);
    const voice = manager.start('tower-session-1', 7);
    const token = createVoiceTurnToken({
      sessionId: voice.towerSessionId,
      voiceSessionId: voice.id,
      userId: voice.userId,
      expiresAt: Date.parse(voice.expiresAt),
    });
    expect(verifyVoiceTurnToken(token)).toMatchObject({
      sessionId: 'tower-session-1', voiceSessionId: voice.id, userId: 7,
    });
    expect(manager.stop(voice.id, 7)).toBe(true);
    expect(manager.get(voice.id)).toBeNull();
  });

  it('rejects expired and tampered voice capabilities', () => {
    const expired = createVoiceTurnToken({
      sessionId: 's1', voiceSessionId: 'v1', userId: 7, expiresAt: Date.now() - 1,
    });
    expect(verifyVoiceTurnToken(expired)).toBeNull();
    expect(verifyVoiceTurnToken(`${expired}x`)).toBeNull();
  });
});

describe('voice response policy', () => {
  it('uses a safe non-factual bridge and strips screen-only syntax', () => {
    expect(buildSafeAcknowledgement(0)).toContain('확인');
    const spoken = normalizeSpokenAnswer('## 결론\n- **첫째** `npm test`를 실행하세요.\n- https://example.com 참고');
    expect(spoken).not.toMatch(/##|\*\*|`/);
    expect(spoken).toContain('첫째 npm test를 실행하세요.');
    expect(spoken).toContain('https://example.com 참고');
  });

  it('preserves line boundaries as audible pauses', () => {
    const spoken = normalizeSpokenAnswer('첫 문장입니다.\n둘째 문장입니다.\n\n마지막 문장입니다.');
    expect(spoken).toContain('첫 문장입니다.\n둘째');
    expect(spoken).toContain('\n\n마지막 문장입니다.');
  });

  it('preserves long answers and all sentences instead of clipping them', () => {
    const longAnswer = '가'.repeat(700);
    expect(normalizeSpokenAnswer(longAnswer)).toBe(longAnswer);
    const spoken = normalizeSpokenAnswer('첫 문장입니다. 둘째 문장입니다. 셋째 문장입니다. 넷째 문장입니다.');
    expect(spoken).toContain('첫 문장입니다.');
    expect(spoken).toContain('넷째 문장입니다.');
    expect(spoken).not.toContain('화면에 남겼어요');
  });
});

describe('voice TTS selection', () => {
  it('keeps Cartesia as the safe default and requires explicit Inworld opt-in', () => {
    expect(resolveVoiceTtsConfig({})).toMatchObject({ provider: 'cartesia', model: 'cartesia/sonic-3' });
    expect(resolveVoiceTtsConfig({ TOWER_VOICE_TTS_PROVIDER: 'inworld' })).toMatchObject({
      provider: 'inworld', model: 'inworld/inworld-tts-2', voice: 'Seojun', language: 'ko-KR',
    });
    expect(resolveVoiceTtsConfig({ TOWER_VOICE_TTS_PROVIDER: 'unknown' })).toMatchObject({ provider: 'cartesia' });
    expect(resolveVoiceTtsConfig({ TOWER_VOICE_TTS_PROVIDER: 'cartesia' }, 'inworld')).toMatchObject({
      provider: 'inworld', voice: 'Seojun',
    });
  });
});

describe('LiveKit access', () => {
  it('issues a short-lived microphone-only room token and stays disabled without complete env', async () => {
    expect(buildLiveKitAccessFromEnv({ LIVEKIT_URL: 'wss://example.livekit.cloud' })).toBeUndefined();
    const createAccess = createLiveKitAccessFactory({
      url: 'wss://example.livekit.cloud',
      apiKey: 'api-key',
      apiSecret: 'api-secret-api-secret-api-secret',
      ttlSeconds: 60,
    });
    const result = await createAccess({ roomName: 'room-1', userIdentity: 'user-7' });
    expect(result.url).toBe('wss://example.livekit.cloud');
    const payload = JSON.parse(Buffer.from(result.token.split('.')[1], 'base64url').toString('utf8'));
    expect(payload.sub).toBe('user-7');
    expect(payload.video).toMatchObject({ room: 'room-1', roomJoin: true, canPublish: true, canSubscribe: true });
    expect(payload.video.canPublishSources).toEqual(['microphone']);
  });
});

describe('Tower voice delegation', () => {
  it('keeps the durable Tower Session as the factual work boundary', async () => {
    const run = vi.fn().mockResolvedValue({ assistantText: '결과입니다.' });
    const delegate = createTowerVoiceDelegate({ run });
    await expect(delegate.runTurn({ towerSessionId: 's1', transcript: '검색해줘' })).resolves.toBe('결과입니다.');
    expect(run).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 's1',
      message: '검색해줘',
      metadata: { sourceType: 'voice', responseMode: 'spoken-korean' },
    }));
    expect(DEFAULT_KOREAN_TTS_VOICE).toMatch(/^[0-9a-f-]{36}$/);
    expect(TOWER_VOICE_AGENT_INSTRUCTIONS).toContain('듣기 좋은 짧은 문장');
    expect(TOWER_VOICE_AGENT_INSTRUCTIONS).toContain('Tower Session에 위임');
  });
});

describe('TypecastTtsProvider', () => {
  it('keeps the API key server-side and streams provider audio', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(new Uint8Array([1, 2, 3]), {
      status: 200,
      headers: { 'content-type': 'audio/wav' },
    }));
    const provider = new TypecastTtsProvider({ apiKey: 'redacted-test-key', voiceId: 'voice-1' });
    const chunks = [];
    for await (const chunk of provider.synthesize('안녕하세요')) chunks.push(chunk);
    expect(chunks[0]?.contentType).toBe('audio/wav');
    expect(fetchMock).toHaveBeenCalledWith('https://api.typecast.ai/v1/text-to-speech', expect.objectContaining({
      method: 'POST',
      headers: expect.objectContaining({ 'X-API-KEY': 'redacted-test-key' }),
    }));
    fetchMock.mockRestore();
  });
});

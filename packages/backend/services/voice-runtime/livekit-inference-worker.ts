/**
 * Owns: LiveKit Inference voice pipeline and Tower delegation boundary.
 * Public API: createLiveKitInferenceSession, TOWER_VOICE_AGENT_INSTRUCTIONS. See README.md.
 */

import { Agent, AgentSession, AgentSessionEventTypes, inference } from '@livekit/agents';
import type { Room } from '@livekit/rtc-node';
import { buildSafeAcknowledgement, normalizeSpokenAnswer } from './voice-response-policy.js';

// Cartesia requires a voice UUID, not the display name shown in voice catalogs.
export const DEFAULT_KOREAN_TTS_VOICE = '9626c31c-bec5-4cca-baa8-f8ba9e84c8bc';

export const TOWER_VOICE_AGENT_INSTRUCTIONS = `
지금은 한국어 음성 대화 중이다.
답변은 결론부터 자연스럽게 말한다. 핵심과 중요한 조건은 생략하지 않되, 듣기 좋은 짧은 문장으로 구어체에 가깝게 표현한다.
질문은 한 번에 하나만 한다.
목록, 마크다운, URL, 코드와 긴 파일 경로를 소리 내 읽지 않는다.
실제 검색·파일·도구 작업은 Tower Session에 위임한다.
`.trim();

export interface TowerVoiceDelegate {
  /** Persist the final transcript and run the existing Tower Agent turn. */
  runTurn(input: { towerSessionId: string; transcript: string; signal?: AbortSignal }): Promise<string>;
}

export interface LiveKitInferenceSessionOptions {
  room: Room;
  towerSessionId: string;
  delegate: TowerVoiceDelegate;
  sttModel?: string;
  ttsModel?: string;
  ttsVoice?: string;
  acknowledgementSeed?: number;
  signal?: AbortSignal;
}

/**
 * Start a Korean STT/TTS pipeline. LiveKit handles audio and interruption while
 * the durable Tower Agent remains the only source of factual/work answers.
 */
export async function createLiveKitInferenceSession(options: LiveKitInferenceSessionOptions): Promise<AgentSession> {
  const session = new AgentSession({
    stt: new inference.STT({ model: options.sttModel ?? 'deepgram/nova-2', language: 'ko-KR' }),
    tts: inference.TTS.fromModelString(
      `${options.ttsModel ?? 'cartesia/sonic-3'}:${options.ttsVoice ?? DEFAULT_KOREAN_TTS_VOICE}`,
    ),
    turnHandling: {
      turnDetection: 'stt',
      interruption: { enabled: true },
    },
  });
  const agent = new Agent({ instructions: TOWER_VOICE_AGENT_INSTRUCTIONS });
  let activeTurn: AbortController | null = null;

  session.on(AgentSessionEventTypes.UserInputTranscribed, (event) => {
    if (!event.isFinal || !event.transcript.trim()) return;
    activeTurn?.abort();
    activeTurn = new AbortController();
    if (options.signal) {
      if (options.signal.aborted) activeTurn.abort();
      else options.signal.addEventListener('abort', () => activeTurn?.abort(), { once: true });
    }
    const controller = activeTurn;
    void (async () => {
      try {
        session.say(buildSafeAcknowledgement(options.acknowledgementSeed), {
          allowInterruptions: true,
          addToChatCtx: false,
        });
        const answer = await options.delegate.runTurn({
          towerSessionId: options.towerSessionId,
          transcript: event.transcript.trim(),
          signal: controller.signal,
        });
        if (controller.signal.aborted) return;
        const spoken = normalizeSpokenAnswer(answer);
        if (spoken) session.say(spoken, { allowInterruptions: true, addToChatCtx: false });
      } catch (error) {
        if (controller.signal.aborted) return;
        session.say('지금은 작업을 이어가지 못했어요. 내용은 화면에서 다시 확인해 주세요.', {
          allowInterruptions: true,
          addToChatCtx: false,
        });
      }
    })();
  });

  await session.start({
    agent,
    room: options.room,
    record: false,
  });
  session.pauseReplyAuthorization();
  return session;
}

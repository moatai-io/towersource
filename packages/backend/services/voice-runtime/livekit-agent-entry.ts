/** Owns: LiveKit job entry for the Korean voice worker. */
import { Agent, AgentSession, AgentSessionEventTypes, defineAgent, inference, log } from '@livekit/agents';
import { normalizeSpokenAnswer } from './voice-response-policy.js';
import { resolveVoiceTtsConfig } from './voice-tts-config.js';
import { VoiceTurnOrchestrator } from './voice-turn-orchestrator.js';
import { requestVoiceTurnCancellation } from './tower-session-turn-gateway.js';

export default defineAgent({
  entry: async (ctx) => {
    const metadata = JSON.parse(ctx.job.metadata || '{}') as {
      towerSessionId?: string;
      turnToken?: string;
      inferenceTtsProvider?: 'cartesia' | 'inworld';
    };
    if (!metadata.towerSessionId || !metadata.turnToken) throw new Error('Tower voice dispatch metadata missing');
    const towerSessionId = metadata.towerSessionId;
    await ctx.connect();
    const ttsConfig = resolveVoiceTtsConfig(process.env, metadata.inferenceTtsProvider);
    const session = new AgentSession({
      stt: new inference.STT({ model: 'deepgram/nova-2', language: 'ko-KR' }),
      tts: new inference.TTS({
        model: ttsConfig.model,
        voice: ttsConfig.voice,
        language: ttsConfig.language as any,
        modelOptions: ttsConfig.modelOptions,
      }),
      turnHandling: {
        // Fixed endpointing avoids the dynamic detector learning an overly short
        // pause from one clipped utterance and cutting the next sentence early.
        endpointing: { mode: 'fixed', minDelay: 1300, maxDelay: 3000, alpha: 0.9 },
        interruption: {
          enabled: true,
          minDuration: 500,
          minWords: 2,
          falseInterruptionTimeout: 2000,
          resumeFalseInterruption: true,
        },
      },
    });
    const turnOrchestrator = new VoiceTurnOrchestrator();
    let processing = false;
    let closed = false;
    let debounceTimer: NodeJS.Timeout | null = null;
    let activeRequestController: AbortController | null = null;
    const processTurns = async () => {
      if (processing) return;
      processing = true;
      while (turnOrchestrator.hasPendingTranscript() && !closed) {
        const transcript = turnOrchestrator.takeTranscript();
        const turnStartedAt = Date.now();
        try {
          log().info({ stage: 'tower_start', transcriptLength: transcript.length }, 'voice turn stage');
          // Voice mode stays silent while Tower is settling an earlier turn.
          // Repeated bridge phrases compete with the user's next utterance.
          let response = new Response(null, { status: 503 });
          let body: { assistantText?: string; error?: string } = {};
          const requestController = new AbortController();
          activeRequestController = requestController;
          turnOrchestrator.markThinking();
          for (let attempt = 0; attempt < 30; attempt += 1) {
            response = await fetch('http://127.0.0.1:32355/api/voice/internal/turn', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ token: metadata.turnToken, transcript }),
              signal: requestController.signal,
            });
            body = await response.json().catch(() => ({})) as { assistantText?: string; error?: string };
            const busy = body.assistantText === '지금 이 대화의 이전 음성 답변을 마무리하고 있어요. 끝나면 다시 말씀해 주세요.';
            if (!busy || closed) break;
            log().info({ stage: 'tower_busy_retry', attempt: attempt + 1 }, 'voice turn stage');
            await new Promise((resolve) => setTimeout(resolve, 500));
          }
          if (activeRequestController === requestController) activeRequestController = null;
          if (!response!.ok || !body!.assistantText) throw new Error(body!.error || `Tower turn failed (${response!.status})`);
          log().info({ stage: 'tower_done', durationMs: Date.now() - turnStartedAt, answerLength: body.assistantText.length }, 'voice turn stage');
          const spoken = normalizeSpokenAnswer(body.assistantText);
          if (spoken) {
            session.say(spoken, { allowInterruptions: true, addToChatCtx: false });
            turnOrchestrator.markSpeaking();
            log().info({ stage: 'tts_queued', spokenLength: spoken.length }, 'voice turn stage');
          }
        } catch (error: any) {
          if (activeRequestController) activeRequestController = null;
          if (closed || error?.name === 'AbortError') {
            if (error?.name === 'AbortError') log().info({ stage: 'tower_superseded', durationMs: Date.now() - turnStartedAt }, 'voice turn stage');
            continue;
          }
          log().error({ error }, 'Tower voice turn failed');
          session.say('지금은 Tower 답변을 가져오지 못했어요. 잠시 후 다시 말씀해 주세요.', { allowInterruptions: true, addToChatCtx: false });
        }
      }
      processing = false;
    };
    session.on(AgentSessionEventTypes.Error, (event) => {
      log().error({ error: event.error }, 'voice provider error');
    });
    session.on(AgentSessionEventTypes.UserStateChanged, (event) => {
      log().info({ stage: 'user_state', oldState: event.oldState, newState: event.newState }, 'voice turn state');
      if (event.newState === 'speaking' && activeRequestController) {
        turnOrchestrator.markUserSpeaking();
        log().info({ stage: 'user_resumed_during_request' }, 'voice turn state');
      }
    });
    session.on(AgentSessionEventTypes.AgentStateChanged, (event) => {
      log().info({ stage: 'agent_state', oldState: event.oldState, newState: event.newState }, 'voice turn state');
    });
    session.on(AgentSessionEventTypes.OverlappingSpeech, (event) => {
      log().info({ stage: 'overlapping_speech', event }, 'voice turn state');
    });
    session.on(AgentSessionEventTypes.AgentFalseInterruption, (event) => {
      log().info({ stage: 'false_interruption', resumed: event.resumed }, 'voice turn state');
    });
    session.on(AgentSessionEventTypes.Close, () => {
      closed = true;
      activeRequestController?.abort();
      activeRequestController = null;
      turnOrchestrator.clear();
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = null;
    });
    session.on(AgentSessionEventTypes.UserInputTranscribed, (event) => {
      if (!event.isFinal || !event.transcript.trim()) return;
      const transcript = event.transcript.trim();
      const result = turnOrchestrator.appendFinalTranscript(transcript, Boolean(activeRequestController));
      if (result.superseded) {
        activeRequestController?.abort();
        activeRequestController = null;
        void requestVoiceTurnCancellation(towerSessionId).then((cancelled) => {
          log().info({ stage: cancelled ? 'tower_cancel_requested' : 'tower_cancel_unavailable' }, 'voice turn stage');
        }).catch((error) => {
          log().warn({ error }, 'voice turn cancellation request failed');
        });
        log().info({ stage: 'tower_supersede_requested', transcriptLength: transcript.length }, 'voice turn stage');
      }
      log().info({ stage: 'stt_final', transcriptLength: transcript.length }, 'voice turn stage');
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => void processTurns(), VoiceTurnOrchestrator.DEFAULT_SILENCE_MS);
    });
    await session.start({
      room: ctx.room,
      agent: new Agent({ instructions: '한국어 음성 입력을 Tower Session으로 전달한다.' }),
      record: false,
    });
    log().info({ room: ctx.room.name, towerSessionId: metadata.towerSessionId, ttsProvider: ttsConfig.provider }, 'voice session ready');
    session.say('연결됐어요. 말씀해 주세요.', { allowInterruptions: true, addToChatCtx: false });
  },
});

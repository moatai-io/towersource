/** Owns: LiveKit job entry for the Korean voice worker. */
import { Agent, AgentSession, AgentSessionEventTypes, StopResponse, defineAgent, inference, log } from '@livekit/agents';
import { resolveVoiceTtsConfig } from './voice-tts-config.js';
import { createVoiceWorkerHttpGateway, VoiceWorkerController, VOICE_UI_TOPIC } from './voice-worker-controller.js';

/** STT and VAD remain enabled; the worker scheduler alone may request an answer. */
class TowerVoiceInputAgent extends Agent {
  constructor(private readonly onEndpoint: () => void) {
    super({ instructions: '한국어 음성 입력을 Tower Session으로 전달한다.' });
  }
  override async onUserTurnCompleted(): Promise<void> {
    this.onEndpoint();
    throw new StopResponse();
  }
}

export default defineAgent({
  entry: async (ctx) => {
    const metadata = JSON.parse(ctx.job.metadata || '{}') as {
      towerSessionId?: string;
      turnToken?: string;
      inferenceTtsProvider?: 'cartesia' | 'inworld';
    };
    if (!metadata.towerSessionId || !metadata.turnToken) throw new Error('Tower voice dispatch metadata missing');
    // Operator-controlled API base, not room metadata (which must not redirect tokens).
    const backendApiUrl = process.env.TOWER_VOICE_BACKEND_URL
      || 'http://127.0.0.1:32355/api';
    const gateway = createVoiceWorkerHttpGateway({
      baseUrl: backendApiUrl, token: metadata.turnToken,
      canStart: () => controller.canExecute,
    });
    await ctx.connect();
    const ttsConfig = resolveVoiceTtsConfig(process.env, metadata.inferenceTtsProvider);
    const session = new AgentSession({
      stt: new inference.STT({ model: 'deepgram/nova-2', language: 'ko-KR' }),
      // No llm: Tower's authenticated backend owns reasoning and tool execution.
      // SDK 1.6.3 provisions its bundled silero VAD when vad is undefined.
      tts: new inference.TTS({
        model: ttsConfig.model,
        voice: ttsConfig.voice,
        language: ttsConfig.language as any,
        modelOptions: ttsConfig.modelOptions,
      }),
      turnHandling: {
        // FINAL_TRANSCRIPT is emitted before runEOUDetection's delay (SDK 1.6.3).
        // This does not add another 1.3s before our UserInputTranscribed callback.
        endpointing: { mode: 'fixed', minDelay: 1300, maxDelay: 3000, alpha: 0.9 },
        // Disable SDK's competing pause/resume policy. VAD still emits user-state
        // changes; the controller interrupts its exact SpeechHandle, even for '잠깐'.
        interruption: { enabled: false },
      },
    });
    const controller = new VoiceWorkerController({
      gateway,
      say: (text) => session.say(text, { allowInterruptions: true, addToChatCtx: false }),
      onUiEvent: (event) => {
        // Reliable room-scoped packets; no token, user identity or durable write.
        const data = new TextEncoder().encode(JSON.stringify(event));
        void ctx.room.localParticipant?.publishData(data, { reliable: true, topic: VOICE_UI_TOPIC })
          .catch(() => log().info({ stage: 'voice_ui_publish_failed' }, 'voice UI packet failed'));
      },
      onEvent: (stage, details) => log().info({ stage, ...details }, 'voice turn stage'),
    });
    session.on(AgentSessionEventTypes.Error, (event) => {
      log().error({ error: event.error }, 'voice provider error');
    });
    session.on(AgentSessionEventTypes.UserStateChanged, (event) => {
      log().info({ stage: 'user_state', oldState: event.oldState, newState: event.newState }, 'voice turn state');
      controller.onUserState(event.newState === 'speaking');
    });
    session.on(AgentSessionEventTypes.AgentStateChanged, (event) => {
      log().info({ stage: 'agent_state', oldState: event.oldState, newState: event.newState }, 'voice turn state');
      // SDK sayTask onFirstFrame updates state on AudioOutput playbackStarted.
      // Room output emits this before captureFrame: this is server-output evidence,
      // not confirmation that a browser speaker actually played the frame.
      const speechId = session.currentAgent.getActivityOrThrow().currentSpeech?.id;
      if (event.newState === 'speaking' && speechId) controller.onPlaybackStarted(speechId);
    });
    session.on(AgentSessionEventTypes.Close, () => { void controller.close(); });
    ctx.addShutdownCallback(async () => controller.close());
    session.on(AgentSessionEventTypes.UserInputTranscribed, (event) => {
      if (event.isFinal) controller.onFinalTranscript(event.transcript);
      else controller.onInterimTranscript(event.transcript);
    });
    try {
      await session.start({
        room: ctx.room,
        agent: new TowerVoiceInputAgent(() => controller.onSdkEndOfTurn()),
        record: false,
      });
    } catch (error) {
      await controller.close();
      throw error;
    }
    log().info({ room: ctx.room.name, towerSessionId: metadata.towerSessionId, ttsProvider: ttsConfig.provider }, 'voice session ready');
    // No automatic greeting: it obscures meaningful-audio QA and races user speech.
  },
});

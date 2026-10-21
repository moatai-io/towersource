import { beforeEach, describe, expect, it, vi } from 'vitest';

const harness = vi.hoisted(() => ({
  session: null as any, controller: null as any, sessionOptions: null as any,
  controllerOptions: null as any, gatewayOptions: null as any, handlers: new Map<string, (event: any) => void>(),
}));
vi.mock('@livekit/agents', () => {
  class StopResponse extends Error {}
  class Agent { constructor(public options: unknown) {} }
  class AgentSession {
    currentAgent: any;
    constructor(options: unknown) { harness.sessionOptions = options; harness.session = this; }
    on(name: string, handler: (event: any) => void) { harness.handlers.set(name, handler); }
    async start(options: any) { this.currentAgent = options.agent; }
    say = vi.fn();
  }
  return {
    Agent, AgentSession, StopResponse,
    defineAgent: (value: unknown) => value,
    inference: { STT: class {}, TTS: class {} },
    log: () => ({ info: vi.fn(), error: vi.fn() }),
    AgentSessionEventTypes: {
      Error: 'error', UserStateChanged: 'user', AgentStateChanged: 'agent',
      Close: 'close', UserInputTranscribed: 'transcript',
    },
  };
});
vi.mock('./voice-worker-controller.js', () => ({
  VoiceWorkerController: class {
    canExecute = false;
    onSdkEndOfTurn = vi.fn();
    onUserState = vi.fn();
    onInterimTranscript = vi.fn();
    onFinalTranscript = vi.fn();
    onPlaybackStarted = vi.fn();
    close = vi.fn(async () => {});
    constructor(options: unknown) { harness.controllerOptions = options; harness.controller = this; }
  },
  VOICE_UI_TOPIC: 'tower.voice.ui.v1',
  createVoiceWorkerHttpGateway: (options: unknown) => { harness.gatewayOptions = options; return {}; },
}));
vi.mock('./voice-tts-config.js', () => ({
  resolveVoiceTtsConfig: () => ({ model: 'test', voice: 'test', language: 'ko-KR', provider: 'test' }),
}));

import entry from './livekit-agent-entry.js';
import { StopResponse } from '@livekit/agents';

beforeEach(() => { harness.handlers.clear(); vi.unstubAllEnvs(); });

describe('worker SDK wiring without providers', () => {
  it('suppresses automatic replies, tracks the actual playing handle, and awaits shutdown cancellation', async () => {
    vi.stubEnv('TOWER_VOICE_BACKEND_URL', 'http://backend.test:9000/api');
    const ctx = {
      job: { metadata: JSON.stringify({ towerSessionId: 'session-test', turnToken: 'test-token' }) },
      room: { name: 'room-test', localParticipant: { publishData: vi.fn(async () => {}) } }, connect: vi.fn(async () => {}), addShutdownCallback: vi.fn(),
    };
    await entry.entry!(ctx as any);
    expect(harness.sessionOptions.llm).toBeUndefined();
    expect(harness.sessionOptions.turnHandling.interruption.enabled).toBe(false);
    await expect(harness.session.currentAgent.onUserTurnCompleted()).rejects.toBeInstanceOf(StopResponse);
    expect(harness.gatewayOptions.baseUrl).toBe('http://backend.test:9000/api');
    expect(harness.gatewayOptions.canStart()).toBe(false);
    harness.controller.canExecute = true;
    expect(harness.gatewayOptions.canStart()).toBe(true);
    expect(harness.session.say).not.toHaveBeenCalled(); // no greeting masks audio QA

    harness.handlers.get('user')!({ oldState: 'listening', newState: 'speaking' });
    expect(harness.controller.onUserState).toHaveBeenCalledWith(true);
    harness.handlers.get('transcript')!({ isFinal: false, transcript: 'partial' });
    expect(harness.controller.onFinalTranscript).not.toHaveBeenCalled();
    expect(harness.controller.onInterimTranscript).toHaveBeenCalledWith('partial');
    harness.handlers.get('transcript')!({ isFinal: true, transcript: 'final' });
    expect(harness.controller.onFinalTranscript).toHaveBeenCalledWith('final');
    harness.session.currentAgent.getActivityOrThrow = () => ({ currentSpeech: { id: 'actual-playing-handle' } });
    harness.handlers.get('agent')!({ oldState: 'thinking', newState: 'speaking' });
    expect(harness.controller.onPlaybackStarted).toHaveBeenCalledWith('actual-playing-handle');
    harness.controllerOptions.onUiEvent({ v: 1, seq: 1, kind: 'input', text: 'partial', final: false });
    expect(ctx.room.localParticipant.publishData).toHaveBeenCalledWith(expect.any(Uint8Array),
      { reliable: true, topic: 'tower.voice.ui.v1' });
    await ctx.addShutdownCallback.mock.calls[0][0]();
    expect(harness.controller.close).toHaveBeenCalledTimes(1);
  });
});

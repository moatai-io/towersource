import { describe, expect, it } from 'vitest';
import { VoiceTurnOrchestrator } from './voice-turn-orchestrator.js';

describe('VoiceTurnOrchestrator', () => {
  it('joins adjacent final transcripts into one input after a longer initial wait', () => {
    const orchestrator = new VoiceTurnOrchestrator();
    orchestrator.appendFinalTranscript('첫 번째 내용', false);
    orchestrator.appendFinalTranscript('그리고 두 번째 내용', false);
    expect(orchestrator.hasPendingTranscript()).toBe(true);
    expect(orchestrator.takeTranscript()).toBe('첫 번째 내용 그리고 두 번째 내용');
    expect(VoiceTurnOrchestrator.DEFAULT_SILENCE_MS).toBe(1300);
  });

  it('supersedes thinking when resumed speech is confirmed by a final transcript', () => {
    const orchestrator = new VoiceTurnOrchestrator();
    orchestrator.appendFinalTranscript('아직 말하는 중인데', false);
    expect(orchestrator.takeTranscript()).toBe('아직 말하는 중인데');
    orchestrator.markThinking();
    orchestrator.markUserSpeaking();
    const result = orchestrator.appendFinalTranscript('뒤 내용을 이어서 말합니다', true);
    expect(result.superseded).toBe(true);
    expect(orchestrator.takeTranscript()).toBe('뒤 내용을 이어서 말합니다');
  });

  it('does not supersede a turn for a final transcript without resumed speaking', () => {
    const orchestrator = new VoiceTurnOrchestrator();
    orchestrator.appendFinalTranscript('질문', false);
    orchestrator.takeTranscript();
    orchestrator.markThinking();
    const result = orchestrator.appendFinalTranscript('짧은 소리', true);
    expect(result.superseded).toBe(false);
  });

  it('keeps a completed spoken turn separate from a new interruption', () => {
    const orchestrator = new VoiceTurnOrchestrator();
    orchestrator.markSpeaking();
    const result = orchestrator.appendFinalTranscript('새로운 질문', true);
    expect(result.superseded).toBe(false);
    expect(orchestrator.getState()).toBe('speaking');
  });
});

import { describe, expect, it } from 'vitest';
import { VoiceTurnOrchestrator } from './voice-turn-orchestrator.js';

describe('VoiceTurnOrchestrator', () => {
  it('joins adjacent final transcripts and preserves immutable original segments', () => {
    const o = new VoiceTurnOrchestrator();
    o.appendFinalTranscript('  첫 번째 내용 ', false);
    o.appendFinalTranscript('그리고 두 번째 내용', false);
    expect(o.hasPendingTranscript()).toBe(true);
    const sent = o.takeInput();
    expect(sent).toEqual({ transcript: '첫 번째 내용 그리고 두 번째 내용', revision: 2,
      segments: ['  첫 번째 내용 ', '그리고 두 번째 내용'] });
    expect(o.hasPendingTranscript()).toBe(false);
    expect(Object.isFrozen(sent.segments)).toBe(true);
    expect(VoiceTurnOrchestrator.DEFAULT_SILENCE_MS).toBe(1300);
  });

  it('retains sent prefix across multiple finals before aborted request settles', () => {
    const o = new VoiceTurnOrchestrator();
    o.appendFinalTranscript('회의 준비를', false);
    const first = o.takeInput();
    o.markUserSpeaking();
    expect(o.appendFinalTranscript('한국어로', true).superseded).toBe(true);
    o.markUserSpeaking();
    o.appendFinalTranscript('짧게 정리해줘', false);
    expect(o.takeInput()).toMatchObject({ transcript: '회의 준비를 한국어로 짧게 정리해줘', revision: 3 });
    expect(first.transcript).toBe('회의 준비를');
    expect(first.revision).toBe(1);
  });

  it('uses a final as evidence of continuation even when VAD start was missed', () => {
    const o = new VoiceTurnOrchestrator();
    o.appendFinalTranscript('질문', false);
    o.takeTranscript();
    expect(o.appendFinalTranscript('짧은 추가', true).superseded).toBe(true);
    expect(o.takeTranscript()).toBe('질문 짧은 추가');
  });

  it('separates new input after playback start, including completed playback', () => {
    const o = new VoiceTurnOrchestrator();
    o.appendFinalTranscript('이전 질문', false);
    o.takeTranscript();
    o.markSpeaking();
    o.markPlaybackFinished();
    expect(o.appendFinalTranscript('새로운 질문', false).superseded).toBe(false);
    expect(o.takeTranscript()).toBe('새로운 질문');
  });

  it('does not increment revision for whitespace and never resets its revision counter', () => {
    const o = new VoiceTurnOrchestrator();
    o.appendFinalTranscript('질문', false);
    expect(o.appendFinalTranscript('   ', false).revision).toBe(1);
    o.clear();
    expect(o.hasPendingTranscript()).toBe(false);
    expect(o.appendFinalTranscript('다시', false).revision).toBe(2);
  });
});

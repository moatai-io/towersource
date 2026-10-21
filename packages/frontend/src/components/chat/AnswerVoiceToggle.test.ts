import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useAnswerVoice } from './AnswerVoiceToggle';
describe('session voice opt-in', () => {
  beforeEach(() => { useAnswerVoice.setState({ enabledAt: {} }); vi.stubGlobal('window', { dispatchEvent: vi.fn() }); });
  it('keeps each session independent', () => {
    useAnswerVoice.getState().toggle('a');
    expect(useAnswerVoice.getState().enabledAt.a).toBeGreaterThan(0);
    expect(useAnswerVoice.getState().enabledAt.b).toBeUndefined();
    useAnswerVoice.getState().toggle('b');
    useAnswerVoice.getState().toggle('a');
    expect(useAnswerVoice.getState().enabledAt.a).toBeUndefined();
    expect(useAnswerVoice.getState().enabledAt.b).toBeGreaterThan(0);
  });
  it('stops playback when disabling a session', () => {
    useAnswerVoice.getState().toggle('a');
    useAnswerVoice.getState().toggle('a');
    expect(window.dispatchEvent).toHaveBeenCalledOnce();
  });
});

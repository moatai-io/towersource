// @vitest-environment jsdom
import React from 'react';
import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { VoiceLiveTranscript } from './VoiceLiveTranscript';
import { initialVoiceTranscriptState as initial, parseVoiceUiMessage, voiceTranscriptReducer as reduce, VOICE_UI_MAX_BYTES, VOICE_UI_MAX_SENTENCES, type VoiceUiMessage } from './VoiceLiveTranscript.reducer';
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (_: string, options?: { defaultValue?: string }) => options?.defaultValue ?? _ }) }));
afterEach(cleanup);
const packet = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
const input = (seq = 1, revision = 1, final = false): VoiceUiMessage => ({ v: 1, seq, kind: 'input', revision, text: '안녕하세요', final });
const sentence = (seq = 2, state: 'queued' | 'speaking' | 'completed' | 'interrupted' = 'queued'): VoiceUiMessage => ({ v: 1, seq, kind: 'sentence', turnId: 'turn-1', revision: 1, speechId: 'speech-1', text: '첫 번째 문장입니다.', state });
const receive = (message: VoiceUiMessage, senderIdentity = 'agent-1', isAgent = true) => ({ type: 'receive' as const, message, senderIdentity, isAgent });
describe('voice UI wire validation', () => {
  it('accepts bounded input and sentence events', () => {
    expect(parseVoiceUiMessage(packet(input()))).toEqual(input());
    expect(parseVoiceUiMessage(packet(sentence()))).toEqual(sentence());
  });
  it.each([
    { ...input(), v: 2 }, { ...input(), seq: -1 }, { ...input(), seq: 1.1 },
    { ...input(), revision: -1 }, { ...input(), text: 'x'.repeat(4001) },
    { ...input(), final: 'true' }, { ...input(), extra: 'ignore?' },
    { ...sentence(), speechId: '' }, { ...sentence(), state: 'played' },
    { ...sentence(), turnId: undefined }, { v: 1, seq: 1, kind: 'waiting' }, null, [],
  ])('rejects malformed values %#', (value) => expect(parseVoiceUiMessage(packet(value))).toBeNull());
  it('rejects oversized and invalid UTF-8/JSON payloads', () => {
    expect(parseVoiceUiMessage(new Uint8Array(VOICE_UI_MAX_BYTES + 1))).toBeNull();
    expect(parseVoiceUiMessage(new Uint8Array([255]))).toBeNull();
    expect(parseVoiceUiMessage(new TextEncoder().encode('{'))).toBeNull();
  });
});
describe('ephemeral transcript reducer', () => {
  it('pins the first agent, ignores non-agent and foreign injection', () => {
    expect(reduce(initial, receive(input(), 'browser', false))).toBe(initial);
    const pinned = reduce(initial, receive(input()));
    expect(reduce(pinned, receive(input(2), 'agent-2'))).toBe(pinned);
  });
  it('ignores replay and stale revision; keeps final input against later interim', () => {
    const confirmed = reduce(initial, receive(input(3, 3, true)));
    expect(reduce(confirmed, receive(input(3, 3)))).toBe(confirmed);
    expect(reduce(confirmed, receive(input(4, 2)))).toBe(confirmed);
    expect(reduce(confirmed, receive(input(4, 3)))).toBe(confirmed);
  });
  it('updates by speech id, rejects state regressions, and preserves text for state-only events', () => {
    let state = reduce(initial, receive(sentence()));
    state = reduce(state, receive({ ...sentence(3, 'speaking'), text: undefined }));
    expect(state.sentences).toHaveLength(1);
    expect(state.sentences[0].text).toBe('첫 번째 문장입니다.');
    expect(reduce(state, receive(sentence(4, 'queued')))).toBe(state);
    state = reduce(state, receive(sentence(5, 'completed')));
    expect(reduce(state, receive(sentence(6, 'speaking')))).toBe(state);
  });
  it('interrupts old active output on new input revision and bounds history', () => {
    let state = initial;
    for (let index = 0; index < 40; index++) state = reduce(state, receive({ ...sentence(index), speechId: `s-${index}` }));
    expect(state.sentences).toHaveLength(VOICE_UI_MAX_SENTENCES);
    state = reduce(state, receive(input(50, 2)));
    expect(state.sentences.every((item) => item.state === 'interrupted')).toBe(true);
  });
  it('wire reset preserves replay/pin protection; room reset clears it', () => {
    let state = reduce(initial, receive(input(10)));
    state = reduce(state, receive({ v: 1, seq: 11, kind: 'reset' }));
    expect(state.input).toBeNull();
    expect(reduce(state, receive(input(5)))).toBe(state);
    expect(reduce(state, receive(input(12), 'agent-2'))).toBe(state);
    state = reduce(state, { type: 'clear' });
    expect(reduce(state, receive(input(0), 'new-agent')).senderIdentity).toBe('new-agent');
  });
});
describe('voice caption rendering', () => {
  it('does not announce interim revisions; announces confirmed input only', () => {
    const state = reduce(initial, receive(input()));
    const view = render(<VoiceLiveTranscript transcript={state} audioPlaying={false} />);
    expect(view.getByRole('status').textContent).toBe('');
    expect(view.getByText('안녕하세요').getAttribute('aria-live')).toBe('off');
    view.rerender(<VoiceLiveTranscript transcript={reduce(state, receive(input(2, 1, true)))} audioPlaying={false} />);
    expect(view.getByRole('status').textContent).toBe('입력 확정: 안녕하세요');
  });
  it('requires browser playing before emphasis; names server timing limitation', () => {
    const state = reduce(initial, receive(sentence(1, 'speaking')));
    const view = render(<VoiceLiveTranscript transcript={state} audioPlaying={false} />);
    const row = view.container.querySelector('li')!;
    expect(row.getAttribute('data-voice-highlighted')).toBe('false');
    expect(view.getByText('음성 전송 중 · 재생 미확인')).toBeTruthy();
    view.rerender(<VoiceLiveTranscript transcript={state} audioPlaying />);
    expect(row.getAttribute('data-voice-highlighted')).toBe('true');
    expect(view.getByText('문장 위치는 음성 전송 기준으로 표시됩니다.')).toBeTruthy();
    view.rerender(<VoiceLiveTranscript transcript={state} audioPlaying={false} />);
    expect(row.getAttribute('data-voice-highlighted')).toBe('false');
  });
  it('renders untrusted text as text, never markup', () => {
    const state = reduce(initial, receive({ ...input(), text: '<img src=x onerror=alert(1)>' }));
    const view = render(<VoiceLiveTranscript transcript={state} audioPlaying={false} />);
    expect(view.container.querySelector('img')).toBeNull();
    expect(view.getByText('<img src=x onerror=alert(1)>')).toBeTruthy();
  });
});

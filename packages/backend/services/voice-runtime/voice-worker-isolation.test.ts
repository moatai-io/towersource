import { afterEach, expect, it, vi } from 'vitest';
import { VoiceWorkerController, type VoiceWorkerTurn } from './voice-worker-controller.js';

function fixture(prefix: string) {
  let resolve!: (text: string) => void;
  let signal!: AbortSignal;
  const pending = new Promise<string>((yes) => { resolve = yes; });
  const cancel = vi.fn(async () => {});
  const interrupt = vi.fn();
  const say = vi.fn((_text: string) => ({ id: `${prefix}-speech`, interrupt,
    waitForPlayout: () => new Promise<void>(() => {}) }));
  const turn = vi.fn((_input: VoiceWorkerTurn, abort: AbortSignal) => { signal = abort; return pending; });
  const controller = new VoiceWorkerController({ gateway: { turn, cancel }, say,
    quietMs: 10, makeTurnId: () => `${prefix}-turn` });
  return { controller, turn, cancel, say, interrupt, resolve, signal: () => signal };
}

afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

it('closing one Session controller never cancels or drains another Session response', async () => {
  vi.useFakeTimers();
  const a = fixture('session-a');
  const b = fixture('session-b');
  a.controller.onFinalTranscript('A의 질문');
  b.controller.onFinalTranscript('B의 질문');
  await vi.advanceTimersByTimeAsync(10);
  expect(a.turn.mock.calls[0][0].transcript).toBe('A의 질문');
  expect(b.turn.mock.calls[0][0].transcript).toBe('B의 질문');
  await a.controller.close();
  expect(a.signal().aborted).toBe(true);
  expect(b.signal().aborted).toBe(false);
  expect(b.cancel).not.toHaveBeenCalled();
  a.resolve('A의 늦은 답변');
  b.resolve('B의 정상 답변');
  await vi.advanceTimersByTimeAsync(0);
  expect(a.say).not.toHaveBeenCalled();
  expect(b.say).toHaveBeenCalledWith('B의 정상 답변');
  expect(b.interrupt).not.toHaveBeenCalled();
  await b.controller.close();
});

it('speech in one Session cannot gate another Session quiet window', async () => {
  vi.useFakeTimers();
  const a = fixture('session-a');
  const b = fixture('session-b');
  a.controller.onUserState(true);
  a.controller.onFinalTranscript('A는 계속 발화 중');
  b.controller.onFinalTranscript('B의 완성된 질문');
  await vi.advanceTimersByTimeAsync(10);
  expect(a.turn).not.toHaveBeenCalled();
  expect(b.turn).toHaveBeenCalledTimes(1);
  b.resolve('B의 답변');
  await vi.advanceTimersByTimeAsync(0);
  expect(b.say).toHaveBeenCalledWith('B의 답변');
  await Promise.all([a.controller.close(), b.controller.close()]);
});

it('barge-in interrupts only the Session whose user spoke', async () => {
  vi.useFakeTimers();
  const a = fixture('session-a');
  const b = fixture('session-b');
  a.controller.onFinalTranscript('A 질문');
  b.controller.onFinalTranscript('B 질문');
  await vi.advanceTimersByTimeAsync(10);
  a.resolve('A 답변'); b.resolve('B 답변');
  await vi.advanceTimersByTimeAsync(0);
  a.controller.onPlaybackStarted('session-a-speech');
  b.controller.onPlaybackStarted('session-b-speech');
  a.controller.onUserState(true);
  expect(a.interrupt).toHaveBeenCalledTimes(1);
  expect(b.interrupt).not.toHaveBeenCalled();
  expect(b.cancel).not.toHaveBeenCalled();
  expect(b.signal().aborted).toBe(false);
  await Promise.all([a.controller.close(), b.controller.close()]);
});

it('a closed connection cannot speak after a replacement controller starts', async () => {
  vi.useFakeTimers();
  const oldConnection = fixture('old-connection');
  oldConnection.controller.onFinalTranscript('이전 연결 질문');
  await vi.advanceTimersByTimeAsync(10);
  await oldConnection.controller.close();
  const replacement = fixture('replacement');
  replacement.controller.onFinalTranscript('재연결 질문');
  await vi.advanceTimersByTimeAsync(10);
  oldConnection.resolve('이전 연결의 늦은 답변');
  oldConnection.controller.onPlaybackStarted('old-connection-speech');
  replacement.resolve('새 연결 답변');
  await vi.advanceTimersByTimeAsync(0);
  expect(oldConnection.say).not.toHaveBeenCalled();
  expect(replacement.say).toHaveBeenCalledWith('새 연결 답변');
  expect(replacement.cancel).not.toHaveBeenCalled();
  await replacement.controller.close();
});

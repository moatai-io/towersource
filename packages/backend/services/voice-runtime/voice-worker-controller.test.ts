import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createVoiceWorkerHttpGateway, VoiceWorkerController, VoiceWorkerHttpError,
  type VoiceSpeechHandle, type VoiceWorkerTurn,
} from './voice-worker-controller.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function setup(options: { deadlineMs?: number } = {}) {
  const requests: { input: VoiceWorkerTurn; signal: AbortSignal; result: ReturnType<typeof deferred<string>> }[] = [];
  const speeches: { handle: VoiceSpeechHandle; done: ReturnType<typeof deferred<void>>; text: string }[] = [];
  let ids = 0;
  const turn = vi.fn((input: VoiceWorkerTurn, signal: AbortSignal) => {
    const result = deferred<string>();
    requests.push({ input, signal, result });
    return result.promise; // deliberately ignores abort to reproduce late backend responses
  });
  const cancel = vi.fn(async () => {});
  const say = vi.fn((text: string) => {
    const done = deferred<void>();
    const handle = { id: `speech-${speeches.length}`, interrupt: vi.fn(), waitForPlayout: () => done.promise };
    speeches.push({ handle, done, text });
    return handle;
  });
  const controller = new VoiceWorkerController({ gateway: { turn, cancel }, say,
    quietMs: 100, deadlineMs: options.deadlineMs ?? 1000, makeTurnId: () => `turn-${++ids}` });
  return { controller, turn, cancel, say, requests, speeches };
}
const advance = (ms: number) => vi.advanceTimersByTimeAsync(ms);

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(0); });
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

describe('VoiceWorkerController single scheduler', () => {
  it('blocks execution during VAD speaking and starts a fresh quiet window on end', async () => {
    const t = setup();
    t.controller.onFinalTranscript('회의 준비');
    await advance(50);
    t.controller.onUserState(true);
    await advance(500);
    expect(t.turn).not.toHaveBeenCalled();
    t.controller.onUserState(false);
    await advance(99);
    expect(t.turn).not.toHaveBeenCalled();
    await advance(1);
    expect(t.requests[0].input.transcript).toBe('회의 준비');
    await t.controller.close();
  });

  it('preserves the prefix and refuses old response/finally paths before the new debounce', async () => {
    const t = setup();
    t.controller.onFinalTranscript('회의 준비를');
    await advance(100);
    const first = t.requests[0];
    t.controller.onUserState(true);
    t.controller.onFinalTranscript('한국어로');
    t.controller.onUserState(false);
    await advance(50);
    t.controller.onFinalTranscript('짧게 정리해줘');
    first.result.resolve('오래된 답변');
    await advance(99);
    expect(t.turn).toHaveBeenCalledTimes(1);
    expect(t.say).not.toHaveBeenCalled();
    expect(first.signal.aborted).toBe(true);
    expect(t.cancel).toHaveBeenCalledWith(first.input);
    await advance(1);
    expect(t.requests[1].input).toMatchObject({ transcript: '회의 준비를 한국어로 짧게 정리해줘', revision: 3 });
    expect(t.requests[1].input.turnId).not.toBe(first.input.turnId);
    t.requests[1].result.resolve('새 답변');
    await advance(1);
    expect(t.say).toHaveBeenCalledWith('새 답변');
    await t.controller.close();
  });

  it('stale rejection cannot clear a newer request controller', async () => {
    const t = setup();
    t.controller.onFinalTranscript('앞'); await advance(100);
    t.controller.onFinalTranscript('뒤'); await advance(100);
    t.requests[0].result.reject(new Error('old transport failure'));
    await advance(0);
    await t.controller.close();
    expect(t.requests[1].signal.aborted).toBe(true);
    expect(t.cancel).toHaveBeenCalledWith(t.requests[1].input);
  });

  it('holds an answer arriving during VAD and queues only after new quiet window', async () => {
    const t = setup();
    t.controller.onFinalTranscript('질문'); await advance(100);
    t.controller.onUserState(true);
    t.requests[0].result.resolve('답변'); await advance(200);
    expect(t.say).not.toHaveBeenCalled();
    t.controller.onUserState(false); await advance(99);
    expect(t.say).not.toHaveBeenCalled();
    await advance(1);
    expect(t.say).toHaveBeenCalledTimes(1);
    expect(t.controller.input.getState()).toBe('thinking');
    t.controller.onPlaybackStarted(t.speeches[0].handle.id);
    expect(t.controller.input.getState()).toBe('speaking');
    await t.controller.close();
  });

  it('queued speech is interrupted, and input still merges until output starts', async () => {
    const t = setup();
    t.controller.onFinalTranscript('이전 질문'); await advance(100);
    t.requests[0].result.resolve('대기 답변'); await advance(1);
    t.controller.onUserState(true);
    expect(t.speeches[0].handle.interrupt).toHaveBeenCalledWith(true);
    t.controller.onPlaybackStarted(t.speeches[0].handle.id); // stale SDK event
    expect(t.controller.input.getState()).toBe('thinking');
    t.controller.onFinalTranscript('추가 조건');
    t.controller.onUserState(false); await advance(100);
    expect(t.requests[1].input.transcript).toBe('이전 질문 추가 조건');
    t.speeches[0].done.resolve(); await advance(0); // stale playout completion
    await t.controller.close();
    expect(t.requests[1].signal.aborted).toBe(true);
  });

  it('requeues unheard audio only after quiet when VAD noise has no confirming final', async () => {
    const t = setup();
    t.controller.onFinalTranscript('질문'); await advance(100);
    t.requests[0].result.resolve('답변'); await advance(1);
    t.controller.onUserState(true); await advance(200);
    expect(t.say).toHaveBeenCalledTimes(1);
    t.controller.onUserState(false); await advance(100);
    expect(t.say).toHaveBeenCalledTimes(2);
    t.controller.onPlaybackStarted(t.speeches[0].handle.id);
    expect(t.controller.input.getState()).toBe('thinking');
    t.controller.onPlaybackStarted(t.speeches[1].handle.id);
    expect(t.controller.input.getState()).toBe('speaking');
    await t.controller.close();
  });

  it('separates the next question once output really starts', async () => {
    const t = setup();
    t.controller.onFinalTranscript('이전 질문'); await advance(100);
    t.requests[0].result.resolve('답변'); await advance(1);
    t.controller.onPlaybackStarted(t.speeches[0].handle.id);
    t.controller.onUserState(true);
    t.controller.onFinalTranscript('아니');
    t.controller.onUserState(false); await advance(100);
    expect(t.requests[1].input.transcript).toBe('아니');
    expect(t.cancel).toHaveBeenCalledWith(t.requests[0].input);
    await t.controller.close();
  });

  it('waits for handle playout completion rather than say queueing', async () => {
    const t = setup();
    t.controller.onFinalTranscript('질문'); await advance(100);
    t.requests[0].result.resolve('답변'); await advance(1);
    t.controller.onPlaybackStarted(t.speeches[0].handle.id);
    expect(t.controller.speechId).toBe(t.speeches[0].handle.id);
    t.speeches[0].done.resolve(); await advance(0);
    expect(t.controller.speechId).toBeUndefined();
    expect(t.controller.input.getState()).toBe('listening');
    t.controller.onFinalTranscript('새 질문'); await advance(100);
    expect(t.requests[1].input.transcript).toBe('새 질문');
    await t.controller.close();
  });

  it('deadline cancels a hung request and discards its eventual success', async () => {
    const t = setup({ deadlineMs: 200 });
    t.controller.onFinalTranscript('질문'); await advance(100);
    await advance(200);
    expect(t.requests[0].signal.aborted).toBe(true);
    expect(t.cancel).toHaveBeenCalledWith(t.requests[0].input);
    t.requests[0].result.resolve('늦음'); await advance(0);
    expect(t.say).not.toHaveBeenCalled();
    t.controller.onFinalTranscript('추가'); await advance(100);
    expect(t.requests[1].input.transcript).toBe('질문 추가');
    await t.controller.close();
  });

  it('shutdown awaits cancellation admission without claiming backend terminal completion', async () => {
    const t = setup();
    const admitted = deferred<void>();
    t.cancel.mockImplementation(() => admitted.promise);
    t.controller.onFinalTranscript('질문'); await advance(100);
    const closed = vi.fn();
    const completion = t.controller.close().then(closed);
    await advance(0);
    expect(closed).not.toHaveBeenCalled();
    admitted.resolve(); await completion;
    expect(closed).toHaveBeenCalledTimes(1);
  });

  it('close cancels timers, transport and exact queued handle, and ignores further input', async () => {
    const t = setup();
    t.controller.onFinalTranscript('질문'); await advance(100);
    t.requests[0].result.resolve('답변'); await advance(1);
    await t.controller.close(); await t.controller.close();
    expect(t.speeches[0].handle.interrupt).toHaveBeenCalledTimes(1);
    expect(t.cancel).toHaveBeenCalledTimes(1);
    t.controller.onFinalTranscript('무시'); t.controller.onUserState(false);
    await advance(1000);
    expect(t.turn).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('worker HTTP gateway', () => {
  const busy = () => Response.json({ code: 'VOICE_BUSY' }, { status: 409 });
  const input = { turnId: '88e01706-654a-4bdd-8e0f-edb708156785', revision: 2, transcript: '질문' };
  it('uses configured API base and identical turn/revision for busy retries', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(busy()).mockResolvedValueOnce(Response.json({ assistantText: '답변', turnId: input.turnId, revision: input.revision }));
    const gateway = createVoiceWorkerHttpGateway({ baseUrl: 'http://backend.test:8080/api/', token: 'test-token', fetch: fetcher });
    const answer = gateway.turn(input, new AbortController().signal);
    await advance(499); expect(fetcher).toHaveBeenCalledTimes(1);
    await advance(1); expect(await answer).toBe('답변');
    expect(fetcher.mock.calls[0][0]).toBe('http://backend.test:8080/api/voice/internal/turn');
    expect(fetcher.mock.calls.map((call) => JSON.parse(call[1].body))).toEqual([
      { token: 'test-token', ...input }, { token: 'test-token', ...input },
    ]);
  });

  it('aborts backoff without another HTTP call', async () => {
    const fetcher = vi.fn().mockImplementation(async () => busy());
    const gateway = createVoiceWorkerHttpGateway({ baseUrl: 'http://backend.test/api', token: 'test-token', fetch: fetcher });
    const abort = new AbortController();
    const answer = gateway.turn(input, abort.signal);
    const rejection = expect(answer).rejects.toMatchObject({ name: 'AbortError' });
    await advance(100); abort.abort(); await rejection;
    await advance(1000); expect(fetcher).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('never retries cancelled or mismatched response revisions', async () => {
    for (const response of [Response.json({ assistantText: 'missing identity' }),
      Response.json({ code: 'VOICE_CANCELLED' }, { status: 409 }),
      Response.json({ assistantText: 'wrong', turnId: input.turnId, revision: 99 })]) {
      const fetcher = vi.fn().mockResolvedValue(response);
      const gateway = createVoiceWorkerHttpGateway({ baseUrl: 'http://backend.test/api', token: 'test-token', fetch: fetcher });
      await expect(gateway.turn(input, new AbortController().signal)).rejects.toBeInstanceOf(VoiceWorkerHttpError);
      expect(fetcher).toHaveBeenCalledTimes(1);
    }
  });

  it('keeps cancellation independent of the aborted turn request', async () => {
    const fetcher = vi.fn().mockResolvedValue(Response.json({ accepted: true, turnId: input.turnId, revision: input.revision }));
    const gateway = createVoiceWorkerHttpGateway({ baseUrl: 'http://backend.test/api', token: 'test-token', fetch: fetcher });
    await gateway.cancel(input);
    expect(fetcher.mock.calls[0][0]).toBe('http://backend.test/api/voice/internal/cancel');
    expect(JSON.parse(fetcher.mock.calls[0][1].body)).toEqual({ token: 'test-token', turnId: input.turnId, revision: 2 });
    expect(fetcher.mock.calls[0][1].signal.aborted).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('reports a negative cancellation acknowledgement instead of treating HTTP 200 as cancelled', async () => {
    const fetcher = vi.fn().mockResolvedValue(Response.json({ accepted: false, turnId: input.turnId, revision: input.revision }));
    const gateway = createVoiceWorkerHttpGateway({ baseUrl: 'http://backend.test/api', token: 'test-token', fetch: fetcher });
    await expect(gateway.cancel(input)).rejects.toMatchObject({ code: 'VOICE_CANCEL_UNCONFIRMED' });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('busy retries also respect the VAD/quiet permit', async () => {
    let canStart = true;
    const fetcher = vi.fn().mockResolvedValueOnce(busy()).mockResolvedValueOnce(Response.json({ assistantText: '답변', turnId: input.turnId, revision: input.revision }));
    const gateway = createVoiceWorkerHttpGateway({ baseUrl: 'http://backend.test/api', token: 'test-token', fetch: fetcher,
      canStart: () => canStart });
    const answer = gateway.turn(input, new AbortController().signal);
    await advance(100); canStart = false;
    await advance(900); expect(fetcher).toHaveBeenCalledTimes(1);
    canStart = true; await advance(500);
    expect(await answer).toBe('답변');
  });

  it('busy exhaustion hits the controller deadline and never speaks a status string', async () => {
    const fetcher = vi.fn().mockImplementation(async () => busy());
    const gateway = createVoiceWorkerHttpGateway({ baseUrl: 'http://backend.test/api', token: 'test-token', fetch: fetcher });
    const say = vi.fn();
    const c = new VoiceWorkerController({ gateway, say, quietMs: 100, deadlineMs: 1200 });
    c.onFinalTranscript('질문'); await advance(1300);
    expect(say).not.toHaveBeenCalled();
    expect(fetcher.mock.calls.filter((call) => call[0].endsWith('/turn'))).toHaveLength(3);
    expect(fetcher.mock.calls.filter((call) => call[0].endsWith('/cancel'))).toHaveLength(1);
    await advance(1000);
    expect(fetcher).toHaveBeenCalledTimes(4);
    c.close();
  });
});

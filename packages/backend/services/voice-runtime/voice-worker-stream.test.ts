import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createVoiceWorkerHttpGateway, readVoiceAnswerStream, VoiceWorkerController } from './voice-worker-controller.js';

const input = { turnId: '88e01706-654a-4bdd-8e0f-edb708156785', revision: 2, transcript: '질문' };
const event = (seq: number, fields: object) => ({ turnId: input.turnId, revision: input.revision, seq, ...fields });
const delta = (seq: number, text: string) => event(seq, { type: 'answer_delta', channel: 'final_answer', text, elapsedMs: 5 });
const done = (seq: number, assistantText: string) => event(seq, { type: 'done', assistantText, firstTextMs: 5, totalMs: 10 });
const response = (events: object[], newline = true) => new Response(events.map((e) => JSON.stringify(e)).join('\n') + (newline ? '\n' : ''),
  { headers: { 'content-type': 'application/x-ndjson' } });
async function collect(source: AsyncIterable<string>) { const result: string[] = []; for await (const text of source) result.push(text); return result; }
function parse(res: Response) { return readVoiceAnswerStream(res, input, new AbortController().signal); }

describe('NDJSON answer identity and terminal contract', () => {
  it('decodes split Korean UTF-8, several lines per chunk and an unterminated final line', async () => {
    const data = new TextEncoder().encode([delta(1, '첫 문장. '), done(2, '첫 문장. 마지막')].map(JSON.stringify).join('\n'));
    const stream = new ReadableStream<Uint8Array>({ start(c) {
      for (let i = 0; i < data.length; i += 7) c.enqueue(data.slice(i, i + 7)); c.close();
    } });
    expect(await collect(parse(new Response(stream)))).toEqual(['첫 문장. ', '마지막']);
  });
  it('does not duplicate an exact retransmitted event or terminal full prefix', async () => {
    const d = delta(1, '첫 문장. ');
    expect(await collect(parse(response([d, d, done(2, '첫 문장. ')])))).toEqual(['첫 문장. ']);
  });
  it('accepts terminal-only fallback without claiming early provider text', async () => {
    expect(await collect(parse(response([done(1, '최종 답변')], false)))).toEqual(['최종 답변']);
  });
  it.each([
    ['other-turn', [delta(1, 'a'), { ...done(2, 'a'), turnId: 'wrong' }], 'VOICE_STREAM_IDENTITY'],
    ['old-revision', [{ ...delta(1, 'a'), revision: 1 }], 'VOICE_STREAM_IDENTITY'],
    ['gap', [delta(2, 'a')], 'VOICE_STREAM_SEQUENCE'],
    ['changed-duplicate', [delta(1, 'a'), delta(1, 'b')], 'VOICE_STREAM_SEQUENCE'],
    ['reverse', [delta(1, 'a'), delta(2, 'b'), delta(1, 'a')], 'VOICE_STREAM_SEQUENCE'],
    ['commentary', [{ ...delta(1, 'a'), channel: 'commentary' }], 'VOICE_STREAM_CHANNEL'],
    ['terminal-conflict', [delta(1, 'heard'), done(2, 'different')], 'VOICE_STREAM_FINAL_CONFLICT'],
    ['missing-terminal', [delta(1, 'tail')], 'VOICE_STREAM_TERMINAL_MISSING'],
    ['server-error', [event(1, { type: 'error', code: 'VOICE_CANCELLED', status: 409 })], 'VOICE_CANCELLED'],
  ])('rejects %s', async (_name, events, code) => {
    await expect(collect(parse(response(events as object[])))).rejects.toMatchObject({ code });
  });
  it('rejects malformed JSON', async () => {
    await expect(collect(parse(new Response('{bad}\n')))).rejects.toMatchObject({ code: 'VOICE_STREAM_JSON' });
  });
  it('rejects an oversized unfinished line', async () => {
    await expect(collect(parse(new Response('x'.repeat(1_048_577))))).rejects.toMatchObject({ code: 'VOICE_STREAM_LIMIT' });
  });
  it('cancels the response reader while read is hung', async () => {
    const cancel = vi.fn();
    const abort = new AbortController();
    const iterator = readVoiceAnswerStream(new Response(new ReadableStream({ cancel })), input, abort.signal);
    const pending = iterator.next(); abort.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(cancel).toHaveBeenCalled();
  });
  it('requests NDJSON and reports request versus first eligible text separately', async () => {
    const fetcher = vi.fn().mockResolvedValue(response([done(1, '답변')]));
    const gateway = createVoiceWorkerHttpGateway({ baseUrl: 'http://backend.test/api', token: 'test-token', fetch: fetcher });
    const observer = { onRequest: vi.fn(), onFirstText: vi.fn() };
    expect(await collect(gateway.stream!(input, new AbortController().signal, observer))).toEqual(['답변']);
    expect(fetcher.mock.calls[0][1].headers.Accept).toBe('application/x-ndjson');
    expect(observer.onRequest).toHaveBeenCalledTimes(1);
    expect(observer.onFirstText).toHaveBeenCalledTimes(1);
  });
});

function fixture() {
  let feed!: ReadableStreamDefaultController<Uint8Array>;
  const stop = vi.fn();
  const stream = new ReadableStream<Uint8Array>({ start(c) { feed = c; }, cancel: stop });
  const fetcher = vi.fn(async (url: string, init: RequestInit) => {
    if (url.endsWith('/cancel')) {
      const data = JSON.parse(init.body as string);
      return Response.json({ accepted: true, turnId: data.turnId, revision: data.revision });
    }
    return new Response(stream, { headers: { 'content-type': 'application/x-ndjson' } });
  });
  const gateway = createVoiceWorkerHttpGateway({ baseUrl: 'http://backend.test/api', token: 'test-token', fetch: fetcher as typeof fetch });
  const speeches: { text: string; id: string; finish: () => void; interrupt: ReturnType<typeof vi.fn> }[] = [];
  const events: { stage: string; details: any }[] = [];
  const c = new VoiceWorkerController({ gateway, quietMs: 100, deadlineMs: 5000, makeTurnId: () => input.turnId,
    say: (text) => {
      let finish!: () => void;
      const completion = new Promise<void>((resolve) => { finish = resolve; });
      const speech = { text, id: `speech-${speeches.length}`, finish, interrupt: vi.fn() };
      speeches.push(speech);
      return { ...speech, waitForPlayout: () => completion };
    }, onEvent: (stage, details) => events.push({ stage, details }),
  });
  const send = (data: any) => feed.enqueue(new TextEncoder().encode(JSON.stringify({ ...data, revision: 1 }) + '\n'));
  return { c, speeches, events, send, stop, fetcher };
}

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(0); });
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });
const advance = (ms: number) => vi.advanceTimersByTimeAsync(ms);

describe('first meaningful sentence before terminal completion', () => {
  it('plays the first sentence early, applies playout backpressure, and records separate timings', async () => {
    const t = fixture();
    t.c.onUserState(true); await advance(10); t.c.onUserState(false);
    await advance(20); t.c.onFinalTranscript('질문'); await advance(100);
    t.send(delta(1, '첫 문장. ')); await advance(1);
    expect(t.speeches.map((s) => s.text)).toEqual(['첫 문장.']);
    expect(t.events.some((e) => e.stage === 'tower_done')).toBe(false);
    await advance(10); t.c.onPlaybackStarted(t.speeches[0].id);
    t.send(delta(2, '둘째 문장. '));
    t.send(done(3, '첫 문장. 둘째 문장. ')); await advance(10);
    expect(t.speeches).toHaveLength(1);
    t.speeches[0].finish(); await advance(1);
    expect(t.speeches.map((s) => s.text)).toEqual(['첫 문장.', '둘째 문장.']);
    t.c.onPlaybackStarted(t.speeches[1].id); t.speeches[1].finish(); await advance(1);
    expect(t.events.filter((e) => e.stage === 'first_text')).toHaveLength(1);
    expect(t.events.filter((e) => e.stage === 'first_server_audio')).toHaveLength(1);
    const end = t.events.find((e) => e.stage === 'tower_done')!.details;
    expect(end).toMatchObject({ lastUserSpeechAt: 10, finalAt: 30, committedAt: 130,
      firstRequestAt: 130, firstTextAt: 130, finalToCommitMs: 100 });
    expect(end.firstSentenceAt).toBeGreaterThanOrEqual(end.firstTextAt);
    expect(end.firstServerAudioAt).toBeGreaterThan(end.ttsQueuedAt);
    expect(end.playoutFinishedAt).toBeGreaterThan(end.firstServerAudioAt);
    await t.c.close();
  });
  it('terminal success clears transport deadline while legitimate playout remains active', async () => {
    const t = fixture();
    t.c.onFinalTranscript('질문'); await advance(100);
    t.send(delta(1, '첫 문장.')); await advance(1);
    expect(t.speeches).toHaveLength(1); // no trailing whitespace/next delta needed
    t.send(done(2, '첫 문장.')); await advance(1);
    expect(t.events.some((e) => e.stage === 'tower_response_complete')).toBe(true);
    await advance(5000);
    expect(t.events.some((e) => e.stage === 'tower_deadline')).toBe(false);
    expect(t.speeches[0].interrupt).not.toHaveBeenCalled();
    t.speeches[0].finish(); await advance(1); await t.c.close();
  });
  it('never queues while VAD speaking and cancels current plus buffered sentences on interruption', async () => {
    const t = fixture();
    t.c.onFinalTranscript('질문'); await advance(100); t.c.onUserState(true);
    t.send(delta(1, '첫 문장. 둘째 문장. ')); await advance(200);
    expect(t.speeches).toHaveLength(0);
    t.c.onUserState(false); await advance(100);
    expect(t.speeches).toHaveLength(1);
    t.c.onPlaybackStarted(t.speeches[0].id); t.c.onUserState(true);
    expect(t.speeches[0].interrupt).toHaveBeenCalledWith(true);
    t.speeches[0].finish(); await advance(100);
    expect(t.speeches).toHaveLength(1);
    expect(t.stop).toHaveBeenCalled();
    await t.c.close();
  });
  it('interrupts playing and queued speech immediately on terminal error without waiting for playout or retrying', async () => {
    for (const playing of [false, true]) {
      const t = fixture();
      t.c.onFinalTranscript('질문'); await advance(100);
      t.send(delta(1, '첫 문장. 두 번째 문장. ')); await advance(1);
      expect(t.speeches).toHaveLength(1);
      if (playing) t.c.onPlaybackStarted(t.speeches[0].id);
      t.send(event(2, { type: 'error', code: 'VOICE_STREAM_DIVERGED', status: 409 }));
      await advance(1); // speech finish() deliberately NOT called
      expect(t.speeches[0].interrupt).toHaveBeenCalledWith(true);
      expect(t.events.find((e) => e.stage === 'tower_failed')!.details.code).toBe('VOICE_STREAM_DIVERGED');
      t.speeches[0].finish(); await advance(100);
      expect(t.speeches).toHaveLength(1);
      expect(t.fetcher.mock.calls.filter((call) => call[0].endsWith('/turn'))).toHaveLength(1);
      await t.c.close();
    }
  });
  it('fails closed on buffered stream overload rather than accumulating unbounded speech', async () => {
    const t = fixture();
    t.c.onFinalTranscript('질문'); await advance(100);
    t.send(delta(1, '첫 문장. ')); await advance(1);
    t.c.onPlaybackStarted(t.speeches[0].id);
    t.send(delta(2, 'x'.repeat(65_537))); await advance(1);
    expect(t.speeches[0].interrupt).toHaveBeenCalledWith(true);
    expect(t.events.find((e) => e.stage === 'tower_failed')!.details.code).toBe('VOICE_STREAM_BACKPRESSURE_LIMIT');
    await t.c.close();
  });
  it('does not re-speak early text after a conflicting terminal response', async () => {
    const t = fixture();
    t.c.onFinalTranscript('질문'); await advance(100);
    t.send(delta(1, '첫 문장. ')); await advance(1);
    t.c.onPlaybackStarted(t.speeches[0].id);
    t.send(done(2, '다른 전체 답변')); t.speeches[0].finish(); await advance(1);
    expect(t.speeches).toHaveLength(1);
    expect(t.events.find((e) => e.stage === 'tower_failed')!.details.code).toBe('VOICE_STREAM_FINAL_CONFLICT');
    await t.c.close();
  });
});

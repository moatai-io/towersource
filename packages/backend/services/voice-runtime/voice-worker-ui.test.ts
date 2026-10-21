import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { VoiceWorkerController, createVoiceWorkerHttpGateway, type VoiceWorkerUiEvent } from './voice-worker-controller.js';

function fixture() {
  const requests: { input: any; resolve: (text: string) => void }[] = [];
  const speeches: { text: string; id: string; interrupt: ReturnType<typeof vi.fn>; finish: () => void }[] = [];
  const ui: VoiceWorkerUiEvent[] = [];
  const metrics: string[] = [];
  let turn = 0;
  const c = new VoiceWorkerController({
    gateway: {
      turn: (input) => new Promise<string>((resolve) => { requests.push({ input, resolve }); }),
      cancel: async () => {},
    },
    say: (text) => {
      let finish!: () => void;
      const completion = new Promise<void>((resolve) => { finish = resolve; });
      const speech = { text, id: `speech-${speeches.length}`, interrupt: vi.fn(), finish };
      speeches.push(speech);
      return { ...speech, waitForPlayout: () => completion };
    },
    quietMs: 100, deadlineMs: 20_000, makeTurnId: () => `turn-${++turn}`,
    onUiEvent: (event) => ui.push(event), onEvent: (stage) => metrics.push(stage),
  });
  return { c, requests, speeches, ui, metrics };
}
const advance = (ms: number) => vi.advanceTimersByTimeAsync(ms);
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(0); });
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

describe('silent waiting and explicit terminal failures', () => {
  it('never speaks a fixed waiting bridge, even during a slow response', async () => {
    const t = fixture(); t.c.onFinalTranscript('회의 준비를'); await advance(15_000);
    expect(t.speeches).toHaveLength(0);
    expect(t.ui.filter((e) => e.kind === 'waiting')).toHaveLength(0);
    t.requests[0].resolve('자료를 먼저 확인하세요.'); await advance(1);
    expect(t.speeches.map((s) => s.text)).toEqual(['자료를 먼저 확인하세요.']);
    await t.c.close();
  });
  it('deadline terminates UI exactly once and rejects a late response', async () => {
    const t = fixture(); t.c.onFinalTranscript('질문'); await advance(20_100);
    expect(t.ui.filter((e) => e.kind === 'error')).toMatchObject([
      { turnId: 'turn-1', revision: 1, code: 'VOICE_DEADLINE', final: true },
    ]);
    t.requests[0].resolve('너무 늦은 답변'); await advance(1000);
    expect(t.speeches).toHaveLength(0);
    expect(t.ui.filter((e) => e.kind === 'error')).toHaveLength(1);
    await t.c.close();
  });
  it('busy retries have an independent attempt bound and display a terminal error without speech', async () => {
    const say = vi.fn();
    const ui: VoiceWorkerUiEvent[] = [];
    const fetcher = vi.fn(async (url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string);
      return url.endsWith('/cancel') ? Response.json({ accepted: true, turnId: body.turnId, revision: body.revision })
        : Response.json({ code: 'VOICE_BUSY' }, { status: 409 });
    });
    const gateway = createVoiceWorkerHttpGateway({ baseUrl: 'http://backend.test/api', token: 'test-token', fetch: fetcher as typeof fetch });
    const c = new VoiceWorkerController({ gateway, say, quietMs: 100, onUiEvent: (e) => ui.push(e) });
    c.onFinalTranscript('질문'); await advance(30_100);
    expect(fetcher.mock.calls.filter((call) => call[0].endsWith('/turn'))).toHaveLength(10);
    expect(fetcher.mock.calls.filter((call) => call[0].endsWith('/cancel'))).toHaveLength(1);
    expect(say).not.toHaveBeenCalled();
    expect(ui.filter((e) => e.kind === 'error')).toMatchObject([{ code: 'VOICE_BUSY_EXHAUSTED', revision: 1 }]);
    await advance(90_000);
    expect(fetcher).toHaveBeenCalledTimes(11);
    expect(ui.filter((e) => e.kind === 'error')).toHaveLength(1);
    await c.close();
  });
});

describe('room UI captions and sentence lifecycle', () => {
  it('bounds UI payload only and preserves the actual transcript', async () => {
    const t = fixture(); const original = '한'.repeat(5000);
    t.c.onFinalTranscript(original); await advance(100);
    expect(t.ui[0].text?.length).toBe(2000);
    expect(new TextEncoder().encode(JSON.stringify(t.ui[0])).byteLength).toBeLessThan(16_384);
    expect(t.requests[0].input.transcript).toBe(original);
    await t.c.close();
  });
  it('publishes interims without mutating revisions or durable input, and uses monotonic room seq', async () => {
    const t = fixture();
    t.c.onInterimTranscript('회'); t.c.onInterimTranscript('회의 준비');
    expect(t.c.input.getRevision()).toBe(0);
    expect(t.c.input.hasPendingTranscript()).toBe(false);
    await advance(3000); expect(t.requests).toHaveLength(0);
    t.c.onFinalTranscript('회의 준비'); await advance(100);
    expect(t.requests[0].input.transcript).toBe('회의 준비');
    expect(t.ui.filter((e) => e.kind === 'input').map((e) => e.final)).toEqual([false, false, true]);
    t.requests[0].resolve('자료를 확인하세요.'); await advance(1);
    t.c.onPlaybackStarted(t.speeches[0].id); t.speeches[0].finish(); await advance(1);
    expect(t.ui.filter((e) => e.kind === 'sentence').map((e) => e.state)).toEqual(['queued', 'speaking', 'completed']);
    await t.c.close();
    expect(t.ui.at(-1)?.kind).toBe('reset');
    expect(t.ui.map((e) => e.seq)).toEqual(t.ui.map((_, i) => i + 1));
    const count = t.ui.length; t.c.onInterimTranscript('닫힌 뒤');
    expect(t.ui).toHaveLength(count);
  });
});

/**
 * Pi stream watchdog — runtime reproducer & contract tests.
 *
 * These tests DETERMINISTICALLY reproduce all known stuck scenarios using
 * fake clock + fake event timeline. The reproducer answers the user's
 * "어디서 멈추는지" question: which event sequence + duration triggers
 * which abort reason.
 *
 * Scenarios from real prod log session 73c1fbcf (2026-05-17):
 *   iter1 — thinking 4s, text, 2 toolcalls — ALL _end. Normal. (assert: no abort)
 *   iter2 — thinking 4min 49s with thinking_end. Long but normal. (no abort)
 *   iter3 — thinking + text + toolcall ALL _start, NO _end for 23 min. STUCK.
 *           (assert: aborts at 10min with thinking-stuck — earliest of the 3)
 *
 * Plus synthetic edge cases:
 *   - Dead stream (no events at all) — idle abort
 *   - Idle then deltas resume — no abort
 *   - Multiple consecutive normal iters across long total turn — no abort
 *   - Block reset via message_end(assistant) — fresh block timeout
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createStreamWatchdog, type WatchdogEvent, type StuckReason } from '../pi-stream-watchdog';

// ── Fake clock harness ──
// We don't use vi.useFakeTimers() because we want full control over Date.now
// AND the setInterval callback — we want each clock tick to be explicit so
// stuck reasoning is dead obvious in the trace.

function makeFakeClock() {
  let now = 1_000_000; // arbitrary start, well above 0 to catch sign bugs
  const intervals: Array<{ cb: () => void; intervalMs: number; nextAt: number; cleared: boolean }> = [];
  const fakeNow = () => now;
  const fakeSetInterval = ((cb: () => void, ms: number) => {
    const handle = { cb, intervalMs: ms, nextAt: now + ms, cleared: false };
    intervals.push(handle);
    return handle as any;
  }) as typeof setInterval;
  const fakeClearInterval = ((handle: any) => {
    if (handle) handle.cleared = true;
  }) as typeof clearInterval;
  return {
    now: fakeNow,
    setInterval: fakeSetInterval,
    clearInterval: fakeClearInterval,
    /** Advance time, firing intervals at their scheduled tick. */
    advance(ms: number) {
      const target = now + ms;
      while (true) {
        const due = intervals.filter(h => !h.cleared && h.nextAt <= target);
        if (due.length === 0) break;
        due.sort((a, b) => a.nextAt - b.nextAt);
        const next = due[0];
        now = next.nextAt;
        next.nextAt += next.intervalMs;
        next.cb();
      }
      now = target;
    },
  };
}

// ── Helpers ──
const ev = (type: string, sub?: string, role?: string): WatchdogEvent => ({
  type,
  ...(sub ? { assistantMessageEvent: { type: sub } } : {}),
  ...(role ? { message: { role } } : {}),
});

describe('Pi stream watchdog — runtime reproducer', () => {
  let clock: ReturnType<typeof makeFakeClock>;
  let abortCalls: Array<{ reason: StuckReason; elapsedMs: number; at: number }>;
  let watchdog: ReturnType<typeof createStreamWatchdog>;

  const makeWatchdog = (overrides: Partial<Parameters<typeof createStreamWatchdog>[0]> = {}) =>
    createStreamWatchdog({
      streamIdleMs: 90_000,
      blockTimeoutMs: 600_000, // 10 min
      checkIntervalMs: 1_000, // 1s tick for fast tests
      now: clock.now,
      setIntervalFn: clock.setInterval,
      clearIntervalFn: clock.clearInterval,
      onStuck: (reason, elapsedMs) => abortCalls.push({ reason, elapsedMs, at: clock.now() }),
      ...overrides,
    });

  beforeEach(() => {
    clock = makeFakeClock();
    abortCalls = [];
  });
  afterEach(() => {
    watchdog?.stop();
  });

  // ──────────────────────────────────────────────────────────────────
  // Real prod trace replay
  // ──────────────────────────────────────────────────────────────────

  it('iter1 (normal short turn — 33s, all _end fire) — no abort', () => {
    watchdog = makeWatchdog();

    // 19:42:42 message_start(assistant)
    watchdog.observe(ev('message_start', undefined, 'assistant'));
    clock.advance(8_000);
    watchdog.observe(ev('message_update', 'thinking_start'));
    // 4s of thinking_delta
    for (let i = 0; i < 40; i++) {
      clock.advance(100);
      watchdog.observe(ev('message_update', 'thinking_delta'));
    }
    watchdog.observe(ev('message_update', 'thinking_end'));
    watchdog.observe(ev('message_update', 'text_start'));
    clock.advance(18_000); // text streaming
    watchdog.observe(ev('message_update', 'toolcall_start'));
    clock.advance(3_000);
    watchdog.observe(ev('message_update', 'toolcall_end'));
    watchdog.observe(ev('message_update', 'text_end'));
    watchdog.observe(ev('message_end', undefined, 'assistant'));

    expect(abortCalls).toEqual([]);
  });

  it('iter2 (LONG normal — thinking 4min 49s with thinking_end) — no abort', () => {
    watchdog = makeWatchdog();

    watchdog.observe(ev('message_start', undefined, 'assistant'));
    clock.advance(10_000);
    watchdog.observe(ev('message_update', 'thinking_start'));

    // 4 min 49 s of thinking_delta at ~1500 deltas/min = ~120/sec actually too
    // dense; use 1 delta / 100ms to keep the test fast but still well below
    // the streamIdleMs (90s).
    const thinkingDurMs = 4 * 60_000 + 49_000;
    const tickMs = 100;
    for (let elapsed = 0; elapsed < thinkingDurMs; elapsed += tickMs) {
      clock.advance(tickMs);
      watchdog.observe(ev('message_update', 'thinking_delta'));
    }
    watchdog.observe(ev('message_update', 'thinking_end'));
    watchdog.observe(ev('message_end', undefined, 'assistant'));

    expect(abortCalls).toEqual([]);
  });

  it('iter3 (STUCK — thinking + text + toolcall all _start, NO _end, 23 min) — aborts at 10min on thinking-stuck', () => {
    watchdog = makeWatchdog();

    watchdog.observe(ev('message_start', undefined, 'assistant'));
    clock.advance(6_000);
    watchdog.observe(ev('message_update', 'thinking_start')); // T+6s
    clock.advance(4_000);
    watchdog.observe(ev('message_update', 'text_start')); // T+10s
    clock.advance(1_000);
    watchdog.observe(ev('message_update', 'toolcall_start')); // T+11s

    // Stream deltas indefinitely; none of the *_end events ever fire.
    // 1 delta every 50ms = 20/sec, alternating between thinking/text/toolcall.
    let totalAdvanced = 0;
    while (abortCalls.length === 0 && totalAdvanced < 25 * 60_000) {
      clock.advance(50);
      totalAdvanced += 50;
      const k = (totalAdvanced / 50) % 3;
      watchdog.observe(ev('message_update', k === 0 ? 'thinking_delta' : k === 1 ? 'text_delta' : 'toolcall_delta'));
    }

    expect(abortCalls.length).toBe(1);
    // thinking_start was the first to fire, so it should be the first to hit 10min cap.
    expect(abortCalls[0].reason).toBe('thinking-stuck');
    expect(abortCalls[0].elapsedMs).toBeGreaterThanOrEqual(600_000);
    expect(abortCalls[0].elapsedMs).toBeLessThan(602_000); // within one tick of 10 min
  });

  // ──────────────────────────────────────────────────────────────────
  // Synthetic edge cases
  // ──────────────────────────────────────────────────────────────────

  it('dead stream (no events at all after first) — idle abort at 90s', () => {
    watchdog = makeWatchdog();

    watchdog.observe(ev('message_start', undefined, 'assistant'));
    // No further events. Advance past idle threshold.
    clock.advance(95_000);

    expect(abortCalls.length).toBe(1);
    expect(abortCalls[0].reason).toBe('idle');
    expect(abortCalls[0].elapsedMs).toBeGreaterThanOrEqual(90_000);
  });

  it('idle then deltas resume → no abort (we recovered)', () => {
    watchdog = makeWatchdog();

    watchdog.observe(ev('message_start', undefined, 'assistant'));
    clock.advance(5_000);
    watchdog.observe(ev('message_update', 'thinking_start'));

    // Silent for 80s — below idle threshold
    clock.advance(80_000);
    expect(abortCalls).toEqual([]);

    // Deltas resume
    watchdog.observe(ev('message_update', 'thinking_delta'));
    clock.advance(80_000); // another 80s of silence resets fine because we just observed
    watchdog.observe(ev('message_update', 'thinking_delta'));

    expect(abortCalls).toEqual([]);
  });

  it('multi-iter agent loop totaling 25 min, each block under 5min — no abort', () => {
    watchdog = makeWatchdog();

    for (let iter = 0; iter < 5; iter++) {
      watchdog.observe(ev('message_start', undefined, 'assistant'));
      clock.advance(5_000);
      watchdog.observe(ev('message_update', 'thinking_start'));

      // 4 min of thinking
      for (let t = 0; t < 4 * 60_000; t += 100) {
        clock.advance(100);
        watchdog.observe(ev('message_update', 'thinking_delta'));
      }
      watchdog.observe(ev('message_update', 'thinking_end'));

      // toolcall 30s
      watchdog.observe(ev('message_update', 'toolcall_start'));
      for (let t = 0; t < 30_000; t += 100) {
        clock.advance(100);
        watchdog.observe(ev('message_update', 'toolcall_delta'));
      }
      watchdog.observe(ev('message_update', 'toolcall_end'));
      watchdog.observe(ev('message_end', undefined, 'assistant'));

      // tool exec
      watchdog.observe(ev('tool_execution_start'));
      clock.advance(2_000);
      watchdog.observe(ev('tool_execution_end'));
    }

    expect(abortCalls).toEqual([]);
  });

  it('message_end(assistant) resets all per-block trackers — second iter fresh cap', () => {
    watchdog = makeWatchdog({ blockTimeoutMs: 300_000 }); // 5 min cap for tightness

    // iter1: thinking_start, runs 4min (under cap), then end
    watchdog.observe(ev('message_start', undefined, 'assistant'));
    watchdog.observe(ev('message_update', 'thinking_start'));
    for (let t = 0; t < 4 * 60_000; t += 100) {
      clock.advance(100);
      watchdog.observe(ev('message_update', 'thinking_delta'));
    }
    watchdog.observe(ev('message_update', 'thinking_end'));
    watchdog.observe(ev('message_end', undefined, 'assistant'));

    expect(abortCalls).toEqual([]);

    // iter2: should NOT inherit iter1's thinking timer. Run another 4min.
    watchdog.observe(ev('message_start', undefined, 'assistant'));
    watchdog.observe(ev('message_update', 'thinking_start'));
    for (let t = 0; t < 4 * 60_000; t += 100) {
      clock.advance(100);
      watchdog.observe(ev('message_update', 'thinking_delta'));
    }
    watchdog.observe(ev('message_update', 'thinking_end'));

    expect(abortCalls).toEqual([]);
  });

  it('toolcall stuck but thinking is short → toolcall-stuck reason (not thinking-stuck)', () => {
    watchdog = makeWatchdog();

    watchdog.observe(ev('message_start', undefined, 'assistant'));
    watchdog.observe(ev('message_update', 'thinking_start'));
    clock.advance(2_000);
    watchdog.observe(ev('message_update', 'thinking_end'));
    watchdog.observe(ev('message_update', 'toolcall_start')); // at T+2s

    // Stream toolcall_deltas forever
    let totalAdvanced = 2_000;
    while (abortCalls.length === 0 && totalAdvanced < 15 * 60_000) {
      clock.advance(100);
      totalAdvanced += 100;
      watchdog.observe(ev('message_update', 'toolcall_delta'));
    }

    expect(abortCalls.length).toBe(1);
    expect(abortCalls[0].reason).toBe('toolcall-stuck');
  });

  it('stop() is idempotent and prevents further aborts', () => {
    watchdog = makeWatchdog();
    watchdog.observe(ev('message_start', undefined, 'assistant'));
    watchdog.observe(ev('message_update', 'thinking_start'));
    watchdog.stop();
    watchdog.stop(); // idempotent — no throw
    clock.advance(20 * 60_000); // way past block timeout
    expect(abortCalls).toEqual([]);
  });

  it('events after stop() are no-ops', () => {
    watchdog = makeWatchdog();
    watchdog.stop();
    watchdog.observe(ev('message_start', undefined, 'assistant'));
    const snap = watchdog.snapshot();
    expect(snap.stopped).toBe(true);
  });

  // ──────────────────────────────────────────────────────────────────
  // Real prod incident reproducer — session 474d2679 (2026-05-25)
  // ──────────────────────────────────────────────────────────────────
  //
  // Trace from /home/tower/.pm2/logs/tower-prod-out.log:
  //   22:52:41  user message
  //   22:52:43  message_start(assistant), thinking_start
  //   22:52:45+ thinking_delta x5
  //   22:53:14  iter6 closes cleanly: toolcall_end → message_end(assistant) →
  //             tool_execution_start → tool_execution_end → message_start(toolResult)
  //             → message_end(toolResult) → turn_end(assistant) → turn_start (iter7)
  //   22:53:14 → 23:03:16  ⚠️ 602s of total silence after turn_start
  //   23:03:16  watchdog fires: idle elapsed=602s
  //
  // Prod env: PI_STREAM_IDLE_MS=600000 (10 min), PI_BLOCK_TIMEOUT_MS=2400000 (40 min).
  // The watchdog correctly identifies *idle* (not *block-stuck*) because
  // turn_start was emitted but no thinking_start / text_start / toolcall_start
  // ever followed — so there's no open block to fire block-stuck against.
  it('incident 474d2679 (2026-05-25 prod) — 6 iters clean + iter7 silence after turn_start → idle abort at 600s', () => {
    watchdog = makeWatchdog({ streamIdleMs: 600_000, blockTimeoutMs: 2_400_000 });

    // Iters 1-6: each is short and clean (33 seconds spread across 6 iters in real log)
    for (let iter = 0; iter < 6; iter++) {
      watchdog.observe(ev('turn_start'));
      clock.advance(500);
      watchdog.observe(ev('message_start', undefined, 'assistant'));
      watchdog.observe(ev('message_update', 'thinking_start'));
      clock.advance(1000);
      watchdog.observe(ev('message_update', 'thinking_delta'));
      watchdog.observe(ev('message_update', 'thinking_end'));
      watchdog.observe(ev('message_update', 'toolcall_start'));
      clock.advance(2000);
      watchdog.observe(ev('message_update', 'toolcall_delta'));
      watchdog.observe(ev('message_update', 'toolcall_end'));
      watchdog.observe(ev('message_end', undefined, 'assistant'));
      watchdog.observe(ev('tool_execution_start'));
      clock.advance(500);
      watchdog.observe(ev('tool_execution_end'));
      watchdog.observe(ev('message_start', undefined, 'toolResult'));
      watchdog.observe(ev('message_end', undefined, 'toolResult'));
      watchdog.observe(ev('turn_end', undefined, 'assistant'));
    }
    expect(abortCalls).toEqual([]); // 6 iters healthy

    // Iter7: turn_start fires, then dead silence — model never emits
    // any next event (no message_start, no thinking_start, nothing).
    watchdog.observe(ev('turn_start'));

    // Silence advances. 599s — still under threshold.
    clock.advance(599_000);
    expect(abortCalls).toEqual([]);

    // 602s — past 600s threshold. Watchdog fires idle.
    clock.advance(3_000);

    expect(abortCalls.length).toBe(1);
    expect(abortCalls[0].reason).toBe('idle');
    expect(abortCalls[0].elapsedMs).toBeGreaterThanOrEqual(600_000);
    expect(abortCalls[0].elapsedMs).toBeLessThan(610_000);
  });

  // Companion guard: with 0.75.4's HTTP idle timeout fix expected to land,
  // the SDK itself may abort the connection before Tower's watchdog. Tower's
  // watchdog should still be the deterministic last line of defense — i.e.
  // if SDK emits no events at all (because it gave up earlier), watchdog
  // still fires within idle threshold. This guards against regression where
  // SDK changes might emit a heartbeat event that resets our timer.
  it('regression guard: SDK heartbeat-style empty event should NOT reset idle timer', () => {
    // If pi SDK introduces keep-alive events, they must not count as progress.
    // Otherwise a dead stream that emits only heartbeats could run forever.
    watchdog = makeWatchdog();
    watchdog.observe(ev('message_start', undefined, 'assistant'));
    clock.advance(80_000);

    // Heartbeat-like unknown event. It should be ignored for idle purposes.
    watchdog.observe(ev('sdk_heartbeat' as any));
    clock.advance(15_000); // 95s since message_start, not 15s since heartbeat

    expect(abortCalls.length).toBe(1);
    expect(abortCalls[0].reason).toBe('idle');
  });

  it('thinking/text/toolcall deltas DO reset idle timer as real stream progress', () => {
    watchdog = makeWatchdog();
    watchdog.observe(ev('message_start', undefined, 'assistant'));

    const deltas = ['thinking_delta', 'text_delta', 'toolcall_delta'];
    for (const delta of deltas) {
      clock.advance(80_000);
      watchdog.observe(ev('message_update', delta));
      expect(abortCalls).toEqual([]);
    }

    clock.advance(89_000);
    expect(abortCalls).toEqual([]);
    clock.advance(2_000);
    expect(abortCalls.length).toBe(1);
    expect(abortCalls[0].reason).toBe('idle');
  });
});

// ──────────────────────────────────────────────────────────────────
// Boundary / configuration sanity
// ──────────────────────────────────────────────────────────────────

describe('Pi stream watchdog — boundary', () => {
  it('streamIdleMs default 15 min', () => {
    const clock = makeFakeClock();
    const aborts: Array<{ reason: StuckReason; elapsedMs: number }> = [];
    const w = createStreamWatchdog({
      checkIntervalMs: 1_000,
      now: clock.now,
      setIntervalFn: clock.setInterval,
      clearIntervalFn: clock.clearInterval,
      onStuck: (reason, elapsedMs) => aborts.push({ reason, elapsedMs }),
    });
    w.observe(ev('message_start', undefined, 'assistant'));
    clock.advance(899_000);
    expect(aborts).toEqual([]);
    clock.advance(2_000); // 901s total
    expect(aborts).toEqual([{ reason: 'idle', elapsedMs: expect.any(Number) }]);
    w.stop();
  });

  it('blockTimeoutMs default 60 min', () => {
    const clock = makeFakeClock();
    const aborts: Array<{ reason: StuckReason; elapsedMs: number }> = [];
    const w = createStreamWatchdog({
      streamIdleMs: 99_999_999, // disable Tier A for this test
      checkIntervalMs: 1_000,
      now: clock.now,
      setIntervalFn: clock.setInterval,
      clearIntervalFn: clock.clearInterval,
      onStuck: (reason, elapsedMs) => aborts.push({ reason, elapsedMs }),
    });
    w.observe(ev('message_start', undefined, 'assistant'));
    w.observe(ev('message_update', 'thinking_start'));
    // Feed a delta every second to keep idle reset; run 3599s
    for (let t = 0; t < 3599; t++) {
      clock.advance(1_000);
      w.observe(ev('message_update', 'thinking_delta'));
    }
    expect(aborts).toEqual([]);
    clock.advance(2_000); // 3601s
    expect(aborts.length).toBe(1);
    expect(aborts[0].reason).toBe('thinking-stuck');
    w.stop();
  });
});

// ──────────────────────────────────────────────────────────────────
// tool_execution idle pause — sub-agent fork / long tool false-positive fix
// Real prod case: 2026-05-19 session b39a2258, sub-agent "결정문서 재검토"
// forked 13:13:35 → completed 13:16:57 (3min 22s). Parent watchdog had been
// idle-aborting at 90s.
// ──────────────────────────────────────────────────────────────────

describe('Pi stream watchdog — tool_execution idle pause', () => {
  let clock: ReturnType<typeof makeFakeClock>;
  let aborts: Array<{ reason: StuckReason; elapsedMs: number }>;

  beforeEach(() => {
    clock = makeFakeClock();
    aborts = [];
  });

  const makeW = (overrides: Partial<Parameters<typeof createStreamWatchdog>[0]> = {}) =>
    createStreamWatchdog({
      streamIdleMs: 90_000,
      blockTimeoutMs: 600_000,
      checkIntervalMs: 1_000,
      now: clock.now,
      setIntervalFn: clock.setInterval,
      clearIntervalFn: clock.clearInterval,
      onStuck: (reason, elapsedMs) => aborts.push({ reason, elapsedMs }),
      ...overrides,
    });

  it('sub-agent fork running 5 min on parent silence — no idle abort', () => {
    const w = makeW();
    w.observe(ev('message_start', undefined, 'assistant'));
    w.observe(ev('message_update', 'toolcall_start'));
    w.observe(ev('message_update', 'toolcall_end'));
    w.observe(ev('message_end', undefined, 'assistant'));
    w.observe(ev('tool_execution_start'));
    // 5 minutes of total parent silence — but a tool is executing
    clock.advance(5 * 60_000);
    expect(aborts).toEqual([]);
    expect(w.snapshot().toolExecutionDepth).toBe(1);
    w.observe(ev('tool_execution_end'));
    expect(w.snapshot().toolExecutionDepth).toBe(0);
    w.stop();
  });

  it('idle resumes after tool_execution_end — abort fires at idle+90s, not earlier', () => {
    const w = makeW();
    w.observe(ev('tool_execution_start'));
    clock.advance(5 * 60_000); // 5 min during tool exec — paused
    w.observe(ev('tool_execution_end'));
    expect(aborts).toEqual([]);
    // Now idle should fire 90s after the end
    clock.advance(89_000);
    expect(aborts).toEqual([]);
    clock.advance(2_000); // 91s past tool_execution_end
    expect(aborts.length).toBe(1);
    expect(aborts[0].reason).toBe('idle');
    w.stop();
  });


  it('regression: tool not running, 91s silence → still aborts (idle check active)', () => {
    const w = makeW();
    w.observe(ev('message_start', undefined, 'assistant'));
    clock.advance(91_000);
    expect(aborts).toEqual([{ reason: 'idle', elapsedMs: expect.any(Number) }]);
    w.stop();
  });

  it('nested tool_execution depth — outer pause stays until all end', () => {
    const w = makeW();
    w.observe(ev('tool_execution_start')); // depth=1
    clock.advance(60_000);
    w.observe(ev('tool_execution_start')); // depth=2 (nested)
    clock.advance(60_000);
    w.observe(ev('tool_execution_end')); // depth=1
    clock.advance(60_000); // still paused (inner finished but outer running)
    expect(aborts).toEqual([]);
    expect(w.snapshot().toolExecutionDepth).toBe(1);
    w.observe(ev('tool_execution_end')); // depth=0
    // Now idle resumes — abort fires 91s later
    clock.advance(91_000);
    expect(aborts.length).toBe(1);
    expect(aborts[0].reason).toBe('idle');
    w.stop();
  });

  it('block-level cap stays active during tool exec — toolcall-stuck still fires at 10min', () => {
    const w = makeW();
    w.observe(ev('message_start', undefined, 'assistant'));
    w.observe(ev('message_update', 'toolcall_start')); // open toolcall block
    w.observe(ev('tool_execution_start'));
    // 10 min + 1s with tool running AND toolcall block open without _end
    clock.advance(601_000);
    expect(aborts.length).toBe(1);
    expect(aborts[0].reason).toBe('toolcall-stuck');
    w.stop();
  });

  it('tool_execution_end without prior _start — depth clamps at 0 (defensive)', () => {
    const w = makeW();
    w.observe(ev('tool_execution_end')); // spurious end, no prior start
    expect(w.snapshot().toolExecutionDepth).toBe(0);
    clock.advance(91_000);
    expect(aborts.length).toBe(1); // idle still active
    expect(aborts[0].reason).toBe('idle');
    w.stop();
  });
});


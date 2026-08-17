/**
 * Pi stream watchdog — detect mid-iteration stuck where the SDK keeps receiving
 * delta events but the terminal events (*_end, message_end, finish_reason)
 * never arrive. Provider-side or SDK-side hang (issue earendil-works/pi #2381).
 *
 * Real prod case 2026-05-17 73c1fbcf (Kimi K2.6 via OpenRouter):
 *   thinking_start + text_start + toolcall_start ALL fire
 *   thinking_delta + toolcall_delta stream at 450-2330 events/min for 23 min
 *   thinking_end / text_end / toolcall_end / message_end NEVER come
 *   user had to abort manually
 *
 * Web research (rapid-web-researcher 2026-05-17):
 *   earendil-works/pi issue #2381 confirms this is multi-provider, not model-
 *   specific. Same symptom seen on Kimi K2.6, GPT-5.x, Gemini. Upstream patch
 *   proposed (assistantResponseTimeoutMs, toolExecutionTimeoutMs, EventStream
 *   resultResolved fallback) — NOT merged into v0.74.1.
 *
 * Design rationale — why block-level _end timeout (NOT wall-clock cap):
 *
 *   First attempt was Tier A (idle event silence 90s) + Tier B (wall-clock
 *   assistant turn cap 8min). User correctly objected: prod iter2 ran for
 *   4min 49s as *normal* thinking-heavy reasoning. An 8min cap would false-
 *   positive any legitimate long-reasoning turn (Kimi K2.6 + GPT-5 reasoning
 *   models can legitimately think for 10-20min on complex tasks).
 *
 *   The real signal that distinguishes "stuck" from "long but progressing"
 *   is whether the model produces *terminal events*. A 5-min thinking phase
 *   that emits thinking_end is fine; a 5-min thinking phase without
 *   thinking_end is broken. So the cap is per *block* (thinking_start →
 *   thinking_end), not per turn.
 *
 *   Iter1: thinking 4s → end, text → end, 2 toolcalls → both end. Normal.
 *   Iter2: thinking 4min 49s → end. Long but normal.
 *   Iter3: thinking_start fires, thinking_end NEVER. Same for text and
 *          toolcall. After 10min on any of the three blocks → stuck.
 *
 * Configuration:
 *   - STREAM_IDLE_MS: ANY event silence beyond this → stuck (catches dead
 *     streams). Generous default 15min. Resets on every event and pauses while
 *     tools are executing.
 *   - BLOCK_TIMEOUT_MS: a single block (thinking/text/toolcall) without its
 *     _end past this → stuck. Default 60min. Per-block start time tracked independently.
 *
 *   We deliberately do NOT use a wall-clock "assistant turn" cap. Multi-block
 *   interleaved generation makes the total turn duration legitimately variable.
 *
 *   tool_execution_start..end window — idle check PAUSED while a tool is
 *   running. PI sub-agent (fork(depth=N)) executes on its OWN stream and
 *   emits NO events on the parent during execution, often for minutes. With
 *   idle check active, parent watchdog false-positives at 90s. Real prod
 *   case 2026-05-19 b39a2258 ("자체 호스팅 서버 스킬 시스템 점검"): sub-agent
 *   "결정문서 재검토" forked at 13:13:35, completed normally at 13:16:57
 *   (3min 22s, 13184 chars), but parent's idle watchdog had already aborted
 *   at 13:15:05 (90s into the silence). The block-level caps remain active
 *   even during tool exec — if toolcall_end never arrives within 10min, that
 *   still fires as toolcall-stuck.
 *
 * Decisions:
 *   - workspace/decisions/2026-05-17-pi-stream-stuck-mid-iteration.md (v2)
 *   - workspace/decisions/2026-05-19-pi-watchdog-tool-execution-pause.md (v3 — idle pause during tool exec)
 */

/** Subset of Pi SDK event shape the watchdog cares about. */
export interface WatchdogEvent {
  type: string;
  message?: { role?: string };
  assistantMessageEvent?: { type?: string };
}

export type StuckReason =
  | 'idle'              // No event for STREAM_IDLE_MS — dead stream
  | 'thinking-stuck'    // thinking_start fired, thinking_end never (within BLOCK_TIMEOUT_MS)
  | 'text-stuck'        // text_start fired, text_end never
  | 'toolcall-stuck';   // toolcall_start fired, toolcall_end never

export interface WatchdogOptions {
  /** Anything in [60_000, ∞). Default 15 min. Reset by every event; paused during tool execution. */
  streamIdleMs?: number;
  /** Per-block cap. Default 60 min. */
  blockTimeoutMs?: number;
  /** Check interval. Default min(5_000, streamIdleMs / 4) clamped to [1000, 5000]. */
  checkIntervalMs?: number;
  /** Called when stuck is detected. Watchdog stops itself; caller must abort. */
  onStuck: (reason: StuckReason, elapsedMs: number) => void;
  /** Injection point for tests. Default `Date.now`. */
  now?: () => number;
  /** Injection point for tests. Default `setInterval`. */
  setIntervalFn?: typeof setInterval;
  /** Injection point for tests. Default `clearInterval`. */
  clearIntervalFn?: typeof clearInterval;
}

export interface Watchdog {
  /** Feed every SDK event here. Internally updates timers. */
  observe(event: WatchdogEvent): void;
  /** Stop polling. Idempotent. */
  stop(): void;
  /** Inspect current state (for diagnostics / tests). */
  snapshot(): {
    lastEventAt: number;
    thinkingStartedAt: number | null;
    textStartedAt: number | null;
    toolcallStartedAt: number | null;
    toolExecutionDepth: number;
    stopped: boolean;
  };
}

export function createStreamWatchdog(opts: WatchdogOptions): Watchdog {
  const now = opts.now ?? Date.now;
  const setIntervalImpl = opts.setIntervalFn ?? setInterval;
  const clearIntervalImpl = opts.clearIntervalFn ?? clearInterval;
  const streamIdleMs = opts.streamIdleMs ?? 15 * 60_000;
  const blockTimeoutMs = opts.blockTimeoutMs ?? 60 * 60_000;
  const checkIntervalMs = opts.checkIntervalMs
    ?? Math.min(5_000, Math.max(1_000, Math.floor(streamIdleMs / 4)));

  let lastEventAt = now();
  // Each block tracks the time of its _start. Cleared on its _end. We track
  // them independently so an interleaved generation (thinking + text +
  // toolcall all open at once) gets the correct per-block cap.
  let thinkingStartedAt: number | null = null;
  let textStartedAt: number | null = null;
  let toolcallStartedAt: number | null = null;
  // Tool execution in-flight depth. Sub-agent forks (PiAgentTool) and other
  // tools run on their own streams and emit no events on the parent during
  // execution. While depth > 0, idle check is paused — only resumes once all
  // tools have emitted tool_execution_end. Block-level caps remain active.
  let toolExecutionDepth = 0;
  let stopped = false;
  let firedStuck = false;

  const timer = setIntervalImpl(() => {
    if (stopped || firedStuck) return;
    const nowMs = now();

    // Tier A — ANY event silence (PAUSED while any tool is executing,
    // because sub-agent / external tool emits no events on parent stream).
    if (toolExecutionDepth === 0) {
      const idleMs = nowMs - lastEventAt;
      if (idleMs > streamIdleMs) {
        firedStuck = true;
        stopped = true;
        clearIntervalImpl(timer as any);
        opts.onStuck('idle', idleMs);
        return;
      }
    }

    // Per-block caps (only if that block has an open _start without _end)
    const blockChecks: Array<[number | null, StuckReason]> = [
      [thinkingStartedAt, 'thinking-stuck'],
      [textStartedAt, 'text-stuck'],
      [toolcallStartedAt, 'toolcall-stuck'],
    ];
    for (const [startedAt, reason] of blockChecks) {
      if (startedAt === null) continue;
      const elapsed = nowMs - startedAt;
      if (elapsed > blockTimeoutMs) {
        firedStuck = true;
        stopped = true;
        clearIntervalImpl(timer as any);
        opts.onStuck(reason, elapsed);
        return;
      }
    }
  }, checkIntervalMs);

  return {
    observe(event) {
      if (stopped) return;
      const eventAt = now();
      const markProgress = () => { lastEventAt = eventAt; };

      // Unknown provider/SDK keep-alive events must NOT reset the idle timer.
      // Reset only on Tower/Pi events that represent real lifecycle or content
      // progress. Otherwise a future `sdk_heartbeat` could keep a dead stream
      // alive forever.
      if (event.type === 'turn_start' || event.type === 'turn_end' || event.type === 'agent_start' || event.type === 'agent_end') {
        markProgress();
        return;
      }
      if (event.type === 'compaction_start' || event.type === 'compaction_end') {
        markProgress();
        return;
      }

      // message_start(assistant) starts NO blocks yet — blocks start with
      // their own _start subtype (thinking_start, text_start, toolcall_start).
      // We do reset all blocks on message_end(assistant) and message_start
      // for safety (new assistant turn begins fresh).
      if (event.type === 'message_start' && event.message?.role === 'assistant') {
        markProgress();
        thinkingStartedAt = null;
        textStartedAt = null;
        toolcallStartedAt = null;
        return;
      }
      if (event.type === 'message_end' && event.message?.role === 'assistant') {
        markProgress();
        thinkingStartedAt = null;
        textStartedAt = null;
        toolcallStartedAt = null;
        return;
      }
      // Block-level start / end signals come in via message_update.
      if (event.type === 'message_update') {
        const sub = event.assistantMessageEvent?.type;
        switch (sub) {
          case 'thinking_start':
            markProgress();
            thinkingStartedAt = eventAt;
            return;
          case 'thinking_delta':
            markProgress();
            return;
          case 'thinking_end':
            markProgress();
            thinkingStartedAt = null;
            return;
          case 'text_start':
            markProgress();
            textStartedAt = eventAt;
            return;
          case 'text_delta':
            markProgress();
            return;
          case 'text_end':
            markProgress();
            textStartedAt = null;
            return;
          case 'toolcall_start':
            markProgress();
            toolcallStartedAt = eventAt;
            return;
          case 'toolcall_delta':
            markProgress();
            return;
          case 'toolcall_end':
            markProgress();
            toolcallStartedAt = null;
            return;
          case 'done':
          case 'error':
            markProgress();
            return;
        }
      }

      // Tool execution boundary — controls the idle-check pause window.
      // start: enter "tool running" mode, idle check paused.
      // end:   exit mode (depth-1), reset lastEventAt so we don't immediately
      //        fire idle on the next tick if 90s+ elapsed during tool exec.
      // Block toolcall also cleared on tool_execution_end (defensive — SDK
      // may emit toolcall_end implicitly via the boundary).
      if (event.type === 'tool_execution_start') {
        markProgress();
        toolExecutionDepth++;
        return;
      }
      if (event.type === 'tool_execution_end') {
        markProgress();
        toolExecutionDepth = Math.max(0, toolExecutionDepth - 1);
        toolcallStartedAt = null;
        if (toolExecutionDepth === 0) {
          lastEventAt = eventAt;
        }
        return;
      }
      // Deliberately ignore unknown events for idle purposes.
    },
    stop() {
      if (stopped) return;
      stopped = true;
      clearIntervalImpl(timer as any);
    },
    snapshot() {
      return {
        lastEventAt,
        thinkingStartedAt,
        textStartedAt,
        toolcallStartedAt,
        toolExecutionDepth,
        stopped,
      };
    },
  };
}

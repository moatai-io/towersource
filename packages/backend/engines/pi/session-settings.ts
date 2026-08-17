// Owns Pi SDK session settings used by Tower sessions.
// Public API: createPiSettingsManager.

import { SettingsManager } from '@earendil-works/pi-coding-agent';

/**
 * Build the in-memory Pi SDK settings used for each Tower-backed Pi session.
 *
 * Keep this operational: transport, steering, compaction, and provider retry
 * settings only. Model/workflow judgment belongs in skills and prompts, not here.
 */
export function createPiSettingsManager() {
  return SettingsManager.inMemory({
    // Batch mid-turn injections: when the user sends multiple messages while
    // the agent is mid-run, deliver ALL pending ones together at the next
    // steering opportunity (vs the SDK default 'one-at-a-time' which spreads
    // them across separate opportunities). See GitHub issue #17.
    steeringMode: 'all',
    // Default to SDK 'auto' (WebSocket-first, SSE fallback). WS keeps the
    // connection alive during long Codex thinking phases and reduces idle
    // false-positives in our stream watchdog. Set PI_AGENT_TRANSPORT=sse to
    // force SSE if raw Codex `token_count.rate_limits` events must be
    // observed for debugging.
    transport: (process.env.PI_AGENT_TRANSPORT as any) || 'auto',
    // Keep a wider runway before the model's hard context edge. The SDK's
    // auto-compact check runs at prompt/agent boundaries, while Tower sessions
    // often grow inside long tool loops; a 16k reserve proved too tight for
    // Responses providers whose server-side context can be ~70k above the
    // visible request body. Override via PI_COMPACTION_RESERVE_TOKENS if a VM
    // needs a different trade-off.
    compaction: {
      enabled: true,
      reserveTokens: Number(process.env.PI_COMPACTION_RESERVE_TOKENS || 48_000),
      keepRecentTokens: Number(process.env.PI_COMPACTION_KEEP_RECENT_TOKENS || 20_000),
    },
    retry: {
      enabled: true,
      // Keep SDK-internal provider retries low. Tower's outer retry policy is
      // side-effect aware and emits observable backoff logs; hidden SDK retries
      // can amplify single-account router stream-cap pressure. Override with
      // PI_SDK_PROVIDER_MAX_RETRIES on VMs that need more Azure 429 resilience.
      maxRetries: Number(process.env.PI_SDK_PROVIDER_MAX_RETRIES || 2),
      // provider.timeoutMs — forwarded by SDK 0.74 to OpenAI Node client's
      // request-level `timeout`. This guards the CONNECT phase: hangs before
      // the response headers arrive (DNS, TCP, TLS, slow first byte). Once
      // body stream starts the OpenAI client clears its timer, so this does
      // NOT catch mid-stream hangs (chunks-arriving-but-never-finishing) —
      // the inline subscribe-watchdog in run() covers that.
      // 4 min is a balance between catching real connect hangs and allowing
      // reasoning models a generous head-of-line wait under throttling.
      // Decision: workspace/decisions/2026-05-17-pi-stream-stuck-mid-iteration.md
      provider: { timeoutMs: 240_000 },
    },
  });
}

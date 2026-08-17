// Owns Tower-side state shape for a live Pi SDK session.
// Public API: PiSessionEntry.

import type { createAgentSession } from '@earendil-works/pi-coding-agent';
import type { HarnessRuntimeFingerprint, ResolvedHarness } from '../../services/harness/harness-types.js';
import type { PiRunPhase } from '../pi-run-lifecycle.js';

type AgentSession = Awaited<ReturnType<typeof createAgentSession>>['session'];

export interface PiSessionEntry {
  session: AgentSession;
  isRunning: boolean;
  /** Immutable Harness contract used to assemble this in-memory SDK Session. */
  harness?: ResolvedHarness;
  /**
   * Authentication/project identity captured when the SDK Session and its
   * closure-bound tools were assembled. A later turn must rebuild the cached
   * Session when this identity changes, otherwise tools can keep authorizing as
   * the previous user after session ownership or login context changes.
   */
  toolContext?: {
    userId?: number;
    userRole?: string;
    projectId?: string;
  };
  /** Secret-free fingerprint of the effective tool surface assembled for this Session. */
  harnessFingerprint?: HarnessRuntimeFingerprint;
  /**
   * Explicit Tower-side lifecycle for the current Pi run.
   *
   * Pi SDK/provider streams are treated as imperfect raw signals: once a fatal
   * terminal signal is observed, Tower moves to `closing` and stops accepting
   * mid-turn steers even if the SDK's prompt() promise has not settled yet.
   * This prevents zombie-running sessions from swallowing user messages as
   * never-consumed steers. See GitHub issue #55.
   */
  runPhase?: PiRunPhase;
  abortRequested?: boolean;
  /** User asked to stop at the next safe boundary instead of killing the active tool. */
  safeStopRequested?: boolean;
  activePrompt?: Promise<void> | null;
  _abortResolve?: (() => void) | null;
  /** Set by createSession when resume fails — run() yields engine_error(recoverable) */
  resumeFailedMessage?: string | null;
  /**
   * Tower in-process MCP servers (sandbox, tower-spawn) mounted via the
   * Pi-MCP adapter. Held so dispose() / shutdown() can close them and free
   * their inner McpServer transports. Empty when no MCP server mounted.
   */
  mcpServers?: Record<string, any>;
  /**
   * Pending mid-turn steer messages (FIFO), each tagged with the Tower message
   * id of its user bubble. Pushed by steer(), drained by the `queue_update`
   * handler when the agent consumes a steer. Lets us emit `steer_delivered`
   * with the right msgId so the frontend flips "전달 중" → "반영됨".
   */
  pendingSteers?: Array<{ text: string; msgId: string; username?: string | null }>;
  /**
   * True while Tower is deliberately reshaping the SDK steering queue (e.g.
   * cancelling one steer by clearing/re-queueing the remaining items). During
   * this window queue_update snapshots must not be interpreted as "consumed".
   */
  suppressSteerDelivery?: boolean;
  /**
   * Last steering-queue snapshot seen from the SDK's `queue_update` event.
   * A text present here but absent in the next update = consumed by the agent.
   */
  lastSteering?: string[];
  /**
   * Rough non-conversation prompt overhead (Tower prompt + memory + enabled tool
   * schemas). Provider usage often hides this, but users expect CTX to include it.
   */
  promptStaticTokenEstimate?: number;
  /**
   * True once the SDK's prompt() for the current turn has begun and can accept
   * steers. Between turn-claim and this flag, mid-turn injections are buffered
   * (startupSteerBuffer) rather than sent to the SDK. See GitHub issue #17.
   */
  promptActive?: boolean;
}

import type { VoiceEngineTimingSignal } from '../services/voice-runtime/voice-turn-telemetry.js';
/**
 * Engine abstraction layer — Tower's multi-engine agent system.
 *
 * Each engine (Claude, Pi, future engines) implements the Engine interface
 * and converts its native events to TowerMessage format.
 *
 * Design principle: ws-handler.ts and the frontend never import engine-specific code.
 * Removing an engine = deleting its file + 1 line in index.ts.
 */

// ═══════════════════════════════════════════════════════════════════
// TowerContentBlock — engine-independent content representation
// ═══════════════════════════════════════════════════════════════════

export type TowerContentBlock =
  | { type: 'text'; text: string }
  // Assistant-authored Markdown artifact. The same `text` body is rendered in
  // chat and materialized to `path` by message-store, avoiding duplicate model
  // output for “chat body + saved .md” deliverables.
  | { type: 'artifact_markdown'; path: string; title?: string; text: string; portablePath?: string; sha256?: string; status?: 'saved' | 'pending' | 'skipped' | 'error'; error?: string }
  // Provider commentary / preamble channel. User-visible commentary is
  // assistant-origin prose with `phase=commentary`; hidden commentary remains a
  // private scratchpad signal and is stripped before persistence.
  | { type: 'commentary'; text?: string; phase?: 'commentary'; visibility?: 'hidden' | 'progress' }
  | { type: 'thinking'; text: string; title?: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, any> };

// ═══════════════════════════════════════════════════════════════════
// TowerMessage — what engines yield, ws-handler broadcasts, frontend handles
// ═══════════════════════════════════════════════════════════════════

/** Streamed assistant message update (cumulative content) */
export interface TowerAssistantMsg {
  type: 'assistant';
  sessionId: string;
  msgId: string;
  content: TowerContentBlock[];
  /** Latest server-side emission time for this streamed assistant content. */
  timestamp?: number;
  parentToolUseId?: string | null;
  /** Optional UI/persistence metadata copied from invocation/runtime context. */
  metadata?: Record<string, any> | null;
}

/** Tool execution result (user message from SDK) */
export interface TowerToolResultMsg {
  type: 'tool_result';
  sessionId: string;
  msgId: string;
  toolCallId: string;
  toolName: string;
  result: string;
  isError?: boolean;
  parentToolUseId?: string | null;
}

/** Runtime turn status — non-terminal UX hint (e.g. tool is running while stream is quiet). */
export interface TowerTurnStatusMsg {
  type: 'turn_status';
  sessionId: string;
  phase: 'running' | 'tool_running' | 'stalled' | 'closing';
  timestamp?: number;
  activeToolName?: string;
  activeToolUseId?: string;
}

/** Turn complete — usage, cost, timing */
export interface TowerTurnDoneMsg {
  type: 'turn_done';
  sessionId: string;
  /** Last assistant message id for this turn. */
  msgId: string;
  /** All assistant message ids produced during this turn (multi-iteration/tool-use turns). */
  assistantMsgIds?: string[];
  /** Server-side turn completion time. */
  timestamp?: number;
  usage: TowerUsage;
}

/** Engine finished processing (all turns done) */
export interface TowerDoneMsg {
  type: 'engine_done';
  sessionId: string;
  engineSessionId?: string;
  editedFiles?: string[];
  model?: string;
  /** Durable turn result. Recovery callers must not infer success from engine_done alone. */
  outcome?: 'completed' | 'retryable_failure' | 'failed' | 'claim_denied';
  /** Durable assistant row that owns a completed Pi root-turn result. */
  assistantMessageId?: string;
  /** Normalized terminal failure detail for retry/state decisions. */
  error?: string;
}

export interface TowerTurnTerminalMsg {
  type: 'turn_terminal';
  sessionId: string;
  rootTurnId: string;
  outcome: 'completed' | 'stopped' | 'failed' | 'waiting_retry' | 'needs_attention' | 'claim_denied';
  reason: string;
  terminalAt: string;
  assistantMessageId?: string;
  error?: string;
}

/** Error from engine */
export interface TowerErrorMsg {
  type: 'engine_error';
  sessionId: string;
  message: string;
  recoverable?: boolean;
  /** True when the same user prompt can be safely retried (transient transport/SSE failure). */
  retryable?: boolean;
}

/** Autocompact lifecycle events — forwarded to frontend for UI feedback */
export interface TowerCompactMsg {
  type: 'compact';
  sessionId: string;
  /** 'boundary' = about to start, 'compacting' = in progress, 'done' = compacted, 'skipped' = nothing needed compacting, 'failed' = failed/aborted */
  phase: 'boundary' | 'compacting' | 'done' | 'skipped' | 'failed';
  /** Stable UI/DB divider id for a completed compact event. Prevents live marker + DB marker duplicates. */
  markerId?: string;
}

/**
 * Mid-turn steer was actually consumed by the agent loop.
 *
 * `steer()` only QUEUES a message into the engine's steering buffer — the agent
 * doesn't read it until it reaches a steering point in the current turn. This
 * event fires at that *recognition* moment so the frontend can flip the user
 * bubble from "전달 중 (steering)" to "반영됨 (steered)". Without it the webapp
 * shows the steer message at input time but can never indicate when the AI
 * actually picked it up (the terminal CLI shows this distinction natively).
 * See: GitHub issue #15, decision 2026-05-10-mid-turn-event-c-pattern-...
 */
export interface TowerSteerDeliveredMsg {
  type: 'steer_delivered';
  sessionId: string;
  /** Tower message id of the injected user message (assigned by ws-handler). */
  msgId: string;
  /** The injected message text — carried so every client can insert the bubble
   *  at the injection point (the moment of delivery), not at input time. */
  text: string;
  /** Display name of the sender, for the inserted bubble. */
  username?: string | null;
  /** Assistant row being streamed when the steer was consumed. */
  assistantMsgId?: string;
  /** Cumulative assistant content visible at the consumption boundary. */
  assistantContent?: TowerContentBlock[];
}

/** Per-provider-request context measurement; never increments turn/cost counters. */
export interface TowerContextUsageMsg {
  type: 'context_usage';
  measuredAt: number;
  sessionId: string;
  msgId: string;
  contextInputTokens: number;
  contextOutputTokens: number;
  contextWindowSize: number;
  compactThresholdTokens?: number;
  contextSnapshot?: MessageMetrics['contextSnapshot'];
}

export type TowerMessage =
  | TowerContextUsageMsg
  | TowerAssistantMsg
  | TowerToolResultMsg
  | TowerTurnStatusMsg
  | TowerTurnDoneMsg
  | TowerDoneMsg
  | TowerTurnTerminalMsg
  | TowerErrorMsg
  | TowerCompactMsg
  | TowerSteerDeliveredMsg;

// Note: ask_user is handled via EngineCallbacks, not yielded as TowerMessage.
// ws-handler owns pending question state for reconnection/session-switch.

/**
 * TowerUsage — turn-level metrics emitted by all engines.
 *
 * Engine Contract:
 * ┌─────────────────────────┬──────────────┬──────────────┐
 * │ Field                   │ Claude       │ Pi           │
 * ├─────────────────────────┼──────────────┼──────────────┤
 * │ inputTokens (REQUIRED)  │ cumulative   │ cumulative   │
 * │ outputTokens (REQUIRED) │ cumulative   │ cumulative   │
 * │ durationMs (REQUIRED)   │ from SDK     │ wall-clock   │
 * │ costUsd                 │ undefined ¹  │ Tower price-table estimate │
 * │ contextInputTokens      │ last iter    │ last iter    │
 * │ contextWindowSize       │ from SDK     │ from model   │
 * │ numIterations           │ from SDK     │ counted      │
 * │ cacheReadTokens         │ from SDK     │ from SDK ²   │
 * │ cacheCreationTokens     │ from SDK     │ from SDK ³   │
 * └─────────────────────────┴──────────────┴──────────────┘
 * ¹ Claude Max is subscription-based, so costUsd is always undefined.
 * ² Pi SDK normalizes provider cache reads into usage.cacheRead. Captured
 *   2026-05-18 — Azure/Codex automatic cache, OpenRouter Kimi Moonshot AI
 *   automatic cache. Persisted to messages.metadata.usage.cache_read_tokens.
 * ³ Pi providers (OpenAI-style cache) have write cost 0 → usually 0. Captured
 *   for parity / future provider compatibility.
 */
export interface TowerUsage {
  // ── REQUIRED: all engines must provide ──
  inputTokens: number;        // cumulative across all iterations in this turn
  outputTokens: number;       // cumulative across all iterations in this turn
  durationMs: number;         // total wall-clock time for this turn

  // ── RECOMMENDED: all engines should provide when available ──
  stopReason?: 'stop' | 'length' | 'toolUse' | 'error' | 'aborted';
  costUsd?: number;           // Pi: Tower price-table estimate across calls; Claude: undefined (subscription)
  contextInputTokens?: number;   // provider-reported actual input-side context (input + cache reads/writes when available)
  contextOutputTokens?: number;  // last iteration output
  contextWindowSize?: number;    // model's context window (e.g. 200000)
  contextEstimatedTokens?: number;
  contextCompacted?: boolean; // internal risk estimate; not user-facing CTX
  nextRequestEstimatedTokens?: number; // outgoing request/body estimate for preflight diagnostics
  compactThresholdTokens?: number; // operational compaction threshold
  contextSnapshot?: MessageMetrics['contextSnapshot'];
  numIterations?: number;        // how many LLM API calls in this turn

  // ── OPTIONAL: engine-specific cache breakdown ──
  // Both engines now emit these. Claude (Anthropic explicit cache_control) +
  // Pi (provider-normalized usage.cacheRead/cacheWrite via Pi SDK).
  cacheReadTokens?: number;      // prompt cache reads (cumulative for the turn)
  cacheCreationTokens?: number;  // prompt cache writes (Pi: usually 0 — OpenAI-style cache)
  reasoningTokens?: number;      // provider-reported hidden reasoning tokens, when available
}

// ═══════════════════════════════════════════════════════════════════
// Engine interface
// ═══════════════════════════════════════════════════════════════════

export type EffortLevel = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export interface RunOpts {
  /** Private secretary uses native session continuity without granting tools. */
  secretaryConversation?: boolean;
  secretarySourceRead?: (source: { projectId: string; sessionId: string }) => void;
  /** Server-only initialization turn: no tools or external lookups. */
  initialInterview?: boolean;
  cwd: string;
  model?: string;
  effort?: EffortLevel;
  /** Logical workload policy selected before provider/model resolution. */
  modelPolicyId?: string;
  modelPolicyRevision?: number;
  /** Product-level effort before provider/SDK compatibility mapping. */
  requestedEffort?: EffortLevel;
  /** True when the runtime lowered a product effort to the provider-supported maximum. */
  effortDowngraded?: boolean;
  userId?: number;
  username?: string;
  userRole?: string;
  allowedPath?: string;
  /**
   * Project-based accessible paths for this user.
   * All project folders the user is a member of + public areas.
   * null = unrestricted (admin). undefined = not computed yet (legacy).
   * Computed by ws-handler/task-runner BEFORE calling engine.run().
   * Each engine uses this in its own way (canUseTool, tool wrapper, etc).
   */
  accessiblePaths?: string[] | null;
  /** Paths readable but not writable in this run (e.g. channel audience-safe resources). */
  readOnlyPaths?: string[];
  /** Disable Bash when cwd would otherwise become an implicit authority root. */
  denyImplicitBash?: boolean;
  /** Restrict shared-channel execution to audience-scoped tools. */
  channelSafeToolsOnly?: boolean;
  /** Optional explicit cross-project scaffold maintenance grant for this run. */
  maintenanceGrant?: {
    id: string;
    mode: 'dry_run' | 'apply';
    projectRoots: string[];
    allowedPaths: string[];
  } | null;
  engineSessionId?: string;   // for resume (read from DB by ws-handler)
  /** Optional provider-cache identity override for synthetic sessions such as channel AI. */
  logicalSessionId?: string;
  projectId?: string;         // for credential rotation (resolves to CLAUDE_CONFIG_DIR)
  /** Pi MCP gateway opt-outs for this run; persisted session selection is rechecked dynamically. */
  mcpExcludedServerNames?: string[];
  /** Explicit published Harness selection. Omitted means the compatibility tower-default Harness. */
  harnessId?: string;
  /** Exact immutable Harness and Runtime Profile tuple for privileged synthetic eval runs. */
  harnessVersion?: number;
  runtimeProfileId?: string;
  runtimeProfileVersion?: number;
  /** Deterministic tool-result fixtures for privileged synthetic eval runs only. */
  harnessEvalToolFixtures?: Partial<Record<'web.fetch' | 'web.search', string>>;
  /** Server-owned identity prompt for a separate deployed Service Agent. Disables Project Primary Agent identity lookup. */
  serviceIdentityPrompt?: string;
  /** Immutable Deployment Knowledge projected as snapshot-only tools; never interpreted as a filesystem path. */
  serviceKnowledgeSnapshot?: unknown;
  /** Host project root for mapping Runtime Box /workspace paths in harness tools. */
  sessionProjectRoot?: string;
  /** Optional large system prompt fragments selected by the caller for this turn. */
  systemPromptFragments?: import('../services/system-prompt-fragments.js').SystemPromptFragmentKey[];
  /** User message id that owns the original turn and all automatic continuations/recovery. */
  rootTurnId?: string;
  /** Backend-owned wall-clock boundary for user-visible total turn duration. */
  acceptedAt?: string;
  /** True when the run was started by server-side restart recovery, not a fresh user turn. */
  autoResume?: boolean;
  /** Short reason/source for automatic resume telemetry. */
  autoResumeReason?: 'server-restart' | 'manual-recovery' | string;
}

export interface EngineCallbacks {
  /** Server-only, allowlisted value-free voice latency milestones. */
  onVoiceTiming?(event: VoiceEngineTimingSignal): void;
  /** Optional server-only voice consumer. Only provider-confirmed final_answer text is eligible.
   * Cumulative snapshot for one assistant message; unknown-phase UI prose is never sufficient.
   */
  onVoiceAnswerSnapshot?(event: { rootTurnId: string; sessionId: string; messageId: string; text: string; channel: 'final_answer' }): void;
  /**
   * Pause execution to ask the user a question.
   * ws-handler manages the WS broadcasting and pending question state.
   * Returns the raw answer string from the user.
   *
   * @param questionId - unique ID for this question
   * @param questions - raw question data (engine-specific format, ws-handler forwards as-is)
   */
  askUser(questionId: string, questions: any[]): Promise<string>;

  /** Persist engine-specific session ID for resume */
  claimSessionId(engineSessionId: string): void | Promise<void>;

  /** Initial interview persistence verdict after all streaming writes settle. */
  initialArtifactOutcome?(): Promise<{savedMessageId?:string;reason?:string}>;
  /** Save a message to DB */
  saveMessage(msg: SavedMessage): void | Promise<void>;

  /** Update message content (streaming updates) */
  updateMessageContent(msgId: string, content: any[]): void | Promise<void>;

  /** Attach tool result to an existing tool_use message in DB */
  attachToolResult(toolUseId: string, result: string): void | Promise<void>;

  /** Update message metrics after turn completes */
  updateMessageMetrics(msgId: string, metrics: MessageMetrics): void | Promise<void>;

  /**
   * Persist private, structural run trace signals outside messages.content.
   * Must not contain raw chain-of-thought, raw commentary text, secrets, or
   * payloads intended for default search/share/transcript/model rehydration.
   */
  recordTraceEvent?(event: {
    eventType: import('../services/ai-run-trace-events.js').AiRunTraceEventType;
    messageId?: string | null;
    payload?: Record<string, unknown> | null;
    visibility?: 'private' | 'operator';
  }): void | Promise<void>;

  /**
   * Mark a message as having triggered SDK autoCompact (the SDK emitted
   * `{type:'system', subtype:'compact_boundary'}` during this assistant turn).
   * Persists to `metadata.compact_boundary_at` (ISO timestamp) so usage
   * reports can SELECT count(*) WHERE metadata ? 'compact_boundary_at'.
   *
   * Background: SDK Options.settings.autoCompactWindow=500_000 triggers
   * server-side compaction at threshold. Before this callback existed the
   * boundary was only forwarded to the WS client; nothing landed in DB so
   * "did 500K cap ever fire?" was unanswerable. See:
   * workspace/decisions/2026-05-14-sdk-credit-economy.md (autoCompact section).
   */
  markCompactBoundary?(
    msgId: string,
    meta: { preservedSegment?: boolean }
  ): void | Promise<void>;
}

export interface SavedMessage {
  id: string;
  role: 'user' | 'assistant';
  content: any[];
  parentToolUseId?: string | null;
  /** Optional persistence/UI metadata merged by ws-handler or engines. */
  metadata?: Record<string, any> | null;
}

export interface MessageMetrics {
  durationMs?: number;
  /** Only the terminal root-turn update may finalize messages.completed_at. */
  finalizeCompletedAt?: boolean;
  inputTokens?: number;
  outputTokens?: number;
  /**
   * Prompt cache breakdown — persisted to messages.metadata.usage for accurate
   * cost / hit-ratio analysis. See decisions:
   *   - 2026-05-14-sdk-credit-economy.md (Claude side)
   *   - 2026-05-18-pi-cache-instrumentation.md (Pi side — Azure/Codex/Kimi)
   */
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
  /** Provider-reported hidden reasoning tokens, when available. */
  reasoningTokens?: number;
  /**
   * 1h vs 5m TTL breakdown of cache_creation (SDK 0.2.112+).
   * SDK provides usage.cache_creation.{ephemeral_1h_input_tokens, ephemeral_5m_input_tokens}
   * separately. Needed to validate ENABLE_PROMPT_CACHING_1H=1 ROI (1h write 1.6x
   * pricier than 5m, but 12x less frequent expiry).
   */
  cacheCreation1hTokens?: number;
  cacheCreation5mTokens?: number;
  /**
   * Provider-reported cost for this assistant message / iteration.
   * Pi SDK returns this as usage.cost.total; persisted to
   * messages.metadata.usage.cost_usd so token reports can reconcile to spend.
   */
  costUsd?: number;
  /** Provider-reported actual input-side context for the user-facing CTX footer. */
  contextInputTokens?: number;
  /** Model context window used to interpret contextInputTokens. */
  contextWindowSize?: number;
  /** Internal conservative context/risk estimate; not the user-facing actual CTX. */
  contextEstimatedTokens?: number;
  contextCompacted?: boolean;
  /** Outgoing request/body estimate used for preflight diagnostics. */
  nextRequestEstimatedTokens?: number;
  /** Operational threshold at which Tower/Pi should compact. */
  compactThresholdTokens?: number;
  /**
   * Context evidence contract. Input measurement stays independent of pressure.
   * Optional pressure drives only the explicitly labelled Tower pressure display.
   */
  contextSnapshot?: {
    actualTokens?: number;
    requestTokens?: number;
    estimatedTokens?: number;
    windowTokens: number;
    actualSource: 'provider' | 'cache-reconstructed' | 'none';
    requestSource: 'sanitized-request' | 'none';
    capturedAt: string;
    terminal: boolean;
    pressure?: { tokens: number; thresholdTokens: number; policy: 'tower-pre-prompt'; source: 'projection' | 'usage-or-transcript'; observedAt: number };
  };
}

/**
 * QuickReply options — lightweight single-turn response (no session/task).
 * Used by @ai in chat rooms.
 */
export interface QuickReplyOpts {
  model?: string;
  /** Bounded tool-free background jobs may cancel provider work and cap output. */
  signal?: AbortSignal;
  maxOutputTokens?: number;
  systemPrompt: string;
  /** Stable logical session id for provider cache affinity; must not contain raw titles/emails. */
  logicalSessionId?: string;
  /** Callback for each text chunk (for streaming to room) */
  onChunk: (chunk: string, fullContent: string) => void;
}

/**
 * ChannelReply options — persistent session reply for channel AI.
 * Uses resumeSessionId for context continuity across @ai calls.
 *
 * Permission fields (userId/userRole/allowedPath/accessiblePaths) — when
 * provided, channelReply() builds a buildToolGuard() and gates tool calls
 * the same way Engine.run() does. Without them, the path falls back to
 * the legacy "no guard" behavior (kept for back-compat / non-authenticated
 * synthetic callers). Production callers via ws-handler always pass them.
 */
export interface ChannelReplyOpts {
  model?: string;
  systemPrompt: string;
  /** Stable Tower channel-session id for provider cache affinity. */
  roomSessionId?: string;
  resumeSessionId?: string;  // for persistent channel AI
  projectId?: string;        // Harness binding / immutable snapshot pinning scope
  cwd?: string;              // project root path (enables SDK to load AGENTS.md; legacy CLAUDE.md may exist)
  /**
   * Pinned CLAUDE_CONFIG_DIR for this channel session (PR-3, 2026-05-09).
   * Forwarded to executeQuery + backupSessionFile so the SDK spawn and jsonl
   * backup land in the correct account directory (e.g. ~/.claude-gmail/ for
   * gmail-account projects). null = caller has no pinned dir, fall back to
   * the default account at runtime. Required so callers can't silently skip.
   * See: workspace/decisions/2026-05-09-multi-account-configdir-audit.md
   */
  configDir: string | null;
  onChunk: (chunk: string, fullContent: string) => void;
  onToolUse?: (toolName: string, input?: Record<string, unknown>) => void;  // status + provenance
  onCompact?: (phase: 'boundary' | 'compacting' | 'done' | 'skipped' | 'failed') => void;
  maxTurns?: number;
  // ── Permission inputs (Tier 1 → buildToolGuard) ────────────────────
  userId?: number;           // for TOWER_API_TOKEN env injection (pm-capture)
  username?: string;
  userRole?: string;         // 'admin' | 'operator' | 'member' | 'viewer'
  allowedPath?: string;      // legacy per-user path enforcement
  accessiblePaths?: string[] | null;  // channel-safe project ACL; [] = no filesystem scope
  readOnlyPaths?: string[];           // linked resources whose channel capability/audience is read-only
  denyImplicitBash?: boolean;         // shared channel runs require path-explicit scoped tools
  channelSafeToolsOnly?: boolean;     // deny credentials/connectors/publish/non-scoped tools
  authorityFingerprint?: string;      // audience/resource ACL snapshot for publication validation
  sessionProjectRoot?: string;  // for sessionWriteGuard (defaults to cwd if omitted)
}

export interface ChannelReplyResult {
  content: string;
  engineSessionId?: string;  // save for next resume
  provenance: {
    authorityFingerprint: string;
    tools: Array<{ name: string; input?: Record<string, unknown> }>;
  };
}

export interface Engine {
  /** Execute a prompt. Yields TowerMessages for ws-handler to broadcast. */
  run(
    sessionId: string,
    prompt: string,
    opts: RunOpts,
    callbacks: EngineCallbacks,
  ): AsyncGenerator<TowerMessage>;

  /**
   * Lightweight single-turn text response. No session, no tools.
   * Used by @ai quick reply in chat rooms.
   * Returns the full response text.
   */
  quickReply(prompt: string, opts: QuickReplyOpts): Promise<string>;

  /**
   * Persistent channel reply — resumes from previous session for context continuity.
   * Falls back to quickReply() if engine doesn't support persistent sessions.
   * Used by @ai in chat rooms with persistent channel AI.
   */
  channelReply?(prompt: string, opts: ChannelReplyOpts): Promise<ChannelReplyResult>;

  /**
   * Optional mid-turn steering. Engines that support it can accept a user
   * message while a turn is already running and deliver it before the current
   * agent loop fully finishes. Pi SDK supports this via AgentSession.steer().
   *
   * `messageId` is the Tower message id of the injected user bubble. Engines that
   * can detect when the injection is actually consumed mid-turn should yield a
   * `TowerSteerDeliveredMsg` carrying this id (plus text/username) so the
   * frontend can insert the bubble at the injection point. Engines that can't
   * detect consumption may ignore these.
   */
  steer?(sessionId: string, message: string, messageId?: string, username?: string | null): Promise<void>;

  /**
   * Optional cancellation for a queued mid-turn steer that has not yet been
   * consumed by the agent. Returns false when the message was already consumed
   * or the engine cannot identify it anymore.
   */
  cancelSteer?(sessionId: string, messageId: string): Promise<{ ok: boolean; text?: string; reason?: string }>;

  /**
   * Ask a running turn to stop at its next engine-defined safe boundary.
   * Unlike abort(), this must not interrupt an active tool call.
   */
  requestStopAtBoundary?(sessionId: string): Promise<{ accepted: boolean; waitingFor?: 'active_tool' | 'engine_boundary'; reason?: string }>;

  /** Manually compact the current session context when supported. */
  compact?(sessionId: string, opts: RunOpts, callbacks: EngineCallbacks, prompt?: string): AsyncGenerator<TowerMessage>;

  /** Abort a running session */
  abort(sessionId: string): void;

  /** Clean up session resources (on session delete) */
  dispose(sessionId: string): void;

  /** Check if session is currently running */
  isRunning(sessionId: string): boolean;

  /** Count of active (running) sessions */
  getActiveCount(): number;

  /** IDs of all currently running sessions (for reconnection state) */
  getRunningSessionIds(): string[];

  /** Server startup initialization (e.g. orphan cleanup) */
  init?(): void;

  /** Server shutdown cleanup */
  shutdown?(): void;

  /**
   * Build this engine's native session state from a chronological message
   * sequence (the source of truth: Tower's `messages` table).
   *
   * Used by Hard Switch — see workspace/decisions/2026-05-19-engine-hard-switch-design.md.
   * The Tower session keeps its ID; only the engine answering the *next* turn
   * changes. The new engine has no native state until this method writes one.
   *
   * Lossy by design:
   *   - thinking / reasoning_content / cache_control are dropped (already
   *     stripped at DB write time via compactContent)
   *   - tool_use IDs from the previous engine are preserved verbatim; the new
   *     engine treats them as opaque strings (consistency within the sequence
   *     is what matters, not cross-engine semantics)
   *
   * Engines that cannot ingest external state (e.g. ClaudeEngine in Phase 1)
   * leave this method undefined. Callers MUST check for presence before use
   * and reject the switch with a "not supported" error if absent.
   *
   * @param sessionId  — Tower session id (for logging / context only; the
   *                     returned engineSessionId is independent)
   * @param messages   — TowerMessage[] in chronological order. Caller is
   *                     responsible for filtering out hidden/system markers
   *                     that shouldn't reach the LLM.
   * @param cwd        — working directory for the new native session
   * @returns engineSessionId to persist on the sessions row (e.g. file path
   *          for Pi, SDK session id for Claude). Pass this to the next
   *          `run()` call via `opts.engineSessionId`.
   */
  rehydrateFromMessages?(
    sessionId: string,
    messages: ReadonlyArray<RehydrateInputMessage>,
    cwd: string,
  ): Promise<string>;
}

/**
 * Input shape for `Engine.rehydrateFromMessages` — the engine-agnostic
 * representation of a stored DB message ready to feed into a native session.
 *
 * `content` is Claude-style content blocks (the in-DB canonical format).
 * Engines that speak a different vocabulary (Pi: OpenAI-style with `toolCall`
 * / `toolResult`) convert internally.
 */
export interface RehydrateInputMessage {
  id: string;
  role: 'user' | 'assistant';
  /** Claude-style content blocks as stored in `messages.content` (JSON-parsed) */
  content: Array<{
    type: string;
    [k: string]: any;
  }>;
  /** Original timestamp (ms since epoch) — engines that timestamp entries use this. */
  timestamp?: number;
}

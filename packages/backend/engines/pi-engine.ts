/**
 * Pi coding agent engine — wraps @earendil-works/pi-coding-agent SDK.
 *
 * Uses OpenRouter (or any Pi-supported provider) for LLM calls.
 * Converts Pi's delta-based streaming events to cumulative TowerMessage format.
 *
 * To remove: delete this file + remove 'pi' case from engines/index.ts.
 */

import crypto from 'crypto';
import path from 'path';
import { config, loadModelsFile } from '../config.js';
import type { Engine, RunOpts, EngineCallbacks, TowerMessage, TowerContentBlock, QuickReplyOpts, ChannelReplyOpts, ChannelReplyResult } from './types.js';
import { clearCurrentRootTurn, getCurrentRootTurn, setCurrentRootTurn } from '../services/agent-turn/current-root-turn.js';
import { completeAgentTurnRecovery, releaseAgentTurnRecovery, renewAgentTurnRecovery, tryClaimAgentTurnRecovery, tryClaimForegroundAgentTurn } from '../services/agent-turn/recovery-coordinator.js';
import {
  createAgentSession,
  estimateTokens,
  calculateContextTokens,
  getLastAssistantUsage,
  shouldCompact,
} from '@earendil-works/pi-coding-agent';
import { backupPiSessionFile, consumeInterruptedPiSessions, gracefulPiShutdown } from '../services/ai/pi-session-runtime.js';
import { createStreamWatchdog, type StuckReason } from './pi-stream-watchdog.js';
import { recordFileEdit } from '../services/workspace/file-edit-log.js';
import { beginFileCheckpointCapture, completeFileCheckpointCapture, markTurnCheckpointPartial, type PendingFileCheckpointCapture } from '../services/agent-turn/file-checkpoint-capture.js';
import { classifyPiFailure, formatPiProviderErrorForOperatorLog, formatPiProviderErrorForUser, isPiAuthFailure, isPiContextOverflowFailure, isPiModelAccountStatusFailure, isPiUserAbortError } from './pi-failure-classifier.js';
import { classifyPiSafeStopRequest, shouldStopPiAtToolBoundary } from './pi/safe-stop.js';
import { classifyPiSteer, markPiRunClosing, type PiRunPhase } from './pi-run-lifecycle.js';
import { forgetPiContextTokenHint, getPiContextTokenHint, getPiResponsesRequestDebugInfo, installPiProviderSafeguards, piFetchCorrelation, rememberPiContextTokenHint } from './pi/provider-safeguards.js';
import { ContentAccumulator, parseTextSignaturePhase } from './pi/message-adapter.js';
import { PiModelRegistryManager } from './pi/model-registry.js';
import { buildPiSessionResources } from './pi/session-resources.js';
import { buildPiToolAssembly } from './pi/tool-assembly.js';
import { createPiSettingsManager } from './pi/session-settings.js';
import { quickReplyWithPiProviders } from './pi/quick-reply.js';
import { openOrCreatePiSessionManager } from './pi/session-manager.js';
import { cleanupStalePiForkSessions } from './pi/stale-cleanup.js';
import type { PiSessionEntry } from './pi/session-entry.js';
import { rehydratePiSessionFromMessages } from './pi/rehydrate.js';
import { channelReplyWithPiRun } from './pi/channel-reply.js';
import {
  formatWatchdogReason,
  getTransientAbortRetryDelayMs,
  getTransientAbortRetryMax,
  isPiTransientAbortError,
  sleep,
  TRANSIENT_ABORT_RETRY_MAX,
} from './pi/run-policy.js';
import { AssistantStreamCoalescer } from './pi/stream-coalescer.js';
import { handlePiQueueUpdate } from './pi/queue-update-handler.js';
import { handlePiCompactionEnd, handlePiCompactionStart } from './pi/compaction-handler.js';
import { isPiCompactionNoOpMessage } from './pi/compaction-outcome.js';
import { handlePiToolExecutionEnd } from './pi/tool-execution-handler.js';
import { handlePiMessageUpdate } from './pi/message-update-handler.js';
import { analyzePiMessageEndCore } from './pi/message-end-handler.js';
import {
  analyzePiAgentEndError,
  getCodexFallbackModelSpecs,
  isCodexAuthInvalidatedError,
  isCodexUsageLimitError,
} from './pi/agent-end-policy.js';
import {
  appendTransientNoticeIfMissing,
  makeTransientNoticeBlock,
  PROVIDER_CAPACITY_EXHAUSTED_NOTICE_TEXT,
  TRANSIENT_ABORT_EXHAUSTED_NOTICE_TEXT,
} from './pi/transient-notice.js';
import { PiRunContext } from './pi/run-context.js';
import { PiRunTerminalizer } from './pi/run-terminalizer.js';
import { PiLifecycleAdapter } from './pi/lifecycle-adapter.js';
import { countPiCompactionEntries, createPiCompactRecoverySessionFile, createPiLocalFallbackCompaction, createPiOversizedRecoveryEpochFromFile, isPiContextLengthExceededMessage, parsePiPreflightContextMetrics, piRecoveryKeepBudgets, sanitizePiMessagesForRecovery, shouldCreatePiOversizedRecoveryEpoch } from './pi/compaction-recovery.js';
import { createPiVisualContextTransform } from './pi/visual-context-lifecycle.js';
import { shouldProactivelyCompactPiSession } from './pi/proactive-compaction.js';
import { appendTowerFileLedgerCheckpoint } from './pi/compaction-file-ledger.js';
import { shouldAutoContinueIncompleteTurn, summarizeAssistantContinuationIntent, type AssistantContinuationIntentSummary } from './pi/continuation-intent.js';
import { runPiContinuationRecovery, settlePiRecoveryOutcome, type PiContinuationTrigger } from './pi/recovery/recovery-coordinator.js';
import { continuePiNativeLifecycle, isPiNativeContinuationUnavailable } from './pi/recovery/native-continuation-adapter.js';
import { decidePiContinuationRecovery, decidePiRestartRecovery, decidePiRetryOwnership, inspectPiRecoveryState, isIncompleteToolBoundaryContinuationEnabled } from './pi/recovery/recovery-policy.js';
import { getOrPinSessionHarnessSnapshot, getPinnedSessionHarnessSnapshot } from '../services/harness/harness-store.js';
import { resolveWorkbenchRollout } from '../services/runtime-box/workbench-rollout-registry.js';
import { buildHarnessRuntimeFingerprint } from '../services/harness/harness-fingerprint.js';

// Pi provider transport safeguards are installed explicitly, not as hidden import side effects.
installPiProviderSafeguards();

/**
 * Returns a Pi bash-tool spawn hook that makes shell tools see the Tower session
 * for the *current run*, not a stale backend/process env value.
 *
 * Why this exists: Pi built-in tools run inside the backend process and inherit
 * process.env by default. In a multi-session web server, process.env may contain
 * a TOWER_SESSION_ID from the worker that launched/restarted the process (or a
 * previous session), while the actual active Tower session is the `sessionId`
 * argument passed to PiEngine.run(). Claude SDK has an explicit per-query `env`
 * option; Pi's local bash backend needs the equivalent per-tool spawn override.
 */
export function createTowerSessionBashSpawnHook(sessionId: string) {
  return ({ command, cwd, env }: { command: string; cwd: string; env: Record<string, string | undefined> }) => ({
    command,
    cwd,
    env: {
      ...env,
      TOWER_SESSION_ID: sessionId,
    },
  });
}

function isPiAuthOrUserActionError(message: unknown): boolean {
  return isPiAuthFailure(message) || isPiUserAbortError(message);
}

function isPiUpstreamRejectedInputFailure(message: unknown): boolean {
  return /upstream_rejected_input|rejected the request before response\.created/i.test(String(message || ''));
}



export class PiEngine implements Engine {
  private sessions = new Map<string, PiSessionEntry>();
  private modelRegistryManager = new PiModelRegistryManager();

  /** Rebuild the provider/model runtime after VM-level Admin setup changes. */
  async reloadModelRegistry(): Promise<void> {
    this.modelRegistryManager = new PiModelRegistryManager();
    await this.modelRegistryManager.getModelRuntime();
  }
  private interruptedSessionIds = new Set<string>();
  /**
   * Sessions whose run() is currently in the "starting" phase
   * (createSession / switchModelIfNeeded await window) — entry.isRunning
   * isn't true yet, but isRunning() must report true so the ws-handler's
   * SESSION_BUSY guard doesn't let a second concurrent prompt slip in.
   */
  private startingSessions = new Set<string>();
  /**
   * Mid-turn injections that arrived during the turn STARTUP window — after the
   * turn was claimed but before the SDK's prompt() began accepting steers. Held
   * here (FIFO, in arrival order) and flushed into the SDK the instant prompt()
   * starts, so messages typed in those first tens of ms join THIS turn instead
   * of being deferred to a separate post-turn run. See GitHub issue #17.
   */
  private startupSteerBuffer = new Map<string, Array<{ text: string; msgId?: string; username?: string | null }>>();

  private hasDuplicateSteer(sessionId: string, entry: PiSessionEntry | undefined, message: string, messageId?: string): boolean {
    const normalized = message.trim().replace(/\s+/g, ' ');
    const startupBuffered = this.startupSteerBuffer.get(sessionId) ?? [];
    const pending = entry?.pendingSteers ?? [];
    const queued = [...startupBuffered, ...pending];
    if (messageId && queued.some((item) => item.msgId && item.msgId === messageId)) return true;
    const sameTextCount = queued.filter((item) => item.text.trim().replace(/\s+/g, ' ') === normalized).length;
    return sameTextCount >= 3;
  }

  async *run(
    sessionId: string,
    prompt: string,
    opts: RunOpts,
    callbacks: EngineCallbacks,
  ): AsyncGenerator<TowerMessage> {
    // Reject re-entry. Without this, a second concurrent run() against the
    // same session would slip past the ws-handler SESSION_BUSY check during
    // the createSession/switchModel await window (entry.isRunning is set
    // later, at line ~321). startingSessions covers that window; isRunning
    // covers the rest of the turn.
    if (this.isRunning(sessionId)) {
      yield {
        type: 'engine_error',
        sessionId,
        message: 'Pi session is already running. Wait for the current turn to finish.',
      };
      return;
    }
    this.startingSessions.add(sessionId);

    // Every foreground and recovery Pi run owns the same durable root-turn row.
    // Foreground claims do not consume recovery attempt budget; automatic retry
    // claims do. Both receive the same fencing token and settlement contract.
    let initialRecoveryClaimToken: string | undefined;
    let initialRecoveryClaimAttempt = 0;
    if (!opts.rootTurnId) {
      this.startingSessions.delete(sessionId);
      yield { type: 'engine_error', sessionId, message: 'Pi execution skipped because the durable root turn identity is missing.', recoverable: true };
      return;
    }
    const initialClaim = opts.autoResume
      ? await tryClaimAgentTurnRecovery({
          rootTurnId: opts.rootTurnId,
          sessionId,
          source: opts.autoResumeReason || 'server-restart',
          ownerBootId: config.serverEpoch,
          takeoverPreviousBoot: opts.autoResumeReason === 'server-restart',
          maxAttempts: 4,
        })
      : await tryClaimForegroundAgentTurn({
          rootTurnId: opts.rootTurnId,
          sessionId,
          ownerBootId: config.serverEpoch,
        });
    if (!initialClaim.claimed || !initialClaim.token) {
      this.startingSessions.delete(sessionId);
      console.warn(`[Pi] durable turn claim denied: session=${sessionId.slice(0, 8)} rootTurn=${opts.rootTurnId.slice(0, 8)} mode=${opts.autoResume ? 'recovery' : 'foreground'} status=${initialClaim.status || 'unknown'}`);
      yield { type: 'engine_done', sessionId, editedFiles: [], outcome: 'claim_denied' };
      return;
    }
    initialRecoveryClaimToken = initialClaim.token;
    initialRecoveryClaimAttempt = initialClaim.attempt ?? 0;

    // 1. Get or create AgentSession (cached per Tower session, persisted to disk).
    // Tool closures capture user/project authority and the effective Workbench
    // rollout at assembly time. Rebuild when either changes so a DB rollout
    // enable/disable takes effect on the next turn without a backend restart.
    const workbenchRolloutEnabled = opts.projectId
      ? (await resolveWorkbenchRollout(opts.projectId)).enabled
      : false;
    let entry = this.sessions.get(sessionId);
    if (entry && (
      entry.toolContext?.userId !== opts.userId
      || entry.toolContext?.userRole !== opts.userRole
      || entry.toolContext?.projectId !== opts.projectId
      || entry.toolContext?.workbenchRolloutEnabled !== workbenchRolloutEnabled
    )) {
      console.warn(`[Pi] Rebuilding cached Session after tool context change: session=${sessionId.slice(0, 8)}`);
      this.dispose(sessionId);
      entry = undefined;
    }
    if (!entry) {
      try {
        entry = await this.createSession(sessionId, opts, callbacks);
      } catch (err: any) {
        this.startingSessions.delete(sessionId);
        if (opts.rootTurnId && initialRecoveryClaimToken) {
          await releaseAgentTurnRecovery({
            rootTurnId: opts.rootTurnId,
            token: initialRecoveryClaimToken,
            error: err?.message || 'Pi session creation failed',
            failureClass: classifyPiFailure(err?.message).kind,
            retryDelaySeconds: 10,
            attempt: initialRecoveryClaimAttempt,
            maxAttempts: 4,
          });
          initialRecoveryClaimToken = undefined;
        }
        yield { type: 'engine_error', sessionId, message: `Pi session creation failed: ${err.message}` };
        yield { type: 'engine_done', sessionId, editedFiles: [], outcome: 'retryable_failure', error: err?.message };
        return;
      }
    }

    // Switch model if user changed it mid-session. Direct emergency providers
    // may need project-granted Vault key overrides before the SDK builds a client.
    if (opts.model) {
      try {
        await this.modelRegistryManager.applyProjectVaultApiKeyOverrides({
          projectId: opts.projectId,
          userId: opts.userId,
          model: opts.model,
        });
        await this.switchModelIfNeeded(entry, opts.model);
      } catch (err: any) {
        console.warn(`[Pi] Model switch failed: ${err.message}`);
      }
    }
    const turnThinkingLevel = opts.effort === 'low' || opts.effort === 'medium' || opts.effort === 'high' || opts.effort === 'xhigh'
      ? opts.effort
      : opts.effort === 'max'
        ? 'xhigh'
        : entry.session.thinkingLevel || 'medium';
    if (entry.session.thinkingLevel !== turnThinkingLevel) {
      entry.session.setThinkingLevel(turnThinkingLevel);
    }

    // G3: Notify frontend if Pi resume failed (before starting the turn)
    if (entry.resumeFailedMessage) {
      yield {
        type: 'engine_error',
        sessionId,
        message: entry.resumeFailedMessage,
        recoverable: true,
      };
      entry.resumeFailedMessage = null;
    }

    entry.isRunning = true;
    entry.runPhase = 'starting';
    setCurrentRootTurn(sessionId, opts.rootTurnId, Boolean(opts.autoResume));
    entry.abortRequested = false;
    entry.safeStopRequested = false;
    // Fresh steer tracking per turn — a prior turn's undelivered steers (e.g.
    // aborted before consumption) must not leak into this run's queue_update diff.
    entry.pendingSteers = [];
    entry.lastSteering = [];
    // promptActive flips true once prompt() begins (below); until then, steers
    // buffer. Reset here in case a prior run left it set after an error path.
    entry.promptActive = false;
    // Hand off from the starting-window guard to the entry-level guard.
    this.startingSessions.delete(sessionId);

    // 2. ContentAccumulator + event queue
    // msgId / accumulator / assistantSaved 가 `let` 인 이유 (2026-05-17):
    // Pi agent-loop 는 한 prompt() 안에서 multi-iteration (assistant → tool_use
    // → tool_result → assistant → ...) 으로 진행. 이전엔 모두 단일 msgId 에
    // 덮어써서 마지막 iter 의 짧은 답만 DB 에 남고 중간 tool calls 트레이스가
    // 사라졌음. claude-engine 와 동일하게 매 assistant message_end 후 다음 iter
    // 용 새 msgId/accumulator 발급해서 iteration 별 별개 row 로 분리.
    // 결정: workspace/decisions/2026-05-17-pi-engine-iteration-msgid.md
    let accumulator = new ContentAccumulator();
    let msgId: string = crypto.randomUUID();
    const runCorrelationId = crypto.randomUUID();
    const autoResumeRun = Boolean(opts.autoResume);
    const autoResumeReason = opts.autoResumeReason;
    const providerCacheSessionId = opts.logicalSessionId || sessionId;
    const promptWithFetchCorrelation = (text: string) => piFetchCorrelation.run(
      {
        sessionId,
        runId: runCorrelationId,
        rootTurnId: opts.rootTurnId,
        attempt: initialRecoveryClaimAttempt,
        promptCacheSessionId: providerCacheSessionId,
      },
      () => entry!.session.prompt(text),
    );
    const SERVER_RESTART_RECOVERY_PROMPT = [
      'The previous run was interrupted by a server restart after an assistant message was persisted.',
      'Continue the same root task from its durable state.',
      'Do not repeat completed tool calls or external side effects; inspect current state and resume only unfinished work.',
    ].join(' ');
    const TRANSIENT_INTERRUPTION_RECOVERY_PROMPT = [
      'The current run was interrupted by a transient provider transport failure after work had already started.',
      'Continue the same root task from its durable state.',
      'Do not repeat completed tool calls or external side effects; inspect current state and resume only unfinished work.',
    ].join(' ');
    const eventQueue: TowerMessage[] = [];
    let resolveWait: (() => void) | null = null;
    let done = false;
    let stopReason: 'stop' | 'length' | 'toolUse' | 'error' | 'aborted' | undefined;
    let durableOutcome: 'completed' | 'retryable_failure' | 'failed' = 'completed';
    let durableError: string | undefined;
    const turnStartTime = Date.now();

    // G2: Track iteration count + cumulative tokens for context metrics.
    // Pi emits message_end for intermediate tool-use messages too.
    // Hold the latest usage until the whole prompt is actually finished.
    let iterationCount = 0;
    let cumulativeInput = 0;
    let cumulativeOutput = 0;
    let lastIterationInput = 0;
    let lastIterationOutput = 0;
    // Pi SDK normalizes provider-specific cache fields into usage.cacheRead /
    // usage.cacheWrite (anthropic.js, openai-completions.js, openai-responses-shared.js,
    // amazon-bedrock.js). Capturing them puts Pi at parity with claude-engine's
    // cache instrumentation — answers "did our turn actually hit cache?" per provider.
    //   • Azure GPT-5.5: OpenAI-style automatic caching (prompt_cache_key=sessionId)
    //   • OpenAI Codex: same OpenAI-style cache
    //   • OpenRouter Kimi K2.6: Moonshot AI native automatic caching (no marker required)
    // Without this we lose 100% of cache visibility on Pi turns (was n/a per the
    // types.ts contract table). 2026-05-18.
    let cumulativeCacheRead = 0;
    let cumulativeCacheWrite = 0;
    let cumulativeReasoning = 0;
    let lastIterationCacheRead = 0;
    let lastIterationCacheWrite = 0;
    let lastIterationReasoning = 0;
    let cumulativeCostUsd = 0;
    let lastCostUsd: number | undefined;
    // If Pi compacts at the end of this prompt, PiRunContext makes the footer
    // CTX stat prefer the post-compaction live context over stale provider usage.
    let codexUsageLimitFallbackRequested = false;
    let codexUsageLimitFallbackAttempted = false;
    let codexUsageLimitMessage = '';
    let oversizedPreflightRecoveryRequested = false;
    let oversizedPreflightRecoveryAttempted = false;
    let oversizedPreflightMessage = '';
    let compactionNoticeEmittedThisTurn = false;
    let visibleCompactionInProgress = false;
    let transientAbortRetryRequested = false;
    let transientAbortRetryMessage = '';
    let transientAbortRetryAttempts = 0;
    let sdkRetryObservedThisRun = false;
    // Transient transport drops (LiteLLM/upstream websocket closed, socket reset,
    // provider-side abort) are not actionable model errors. If they happen before
    // any assistant/tool side effects, Tower may retry the same prompt. If they
    // happen after work has started, replaying the whole prompt can duplicate side
    // effects, so Tower should issue a one-shot continuation prompt instead.
    let transientAbortVisibleSuppressed = false;
    let transientAbortFailureNoticeSaved = false;
    let compactionFailureNoticeSaved = false;
    let compactionRecoveryNoticeSaved = false;
    let providerErrorMustRemainError = false;
    let providerErrorVisibleSurfacedThisTurn = false;
    let lastAssistantTelemetry: AssistantContinuationIntentSummary | undefined;
    let overflowCompactionInProgress = false;
    let overflowCompactionObservedThisTurn = false;
    let compactRecoverySessionFile: string | null = null;
    let currentCompactMarkerId: string | undefined;
    const newCompactMarkerId = () => `compact-${sessionId}-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
    const compactionEntriesAtRunStart = countPiCompactionEntries((entry.session as any)?.sessionManager);
    let sdkCompactionSucceededEventsThisTurn = 0;
    let postCompactContinuationAttempted = false;
    let transientContinuationAttempted = false;
    let incompleteTurnContinuationAttempted = false;
    const incompleteToolBoundaryContinuationEnabled = isIncompleteToolBoundaryContinuationEnabled();
    let recoveryClaimToken: string | undefined = initialRecoveryClaimToken;
    let recoveryClaimAttempt = initialRecoveryClaimAttempt;
    const recoveryLeaseHeartbeat = recoveryClaimToken && opts.rootTurnId
      ? setInterval(() => {
          void renewAgentTurnRecovery({
            rootTurnId: opts.rootTurnId!,
            token: recoveryClaimToken!,
            ownerBootId: config.serverEpoch,
            leaseSeconds: 180,
          });
        }, 60_000)
      : null;
    recoveryLeaseHeartbeat?.unref?.();
    const tryClaimRecovery = async (source: string): Promise<boolean> => {
      if (!opts.rootTurnId) {
        console.warn(`[Pi] recovery skipped without rootTurnId: session=${sessionId.slice(0, 8)} source=${source}`);
        return false;
      }
      if (recoveryClaimToken) return true;
      const claim = await tryClaimAgentTurnRecovery({
        rootTurnId: opts.rootTurnId,
        sessionId,
        source,
        ownerBootId: config.serverEpoch,
        takeoverPreviousBoot: false,
        maxAttempts: 4,
      });
      if (!claim.claimed || !claim.token) {
        console.warn(`[Pi] recovery claim denied: session=${sessionId.slice(0, 8)} rootTurn=${opts.rootTurnId.slice(0, 8)} source=${source} status=${claim.status || 'unknown'}`);
        return false;
      }
      recoveryClaimToken = claim.token;
      recoveryClaimAttempt = claim.attempt ?? 0;
      setCurrentRootTurn(sessionId, opts.rootTurnId, true);
      return true;
    };
    const completeRecoveryClaim = async (status: 'completed' | 'failed' | 'uncertain', error?: string) => {
      if (!opts.rootTurnId || !recoveryClaimToken) return;
      await completeAgentTurnRecovery({
        rootTurnId: opts.rootTurnId,
        token: recoveryClaimToken,
        status,
        error,
        assistantMessageId: status === 'completed' ? lastSavedAssistantMsgId ?? undefined : undefined,
      });
      recoveryClaimToken = undefined;
    };
    const releaseRecoveryClaim = async (error?: string) => {
      if (!opts.rootTurnId || !recoveryClaimToken) return;
      const failureClass = classifyPiFailure(error).kind;
      await releaseAgentTurnRecovery({
        rootTurnId: opts.rootTurnId,
        token: recoveryClaimToken,
        error,
        failureClass,
        retryDelaySeconds: Math.min(60, Math.max(5, recoveryClaimAttempt * 10)),
        attempt: recoveryClaimAttempt,
        maxAttempts: 4,
      });
      recoveryClaimToken = undefined;
    };
    // Resolve model context window from the session's current model
    const modelContextWindow = entry.session.model?.contextWindow || 200_000;
    const runCtx = new PiRunContext({
      modelContextWindow,
      turnStartTime,
      initialMsgId: msgId,
      makeId: () => crypto.randomUUID(),
    });

    // Save initial assistant message to DB. Reset to false after each
    // assistant message_end so the next iteration's first message_update
    // calls saveMessage() (creating a fresh row) instead of updateMessageContent
    // (which would overwrite the previous iteration's row).
    let assistantSaved = false;
    // msgId is reset after each assistant iteration. Keep the latest persisted
    // assistant row so final turn metrics (including estimated live context)
    // land on a real DB row, not a freshly allocated empty msgId.
    let lastSavedAssistantMsgId: string | null = null;
    const rememberAssistantMsgId = (id: string) => runCtx.markAssistantSaved(id);
    const canAutoRetryTransientAbort = () => {
      const ownership = decidePiRetryOwnership(sdkRetryObservedThisRun);
      return ownership.towerRetryAllowed &&
        !entry.abortRequested &&
        !watchdogAborted &&
        transientAbortRetryAttempts < getTransientAbortRetryMax(transientAbortRetryMessage);
    };

    const isOversizedPreflightError = isPiContextLengthExceededMessage;

    const emitRecoveryCompactStart = (reason: string) => {
      if (compactionNoticeEmittedThisTurn) return;
      compactionNoticeEmittedThisTurn = true;
      visibleCompactionInProgress = true;
      overflowCompactionInProgress = true;
      overflowCompactionObservedThisTurn = true;
      currentCompactMarkerId = currentCompactMarkerId || newCompactMarkerId();
      eventQueue.push(...handlePiCompactionStart({ event: { reason }, sessionId }));
      resolveWait?.();
    };

    const emitRecoveryCompactDoneIfNeeded = (reason: string) => {
      overflowCompactionInProgress = false;
      if (!visibleCompactionInProgress) return;
      const markerId = currentCompactMarkerId || newCompactMarkerId();
      eventQueue.push({ type: 'compact', sessionId, phase: 'done', markerId });
      visibleCompactionInProgress = false;
      currentCompactMarkerId = undefined;
      console.log(`[Pi] compaction_end: session=${sessionId.slice(0, 8)} reason=${reason} manual_recovery=true`);
      resolveWait?.();
    };

    const emitRecoveryCompactSkippedIfNeeded = (reason: string) => {
      overflowCompactionInProgress = false;
      if (!visibleCompactionInProgress) return;
      eventQueue.push({ type: 'compact', sessionId, phase: 'skipped' });
      visibleCompactionInProgress = false;
      currentCompactMarkerId = undefined;
      console.log(`[Pi] compaction_skipped: session=${sessionId.slice(0, 8)} reason=${reason} manual_recovery=true`);
      resolveWait?.();
    };

    const emitRecoveryCompactFailedIfNeeded = (reason: string) => {
      overflowCompactionInProgress = false;
      if (!visibleCompactionInProgress) return;
      eventQueue.push({ type: 'compact', sessionId, phase: 'failed' });
      visibleCompactionInProgress = false;
      currentCompactMarkerId = undefined;
      console.warn(`[Pi] compaction_failed: session=${sessionId.slice(0, 8)} reason=${reason} manual_recovery=true`);
      resolveWait?.();
    };

    const towerFileLedgerCheckpointPromises: Promise<void>[] = [];
    const appendTowerFileLedgerAfterCompaction = (reason: string): Promise<void> => {
      const promise = (async () => {
        const manager = (entry.session as any)?.sessionManager;
        const checkpoint = await appendTowerFileLedgerCheckpoint({
          sessionId,
          session: manager,
          reason,
        });
        if (checkpoint.appended) {
          console.log(`[Pi] tower file ledger checkpoint appended: session=${sessionId.slice(0, 8)} entry=${checkpoint.entryId} files=${checkpoint.fileCount} omitted=${checkpoint.omittedCount} reason=${reason}`);
        } else if (checkpoint.reason && checkpoint.reason !== 'no file ledger rows') {
          console.warn(`[Pi] tower file ledger checkpoint skipped: session=${sessionId.slice(0, 8)} reason=${checkpoint.reason}`);
        }
      })();
      towerFileLedgerCheckpointPromises.push(promise);
      return promise;
    };

    const settleNativeContinuationUnavailable = async (message: string) => {
      durableOutcome = 'failed';
      durableError = message;
      await completeRecoveryClaim('uncertain', message);
    };

    const emitContinuationFailure = (message: string) => {
      const nativeContinuationUnavailable = isPiNativeContinuationUnavailable(message);
      eventQueue.push({
        type: 'engine_error',
        sessionId,
        message,
        // Native continuation availability is an internal recovery detail. Route it
        // through resume_failed so the frontend keeps the diagnostic out of the
        // transcript and leaves the normal "계속 진행" action as the recovery path.
        recoverable: nativeContinuationUnavailable,
        retryable: nativeContinuationUnavailable,
      });
    };

    const continueWithPiNativeLifecycle = async (reason: string): Promise<void> => {
      await piFetchCorrelation.run(
        {
          sessionId,
          runId: runCorrelationId,
          rootTurnId: opts.rootTurnId,
          attempt: recoveryClaimAttempt,
          promptCacheSessionId: providerCacheSessionId,
        },
        () => continuePiNativeLifecycle(entry!.session, reason),
      );
    };

    const runContinuationRecovery = async (params: {
      trigger: PiContinuationTrigger;
      source: string;
      failureMessage: string;
      logStart: string;
      execute?: (reason: string) => Promise<void>;
      hasDurableAssistant?: () => boolean;
    }): Promise<boolean> => {
      console.warn(params.logStart);
      const result = await runPiContinuationRecovery({
        trigger: params.trigger,
        source: params.source,
        failureMessage: params.failureMessage,
        callbacks: {
          claim: tryClaimRecovery,
          prepare: () => {
            transientAbortRetryRequested = false;
            transientAbortRetryMessage = '';
            stopReason = undefined;
            providerErrorMustRemainError = false;
            clearClosingTerminalizer();
            clearAgentEndTerminalizer();
            entry.runPhase = 'running';
            entry.promptActive = true;
          },
          execute: params.execute || continueWithPiNativeLifecycle,
          settleRetries: runTransientRetriesIfNeeded,
          hasDurableAssistant: params.hasDurableAssistant || (() => Boolean(lastSavedAssistantMsgId)),
          noResultError: () => transientAbortRetryMessage || 'Recovery produced no durable assistant result.',
          complete: () => completeRecoveryClaim('completed'),
          release: releaseRecoveryClaim,
          settleUnavailable: settleNativeContinuationUnavailable,
          surfaceTransient: suppressTransientAbortVisibleError,
          emitFailure: emitContinuationFailure,
          isTransient: isPiTransientAbortError,
          isUnavailable: isPiNativeContinuationUnavailable,
          log: message => console.warn(`[Pi] ${params.trigger} continuation failed: session=${sessionId.slice(0, 8)} source=${params.source} error=${message.slice(0, 180)}`),
        },
      });
      return result.recovered;
    };

    const persistTerminalTransientNotice = (noticeText: string) => {
      if (transientAbortFailureNoticeSaved) return;
      transientAbortFailureNoticeSaved = true;

      const stopNote = makeTransientNoticeBlock(noticeText);
      // Persist only the final exhausted/user-aborted outcome. Recoverable
      // intermediate transport notices are runtime state, not assistant prose.
      // Keeping them out of the DB prevents a successful recovery from leaving
      // a stale "Tower가 재시도합니다" prefix in the final answer.
      const noticeMsgId = crypto.randomUUID();
      trackDbWrite(callbacks.saveMessage({ id: noticeMsgId, role: 'assistant', content: [stopNote] }));
      lastSavedAssistantMsgId = noticeMsgId;
      rememberAssistantMsgId(noticeMsgId);
      queueAssistantEvent([stopNote], true);
    };

    const persistCompactionNoticeBlock = (noticeBlock: any) => {
      if (!assistantSaved) {
        trackDbWrite(callbacks.saveMessage({ id: msgId, role: 'assistant', content: [noticeBlock] }));
        assistantSaved = true;
        lastSavedAssistantMsgId = msgId;
        rememberAssistantMsgId(msgId);
        return;
      }

      const pendingDbUpdate = coalescer.getPendingAssistantDbUpdate();
      const currentContent = pendingDbUpdate?.msgId === msgId
        ? pendingDbUpdate.content
        : accumulator.toTowerBlocks();
      const { content: contentWithNote, appended } = appendTransientNoticeIfMissing(currentContent, noticeBlock);
      if (!appended) return;
      coalescer.clearPendingAssistantDbUpdate();
      coalescer.clearAssistantDbTimer();
      trackDbWrite(callbacks.updateMessageContent(msgId, contentWithNote));
      queueAssistantEvent(contentWithNote, true);
    };

    const persistCompactionFailureNotice = (reason: string) => {
      if (compactionFailureNoticeSaved) return;
      compactionFailureNoticeSaved = true;
      const compactReason = String(reason || 'unknown compaction failure').slice(0, 240);
      persistCompactionNoticeBlock({
        type: 'text',
        text: `⚠️ 컨텍스트 자동 정리를 시도했지만 완료하지 못했습니다. 같은 세션에서 다시 보내면 재시도하거나, 필요하면 새 세션으로 이어가 주세요. 원인: ${compactReason}`,
        compactionFailure: true,
      });
    };

    const persistCompactionRecoveryNotice = (reason: string) => {
      if (compactionRecoveryNoticeSaved) return;
      compactionRecoveryNoticeSaved = true;
      const compactReason = String(reason || 'unknown compaction recovery').slice(0, 240);
      persistCompactionNoticeBlock({
        type: 'text',
        text: `⚠️ 컨텍스트 자동 정리 중 요약 모델 응답이 끊겼지만, Tower가 로컬 복구 정리를 적용했습니다. 같은 세션에서 다시 보내면 이어서 진행할 수 있습니다. 원인: ${compactReason}`,
        compactionRecovery: true,
      });
    };

    const suppressTransientAbortVisibleError = (source: string, fullErrText: string) => {
      transientAbortVisibleSuppressed = true;
      // Preserve transport failures as aborted, not clean stop. Pi SDK can emit
      // message_end(error) and then still resolve prompt(); without this marker
      // the normal error→stop downgrade makes stream_incomplete/upstream truncation
      // look like a successful empty completion.
      stopReason = 'aborted';
      transientAbortRetryMessage = fullErrText;
      const failureKind = classifyPiFailure(fullErrText).kind;
      console.warn(`[Pi] transient/provider retryable error suppressed (${source}); session=${sessionId.slice(0, 8)} kind=${failureKind} autoResume=${autoResumeRun} error=${fullErrText.slice(0, 180)}`);
      // Keep automatic recovery as ephemeral runtime state. The existing
      // streaming/run phase remains active; only exhausted recovery is persisted.
    };

    // DB callbacks are async in ws-handler. The Pi event subscription itself is
    // synchronous, so fire-and-forget saves can race with turn_done/touchMessages:
    // a real prod turn showed all iteration rows receiving the same final
    // timestamp and reloading in arbitrary order. Track writes and flush before
    // emitting turn_done so DB order matches streamed order.
    const pendingDbWrites: Promise<void>[] = [];
    const trackDbWrite = (op: void | Promise<void>) => {
      const p = Promise.resolve(op).catch((err: any) => {
        console.warn(`[Pi] DB callback failed: session=${sessionId.slice(0, 8)} error=${err?.message || err}`);
      });
      pendingDbWrites.push(p);
      return p;
    };
    const flushDbWrites = async () => {
      if (pendingDbWrites.length === 0) return;
      const writes = pendingDbWrites.splice(0, pendingDbWrites.length);
      await Promise.allSettled(writes);
    };
    const recordPrivateTrace = (
      eventType: Parameters<NonNullable<EngineCallbacks['recordTraceEvent']>>[0]['eventType'],
      payload: Record<string, unknown> = {},
      messageId: string | null = msgId,
    ) => {
      if (!callbacks.recordTraceEvent) return;
      trackDbWrite(callbacks.recordTraceEvent({
        eventType,
        messageId,
        payload: {
          ...payload,
          runPhase: entry.runPhase,
          autoResume: autoResumeRun,
          autoResumeReason,
        },
      }));
    };

    // Phase 1 realtime performance guard (2026-05-31): Pi providers can emit
    // text/toolcall deltas at machine speed (100+/sec). Tower UI only needs
    // human-speed snapshots. Keep raw stream processing local, but coalesce
    // frontend broadcasts and DB content updates so one session cannot starve
    // the app shell. Decision: workspace/decisions/2026-05-31-realtime-performance-architecture.md
    const PI_DEBUG_RAW_EVENTS = process.env.PI_DEBUG_RAW_EVENTS === '1';
    const ASSISTANT_STREAM_FLUSH_MS = Math.max(25, Number(process.env.PI_ASSISTANT_STREAM_FLUSH_MS) || 150);
    const ASSISTANT_DB_FLUSH_MS = Math.max(50, Number(process.env.PI_ASSISTANT_DB_FLUSH_MS) || 300);
    const coalescer = new AssistantStreamCoalescer({
      sessionId,
      getMsgId: () => msgId,
      streamFlushMs: ASSISTANT_STREAM_FLUSH_MS,
      dbFlushMs: ASSISTANT_DB_FLUSH_MS,
      pushAssistantEvent: (message) => {
        eventQueue.push(message);
        resolveWait?.();
      },
      trackDbWrite,
      updateMessageContent: callbacks.updateMessageContent,
    });
    const streamPerf = coalescer.perf;
    const flushAssistantEvent = () => coalescer.flushAssistantEvent();
    const queueAssistantEvent = (content: TowerContentBlock[], immediate = false) => coalescer.queueAssistantEvent(content, immediate);
    const clearAssistantEventTimer = () => coalescer.clearAssistantEventTimer();
    const flushAssistantDbUpdate = () => coalescer.flushAssistantDbUpdate();
    const queueAssistantDbUpdate = (id: string, content: TowerContentBlock[], immediate = false) => coalescer.queueAssistantDbUpdate(id, content, immediate);
    const clearAssistantDbTimer = () => coalescer.clearAssistantDbTimer();

    // ── Mid-stream stuck watchdog (block-level _end timeout) ──
    //
    // Background: The Pi SDK's agent loop assumes terminal events (*_end,
    // message_end, finish_reason) will always arrive. Real prod case 73c1fbcf
    // (2026-05-17, Kimi K2.6 via OpenRouter) — thinking_start + text_start +
    // toolcall_start ALL fire, then thinking_delta + text_delta + toolcall_delta
    // stream at 450-2330 events/min for 23 MINUTES with NO *_end ever. User
    // aborts manually. Matches upstream earendil-works/pi issue #2381 (NOT
    // fixed in v0.74.1) — multi-provider, model-agnostic.
    //
    // Why block-level (NOT wall-clock turn cap): an earlier attempt used a
    // wall-clock assistant turn cap (8min). User correctly objected — prod
    // iter2 ran 4min 49s as *normal* heavy reasoning; an 8min cap would
    // false-positive any legitimate long-reasoning turn (10-20min routine on
    // complex tasks). The discriminator between "long but progressing" and
    // "stuck" is whether each block produces its _end signal — not how long
    // the whole turn takes.
    //
    // Decisions:
    //   workspace/decisions/2026-05-17-pi-stream-stuck-mid-iteration.md
    //   (v2 — block-level redesign after wall-clock false-positive concern)
    //
    // Tunable via env:
    //   PI_STREAM_IDLE_MS (default 15 min) — ANY-event silence cap, paused during tool execution
    //   PI_BLOCK_TIMEOUT_MS (default 60 min) — per-block _start→_end cap
    // Code defaults intentionally favor long autonomous work over premature
    // abort. Prod may set even more generous values (e.g. 1h/2h).
    const STREAM_IDLE_MS = Number(process.env.PI_STREAM_IDLE_MS) || 15 * 60_000;
    const BLOCK_TIMEOUT_MS = Number(process.env.PI_BLOCK_TIMEOUT_MS) || 60 * 60_000;
    const TOOL_HEARTBEAT_MS = Math.max(5_000, Number(process.env.PI_TOOL_HEARTBEAT_MS) || 10_000);
    let watchdogAborted: StuckReason | null = null;
    const CLOSING_TERMINALIZE_MS = Math.max(5_000, Number(process.env.PI_CLOSING_TERMINALIZE_MS) || 30_000);
    const AGENT_END_ERROR_TERMINALIZE_MS = Math.max(5_000, Number(process.env.PI_AGENT_END_ERROR_TERMINALIZE_MS) || 5_000);
    const OVERFLOW_COMPACTION_SETTLE_MS = Math.max(60_000, Number(process.env.PI_OVERFLOW_COMPACTION_SETTLE_MS) || 5 * 60_000);
    let closingTerminalizerTimer: ReturnType<typeof setTimeout> | null = null;
    let agentEndTerminalizerTimer: ReturnType<typeof setTimeout> | null = null;
    const clearClosingTerminalizer = () => {
      if (closingTerminalizerTimer) clearTimeout(closingTerminalizerTimer);
      closingTerminalizerTimer = null;
    };
    const clearAgentEndTerminalizer = () => {
      if (agentEndTerminalizerTimer) clearTimeout(agentEndTerminalizerTimer);
      agentEndTerminalizerTimer = null;
    };
    const markClosing = (why: string, terminalStopOverride?: 'error' | 'aborted', timeoutMs = CLOSING_TERMINALIZE_MS) => {
      if (entry.runPhase !== 'closed' && entry.runPhase !== 'closing') {
        console.warn(`[Pi] run entering closing phase: session=${sessionId.slice(0, 8)} why=${why}`);
      }
      entry.runPhase = markPiRunClosing(entry.runPhase);
      entry.promptActive = false;
      if (!closingTerminalizerTimer) {
        closingTerminalizerTimer = setTimeout(() => {
          if (!promptSettled && !terminalizer.isTerminalForced) {
            console.warn(`[Pi] closing terminalizer firing: session=${sessionId.slice(0, 8)} why=${why} timeout=${timeoutMs}ms`);
            forceTerminalizeRun(`closing-timeout:${why}`, terminalStopOverride ?? (entry.abortRequested ? 'aborted' : 'error')).catch((e: any) => {
              console.warn(`[Pi] closing terminalizer failed: ${e?.message || e}`);
            });
          }
        }, timeoutMs);
      }
    };
    let toolRunDepthForPhase = 0;
    let toolCallsForTelemetry = 0;
    let toolHeartbeatTimer: ReturnType<typeof setInterval> | null = null;
    let lastToolStatusMeta: { activeToolName?: string; activeToolUseId?: string } = {};
    let lastTraceStatusKey = '';
    const clearToolHeartbeat = () => {
      if (toolHeartbeatTimer) clearInterval(toolHeartbeatTimer);
      toolHeartbeatTimer = null;
    };
    const setOpenRunPhase = (phase: PiRunPhase) => {
      if (entry.runPhase !== 'closing' && entry.runPhase !== 'closed' && entry.runPhase !== 'error') {
        entry.runPhase = phase;
      }
    };
    const emitTurnStatus = (phase: 'running' | 'tool_running' | 'stalled' | 'closing', meta: { activeToolName?: string; activeToolUseId?: string } = {}) => {
      eventQueue.push({ type: 'turn_status', sessionId, phase, timestamp: Date.now(), ...meta });
      const traceKey = `${phase}:${meta.activeToolName || ''}:${meta.activeToolUseId || ''}`;
      if (traceKey !== lastTraceStatusKey) {
        lastTraceStatusKey = traceKey;
        recordPrivateTrace('progress_status', {
          phase,
          activeToolName: meta.activeToolName,
          activeToolUseId: meta.activeToolUseId,
        });
      }
      resolveWait?.();
    };
    const ensureToolHeartbeat = () => {
      if (toolHeartbeatTimer) return;
      toolHeartbeatTimer = setInterval(() => {
        if (entry.promptActive && toolRunDepthForPhase > 0) {
          emitTurnStatus('tool_running', lastToolStatusMeta);
        } else {
          clearToolHeartbeat();
        }
      }, TOOL_HEARTBEAT_MS);
    };
    const enterToolRunningPhase = (event?: any) => {
      toolRunDepthForPhase++;
      if (entry.promptActive) {
        setOpenRunPhase('tool_running');
        lastToolStatusMeta = { activeToolName: event?.toolName, activeToolUseId: event?.toolCallId };
        emitTurnStatus('tool_running', lastToolStatusMeta);
        ensureToolHeartbeat();
      }
    };
    const leaveToolRunningPhase = () => {
      toolRunDepthForPhase = Math.max(0, toolRunDepthForPhase - 1);
      if (toolRunDepthForPhase === 0) {
        clearToolHeartbeat();
        lastToolStatusMeta = {};
      }
      if (shouldStopPiAtToolBoundary({
        toolRunDepth: toolRunDepthForPhase,
        safeStopRequested: Boolean(entry.safeStopRequested),
        abortRequested: Boolean(entry.abortRequested),
      })) {
        entry.abortRequested = true;
        markClosing('safe-stop-boundary', 'aborted');
        try { entry.session.abort(); } catch { /* best-effort after tool boundary */ }
        resolveWait?.();
        return;
      }
      if (toolRunDepthForPhase === 0 && entry.promptActive) {
        setOpenRunPhase('running');
        emitTurnStatus('running');
      }
    };

    const watchdog = createStreamWatchdog({
      streamIdleMs: STREAM_IDLE_MS,
      blockTimeoutMs: BLOCK_TIMEOUT_MS,
      onStuck: (reason, elapsedMs) => {
        watchdogAborted = reason;
        markClosing(`watchdog:${reason}`);
        console.warn(`[Pi] stream watchdog: ${reason} elapsed=${Math.round(elapsedMs / 1000)}s — aborting session=${sessionId.slice(0, 8)}`);
        entry.abortRequested = true;
        try { entry.session.abort(); } catch { /* abort is best-effort */ }
        resolveWait?.();
      },
    });

    const pendingFileCheckpointCaptures = new Map<string, Promise<PendingFileCheckpointCapture | null>>();
    const checkpointContext = config.turnRewindEnabled && opts.rootTurnId && opts.sessionProjectRoot
      ? { rootTurnId: opts.rootTurnId, sessionId, projectRoot: opts.sessionProjectRoot }
      : null;
    const beginCheckpointForTool = (event: any): void => {
      if (!checkpointContext) return;
      const toolCallId = String(event.toolCallId || '');
      const toolName = String(event.toolName || '').toLowerCase();
      const filePath = event.args?.path || event.args?.file_path;
      if ((toolName === 'write' || toolName === 'edit') && toolCallId && filePath) {
        pendingFileCheckpointCaptures.set(toolCallId, beginFileCheckpointCapture({
          ...checkpointContext,
          filePath,
          toolName,
        }).catch((error) => {
          console.warn(`[checkpoint] before capture failed: session=${sessionId.slice(0, 8)} tool=${toolName} error=${(error as Error).message}`);
          return null;
        }));
      } else if (toolName === 'project_shell' || toolName === 'bash' || /shell|bash/i.test(toolName)) {
        void markTurnCheckpointPartial(checkpointContext).catch((error) => {
          console.warn(`[checkpoint] partial marker failed: session=${sessionId.slice(0, 8)} tool=${toolName} error=${(error as Error).message}`);
        });
      }
    };
    const completeCheckpointForTool = (event: any): void => {
      const toolCallId = String(event.toolCallId || '');
      const pending = pendingFileCheckpointCaptures.get(toolCallId);
      if (!pending) return;
      pendingFileCheckpointCaptures.delete(toolCallId);
      void pending.then((capture) => capture ? completeFileCheckpointCapture(capture) : undefined).catch((error) => {
        console.warn(`[checkpoint] after capture failed: session=${sessionId.slice(0, 8)} tool=${event.toolName || '-'} error=${(error as Error).message}`);
      });
    };

    // 3. Subscribe to Pi events
    const lifecycleShadow = new PiLifecycleAdapter(sessionId.slice(0, 8));
    const sdkWaitForIdle = typeof (entry.session as any).waitForIdle === 'function'
      ? () => (entry.session as any).waitForIdle()
      : undefined;
    lifecycleShadow.startWaitForIdleProbe(sdkWaitForIdle);
    console.log(`[Pi] run() starting: session=${sessionId.slice(0, 8)} model=${entry.session.model?.provider}/${entry.session.model?.id} autoResume=${autoResumeRun}${autoResumeReason ? ` autoResumeReason=${autoResumeReason}` : ''} prompt=${prompt.slice(0, 80)} watchdog=idle${STREAM_IDLE_MS / 1000}s/block${BLOCK_TIMEOUT_MS / 1000}s`);
    const unsub = entry.session.subscribe((event: any) => {
      watchdog.observe(event);
      lifecycleShadow.observeSdkEvent(event, Boolean(entry.session.isIdle));
      if (PI_DEBUG_RAW_EVENTS) {
        console.log(`[Pi] event: session=${sessionId.slice(0, 8)} type=${event.type} subtype=${event.assistantMessageEvent?.type || event.message?.role || '-'}`);
      }
      switch (event.type) {
        // Pi 0.82 lifecycle observations only. Keep Tower's existing watchdog,
        // terminalizer, and compaction recovery authoritative during the first
        // upgrade so upstream timing changes cannot silently alter turn closure.
        case 'agent_settled': {
          console.log(`[Pi] lifecycle settled: session=${sessionId.slice(0, 8)} sdkIdle=${entry.session.isIdle}`);
          resolveWait?.();
          break;
        }
        case 'auto_retry_start': {
          sdkRetryObservedThisRun = true;
          transientAbortRetryRequested = false;
          transientAbortRetryMessage = '';
          providerErrorMustRemainError = false;
          console.warn(`[Pi] SDK retry owns run: session=${sessionId.slice(0, 8)} attempt=${event.attempt} maxAttempts=${event.maxAttempts} delayMs=${event.delayMs}`);
          resolveWait?.();
          break;
        }
        case 'auto_retry_end': {
          sdkRetryObservedThisRun = true;
          console.warn(`[Pi] SDK retry finished: session=${sessionId.slice(0, 8)} success=${event.success} attempt=${event.attempt}`);
          resolveWait?.();
          break;
        }
        case 'summarization_retry_scheduled': {
          console.warn(`[Pi] summarization retry scheduled: session=${sessionId.slice(0, 8)} kind=${event.kind} attempt=${event.attempt} delayMs=${event.delayMs}`);
          resolveWait?.();
          break;
        }
        case 'summarization_retry_attempt_start': {
          console.warn(`[Pi] summarization retry attempt: session=${sessionId.slice(0, 8)} kind=${event.kind} attempt=${event.attempt}`);
          resolveWait?.();
          break;
        }
        case 'summarization_retry_finished': {
          console.warn(`[Pi] summarization retry finished: session=${sessionId.slice(0, 8)} kind=${event.kind} attempt=${event.attempt} success=${event.success}`);
          resolveWait?.();
          break;
        }
        case 'message_update': {
          coalescer.incrementRawMessageUpdates();
          const subtype = event.assistantMessageEvent?.type;
          if (subtype === 'thinking_start') {
            recordPrivateTrace('thinking_start', { subtype });
          } else if (subtype === 'thinking_end') {
            recordPrivateTrace('thinking_end', { subtype });
          } else if (subtype === 'text_end' || subtype === 'text_delta') {
            const evt = event.assistantMessageEvent;
            const block = Array.isArray(evt?.partial?.content) ? evt.partial.content[evt.contentIndex] : undefined;
            const phase = parseTextSignaturePhase(block);
            if (phase && phase !== 'final_answer') {
              recordPrivateTrace('commentary_signal', { subtype, phase, visibility: phase === 'commentary' ? 'progress_or_hidden' : 'hidden' });
            }
          }
          const result = handlePiMessageUpdate({ event, accumulator });
          if (result.stopReason) stopReason = result.stopReason || stopReason;
          if (result.editedFile) {
            editedFiles.add(result.editedFile.filePath);
            void recordFileEdit(sessionId, result.editedFile.filePath, result.editedFile.toolName);
          }

          const content = result.content;
          // DB save
          // Some providers emit structural starts (e.g. toolcall_start) before any
          // visible block exists. Persisting [] creates empty assistant bubbles/rows;
          // wait until we have at least one block, then update normally.
          if (content.length > 0) {
            if (!assistantSaved) {
              trackDbWrite(callbacks.saveMessage({ id: msgId, role: 'assistant', content }));
              assistantSaved = true;
              lastSavedAssistantMsgId = msgId;
              rememberAssistantMsgId(msgId);
            } else {
              queueAssistantDbUpdate(msgId, content);
            }

            queueAssistantEvent(content, result.immediate);
          }
          resolveWait?.();
          break;
        }

        // Tool execution lifecycle. Keep this as Tower run-state only: it lets
        // steer policy and future UI distinguish "model streaming" from "tool is
        // running while the parent stream may be quiet". The actual assistant
        // tool_use block is still captured from message_update/toolcall_end above.
        case 'tool_execution_start': {
          toolCallsForTelemetry++;
          beginCheckpointForTool(event);
          enterToolRunningPhase(event);
          break;
        }

        case 'tool_execution_end': {
          leaveToolRunningPhase();
          completeCheckpointForTool(event);
          const result = handlePiToolExecutionEnd(event);

          if (result.toolCallId) {
            trackDbWrite(callbacks.attachToolResult(result.toolCallId, result.resultText));
          }

          if (result.editedFile) {
            editedFiles.add(result.editedFile.filePath);
            // Backlinks (Level 1 C2): persist for cross-engine "관련 세션" lookup.
            // Fire-and-forget — recordFileEdit swallows its own errors so a DB
            // hiccup never breaks the tool-execution loop.
            void recordFileEdit(sessionId, result.editedFile.filePath, result.editedFile.toolName);
          }

          resolveWait?.();
          break;
        }

        // W7 (2026-05-17): autocompact observability ──
        // Pi SDK emits compaction_start / compaction_end on the agent session
        // (agent-session.d.ts:45-59). Before this case existed, Pi sessions
        // ran SDK auto-compaction silently — users saw "왜 답이 이상해" with
        // no signal that transcript was just trimmed.
        //
        // Map to TowerCompactMsg phases:
        //   compaction_start → 'boundary' + 'compacting' (claude-engine emits
        //     'boundary' on compact_boundary and 'compacting' on status=compacting
        //     — Pi only has the start event, so we fire both at start so the
        //     frontend toast / channel status indicator triggers immediately).
        //   compaction_end → 'done'
        //
        // ChannelReply path's onCompact callback (W4) auto-receives this and
        // forwards to ai-quick-reply.ts which shows "🔄 컨텍스트 정리 중..." in
        // the channel. ws-handler path forwards to the frontend session UI.
        //
        // See: workspace/decisions/2026-05-17-pi-claude-parity-roadmap.md (W7)
        case 'compaction_start': {
          overflowCompactionInProgress = true;
          overflowCompactionObservedThisTurn = true;
          if (!compactionNoticeEmittedThisTurn) {
            compactionNoticeEmittedThisTurn = true;
            visibleCompactionInProgress = true;
            currentCompactMarkerId = currentCompactMarkerId || newCompactMarkerId();
            eventQueue.push(...handlePiCompactionStart({ event, sessionId }));
          } else {
            console.warn(`[Pi] duplicate compaction_start suppressed from UI: session=${sessionId.slice(0, 8)} reason=${(event as any).reason}`);
            handlePiCompactionStart({ event, sessionId });
          }
          resolveWait?.();
          break;
        }
        case 'compaction_end': {
          overflowCompactionInProgress = false;
          let result = handlePiCompactionEnd({
            event,
            sessionId,
            forgetContextHint: forgetPiContextTokenHint,
            getSdkSessionId: () => (entry.session as any)?.sessionManager?.getSessionId?.(),
          });
          if (result.succeeded) {
            const manager = (entry.session as any)?.sessionManager;
            const persistedCompactionCount = countPiCompactionEntries(manager);
            if (persistedCompactionCount > compactionEntriesAtRunStart + sdkCompactionSucceededEventsThisTurn) {
              forgetPiContextTokenHint(sessionId);
              try { forgetPiContextTokenHint((entry.session as any)?.sessionManager?.getSessionId?.()); } catch { /* best-effort */ }
              runCtx.compactionSucceededThisTurn = true;
              sdkCompactionSucceededEventsThisTurn++;
            } else {
              const fallback = createPiLocalFallbackCompaction({
                session: manager,
                agent: (entry.session as any)?.agent,
                reason: `compaction_end result was not persisted (${(event as any).reason || 'unknown'})`,
              });
              if (fallback.succeeded) {
                forgetPiContextTokenHint(sessionId);
                try { forgetPiContextTokenHint((entry.session as any)?.sessionManager?.getSessionId?.()); } catch { /* best-effort */ }
                runCtx.compactionSucceededThisTurn = true;
                sdkCompactionSucceededEventsThisTurn++;
                const markerId = currentCompactMarkerId || newCompactMarkerId();
                result = { outcome: 'compacted', succeeded: true, messages: [{ type: 'compact', sessionId, phase: 'done', markerId }] };
                console.warn(`[Pi] local fallback compaction created after unpersisted SDK result: session=${sessionId.slice(0, 8)} compaction=${fallback.compactionId} before=${fallback.before} after=${fallback.after}`);
              } else {
                console.warn(`[Pi] compaction_end had result but no persisted compaction entry yet: session=${sessionId.slice(0, 8)} before=${compactionEntriesAtRunStart} current=${persistedCompactionCount} reason=${(event as any).reason} fallback=${fallback.reason || 'failed'}`);
              }
            }
          } else if (result.outcome === 'skipped') {
            // A small session legitimately has nothing to summarize. Keep the
            // current native Session intact and let the original prompt or the
            // bounded continuation path proceed; this is not a failed recovery.
            console.log(`[Pi] compaction no-op accepted: session=${sessionId.slice(0, 8)} reason=${String((event as any).errorMessage || (event as any).reason || 'nothing to compact').slice(0, 180)}`);
          } else if (!(event as any).aborted) {
            const noResultReason = (event as any).errorMessage || `compaction_end produced no usable result (${(event as any).reason || 'unknown'})`;
            const fallback = createPiLocalFallbackCompaction({
              session: (entry.session as any)?.sessionManager,
              agent: (entry.session as any)?.agent,
              reason: noResultReason,
            });
            if (fallback.succeeded) {
              forgetPiContextTokenHint(sessionId);
              try { forgetPiContextTokenHint((entry.session as any)?.sessionManager?.getSessionId?.()); } catch { /* best-effort */ }
              runCtx.compactionSucceededThisTurn = true;
              sdkCompactionSucceededEventsThisTurn++;
              void appendTowerFileLedgerAfterCompaction(`sdk-no-result-local-fallback:${String((event as any).reason || 'compaction_end')}`);
              if (autoResumeRun) {
                // In auto-resume, a missing SDK result often means the summarizer
                // stream itself was truncated. The local fallback can reduce the
                // session file, but we should not show a cheery "done" divider and
                // end with an empty assistant turn. Persist a visible recoverable
                // notice that says the local recovery was applied, not that the
                // session is simply broken; the next user message can continue from
                // the compacted state.
                persistCompactionRecoveryNotice(noResultReason);
                result = { outcome: 'failed', succeeded: false, messages: [{ type: 'compact', sessionId, phase: 'failed' }] };
                console.warn(`[Pi] local fallback compaction created after SDK no-result during auto-resume; surfacing as recoverable local recovery: session=${sessionId.slice(0, 8)} compaction=${fallback.compactionId} before=${fallback.before} after=${fallback.after}`);
              } else {
                const markerId = currentCompactMarkerId || newCompactMarkerId();
                result = { outcome: 'compacted', succeeded: true, messages: [{ type: 'compact', sessionId, phase: 'done', markerId }] };
                console.warn(`[Pi] local fallback compaction created after SDK no-result compaction: session=${sessionId.slice(0, 8)} compaction=${fallback.compactionId} before=${fallback.before} after=${fallback.after}`);
              }
            } else {
              console.warn(`[Pi] local fallback compaction failed: session=${sessionId.slice(0, 8)} reason=${fallback.reason || 'unknown'}`);
            }
          }
          if (result.succeeded) {
            void appendTowerFileLedgerAfterCompaction(`sdk-event:${String((event as any).reason || 'compaction_end')}`);
            const markerId = currentCompactMarkerId || newCompactMarkerId();
            result = {
              ...result,
              messages: result.messages.map((m: any) =>
                m?.type === 'compact' && m.phase === 'done' && !m.markerId
                  ? { ...m, markerId }
                  : m
              ),
            };
          } else if (result.outcome === 'failed' && !compactionRecoveryNoticeSaved) {
            persistCompactionFailureNotice((event as any).errorMessage || `Pi compaction failed or produced no usable result (${(event as any).reason || 'unknown'})`);
          }
          if (visibleCompactionInProgress || !result.succeeded) {
            eventQueue.push(...result.messages);
          } else {
            console.warn(`[Pi] duplicate compaction_end suppressed from UI: session=${sessionId.slice(0, 8)} reason=${(event as any).reason}`);
          }
          visibleCompactionInProgress = false;
          currentCompactMarkerId = undefined;
          resolveWait?.();
          break;
        }

        // Steering queue changed. The SDK reports the *current* pending steer
        // texts; any text that dropped out since the last snapshot was just
        // consumed by the agent loop — i.e. the moment the AI actually
        // recognizes a mid-turn steer. Emit steer_delivered so the frontend
        // flips the bubble "전달 중" → "반영됨". See: GitHub issue #15.
        case 'queue_update': {
          const delivered = handlePiQueueUpdate({ event, entry, sessionId });
          if (delivered.length > 0) eventQueue.push(...delivered);
          resolveWait?.();
          break;
        }

        case 'message_end': {
          const msg = event.message;
          const analysis = analyzePiMessageEndCore({
            msg,
            previousStopReason: stopReason,
            accumulatorContent: accumulator.toTowerBlocks(),
          });
          const usage = analysis.usage;
          if (msg?.stopReason) {
            const errMsgLog = msg.stopReason === 'error' ? ` errorMessage=${JSON.stringify(msg.errorMessage || '')}` : '';
            console.log(`[Pi] message_end stopReason: session=${sessionId.slice(0, 8)} reason=${msg.stopReason} role=${msg?.role} contentLen=${Array.isArray(msg?.content) ? msg.content.length : 'n/a'}${errMsgLog}`);
          }
          // Don't let an empty error message overwrite a previous valid stopReason.
          // GPT models sometimes emit an empty final assistant message with stopReason=error
          // after successful tool-use iterations (e.g. context limit reached). Preserving the
          // prior stopReason (typically 'toolUse') gives a more accurate UX.
          const msgStopReason = analysis.msgStopReason;
          if (analysis.shouldApplyStopReason) {
            stopReason = msgStopReason;
          }

          // Surface Pi SDK / provider error messages to the user.
          // Without this, errors like Azure rate limits or context overflow appear
          // as silent "empty response" — user sees nothing actionable.
          if (analysis.providerErrorText) {
            const fullErrText = analysis.providerErrorText;
            const errText = fullErrText.slice(0, 500);
            const userErrText = formatPiProviderErrorForUser(fullErrText);
            const isPreflightOversized = isOversizedPreflightError(fullErrText);
            const isContextOverflow = isPiContextOverflowFailure(fullErrText);
            const isUpstreamRejectedInput = isPiUpstreamRejectedInputFailure(fullErrText);
            if (isPreflightOversized) {
              oversizedPreflightRecoveryRequested = true;
              oversizedPreflightMessage = fullErrText;
            } else if (isContextOverflow || isUpstreamRejectedInput) {
              providerErrorMustRemainError = true;
            }
            const currentProvider = entry.session.model?.provider;
            // Codex fallback fires on BOTH usage-limit and OAuth-invalidation
            // (the latter added 2026-05-30 — same ChatGPT account held by codex-lb
            // rotates our direct OAuth token). Both recover via the Azure chain.
            const isCodexUsageLimit = currentProvider === 'openai-codex' && isCodexUsageLimitError(fullErrText);
            const isCodexAuthInvalid = currentProvider === 'openai-codex' && isCodexAuthInvalidatedError(fullErrText);
            if (isCodexUsageLimit || isCodexAuthInvalid) {
              codexUsageLimitFallbackRequested = true;
              codexUsageLimitMessage = String(msg.errorMessage);
            }
            const operatorHint = formatPiProviderErrorForOperatorLog(fullErrText);
            const accountStatusLog = isPiModelAccountStatusFailure(fullErrText)
              ? ' userNotice="현재 모델 계정 인증/사용량 상태 문제" operatorAction="codex-lb reauth/plan/billing/usage-refresh 확인"'
              : '';
            console.warn(`[Pi] Provider error: session=${sessionId.slice(0, 8)} class=${classifyPiFailure(fullErrText).kind} operatorHint=${operatorHint}${accountStatusLog} error=${errText}`);

            // Phase 0 observation (per 2026-04-17 decision on Pi auto-compaction strategy).
            // When Pi returns a provider error we dump the signals needed to decide
            // whether compaction SDK's own threshold logic would have fired, plus raw
            // error details. Goal: confirm/refute the hypothesis that Azure's
            // "no details" error correlates with high context tokens.
            // Single JSON line so `grep "\[Pi] phase0"` gives a scannable ledger.
            try {
              const sess: any = entry.session;
              const agentMessages = sess?.agent?.state?.messages;
              const settings = sess?.settingsManager?.getCompactionSettings?.();
              const contextWindow = sess?.model?.contextWindow ?? null;
              const entries = sess?.sessionManager?.getEntries?.();
              // Two estimates, for cross-checking SDK behaviour:
              //  - sumEstimated: pessimistic, walks every message (estimateTokens is chars/4)
              //  - lastUsage: what the SDK primarily uses; undefined when no assistant usage
              let sumEstimated: number | null = null;
              if (Array.isArray(agentMessages)) {
                sumEstimated = 0;
                for (const m of agentMessages) sumEstimated += estimateTokens(m);
              }
              const lastUsage = Array.isArray(entries) ? getLastAssistantUsage(entries) : undefined;
              const lastUsageTokens = lastUsage ? calculateContextTokens(lastUsage) : null;
              const requestDebug = getPiResponsesRequestDebugInfo(sessionId);
              const requestBodyTokens = typeof requestDebug?.bodyEstimatedPromptTokens === 'number' ? requestDebug.bodyEstimatedPromptTokens : 0;
              const hintedTokens = getPiContextTokenHint(sessionId) || 0;
              const probeTokens = Math.max(
                typeof lastUsageTokens === 'number' ? lastUsageTokens : 0,
                sumEstimated ?? 0,
                requestBodyTokens,
                hintedTokens,
              );
              const wouldCompactByThreshold = settings && typeof contextWindow === 'number'
                ? shouldCompact(probeTokens, contextWindow, settings)
                : null;
              const obs = {
                sessionId: sessionId.slice(0, 8),
                runId: runCorrelationId.slice(0, 8),
                model: { provider: sess?.model?.provider, id: sess?.model?.id, contextWindow },
                errorMessage: String(msg.errorMessage),      // full, untruncated
                errorClass: {
                  contextOverflow: isPiContextOverflowFailure(fullErrText),
                  upstreamRejectedInput: isPiUpstreamRejectedInputFailure(fullErrText),
                  transientTransport: isPiTransientAbortError(fullErrText),
                },
                sumEstimatedTokens: sumEstimated,            // chars/4 sum across all agent messages
                lastUsageTokens,                              // tokens from last assistant usage (SDK's primary signal)
                settings,                                     // enabled / reserveTokens / keepRecentTokens
                wouldCompactByThreshold,                      // would SDK have fired compaction at this moment?
                entryCount: Array.isArray(entries) ? entries.length : null,
                messageCount: Array.isArray(agentMessages) ? agentMessages.length : null,
                cumulativeInput,
                cumulativeOutput,
                iterationCount,
                usageFromThisMessage: usage ?? null,
                requestDebug: requestDebug ? {
                  ageMs: Date.now() - requestDebug.ts,
                  towerCorrelation: requestDebug.towerCorrelation,
                  model: requestDebug.model,
                  promptCacheKey: requestDebug.promptCacheKey ? requestDebug.promptCacheKey.slice(0, 16) : undefined,
                  previousResponseId: requestDebug.previousResponseId ? requestDebug.previousResponseId.slice(0, 16) : undefined,
                  inputItems: requestDebug.inputItems,
                  inputTypes: requestDebug.inputTypes,
                  toolCount: requestDebug.toolCount,
                  maxOutputTokens: requestDebug.maxOutputTokens,
                  bodyEstimatedPromptTokens: requestDebug.bodyEstimatedPromptTokens,
                  contextHintTokens: requestDebug.contextHintTokens,
                  requestBodyBytes: requestDebug.requestBodyBytes,
                  hasReasoning: requestDebug.hasReasoning,
                  parallelToolCalls: requestDebug.parallelToolCalls,
                } : null,
              };
              console.warn(`[Pi] phase0 observation ${JSON.stringify(obs)}`);
            } catch (obsErr: any) {
              console.warn(`[Pi] phase0 observation failed: ${obsErr?.message || obsErr}`);
            }

            if (!isCodexUsageLimit && !isCodexAuthInvalid) {
              if (isPreflightOversized) {
                console.warn(`[Pi] oversized preflight blocked upstream; will attempt compaction recovery: session=${sessionId.slice(0, 8)} error=${errText}`);
              } else {
                const isTransientAbort = isPiTransientAbortError(fullErrText);
                const shouldAutoRetryTransient = isTransientAbort && canAutoRetryTransientAbort();
                if (shouldAutoRetryTransient) {
                  transientAbortRetryRequested = true;
                  transientAbortRetryMessage = fullErrText;
                  console.warn(`[Pi] transient abort detected in message_end; deferring visible error for auto-retry: session=${sessionId.slice(0, 8)} error=${errText}`);
                } else if (isTransientAbort) {
                  suppressTransientAbortVisibleError('message_end', fullErrText);
                } else {
                  eventQueue.push({
                    type: 'engine_error',
                    sessionId,
                    message: `Pi 모델 응답 오류: ${userErrText}`,
                    recoverable: true,
                    retryable: false,
                  });
                  providerErrorVisibleSurfacedThisTurn = true;
                }
              }
            }
          }

          if (analysis.assistantContent) {
            const { contentToSave } = analysis.assistantContent;
            // A transient error frame does not always terminate the SDK run. The
            // same prompt can continue and emit later toolUse/stop frames. Once a
            // newer non-error assistant boundary arrives, the delayed retry is
            // stale; executing it would ask the model to summarize the completed
            // work again and create duplicate final answers.
            if (msgStopReason !== 'error' && transientAbortRetryRequested) {
              console.warn(`[Pi] cancelling stale transient retry after newer assistant progress: session=${sessionId.slice(0, 8)} recoveredStop=${msgStopReason ?? 'none'}`);
              transientAbortRetryRequested = false;
              transientAbortRetryMessage = '';
              providerErrorMustRemainError = false;
            }
            // Responses may stream the visible final text through message_update,
            // then finish with an empty message_end payload. In that case the
            // accumulator-backed contentToSave is the user-visible truth. Using
            // finalContent alone leaves telemetry stuck on the previous tool_use,
            // so terminalization falsely reports "completed without final text"
            // even though the final answer was saved and broadcast.
            if (contentToSave.length > 0) {
              lastAssistantTelemetry = summarizeAssistantContinuationIntent({
                stopReason: msgStopReason,
                content: contentToSave,
              });
            }
            // Only replace if the new content is non-empty.
            // GPT models sometimes emit an empty final assistant message after tool use,
            // and replaceAll([]) would wipe the previous tool-use blocks from the accumulator.
            if (analysis.assistantContent.shouldReplaceAccumulator) {
              accumulator.replaceAll(analysis.assistantContent.finalContent);
            }
            // Skip saving an empty assistant message — avoids the "empty bubble with stopReason footer"
            // UX where the turn ends silently. Usage accounting still runs below.
            if (contentToSave.length > 0) {
              if (!assistantSaved) {
                trackDbWrite(callbacks.saveMessage({ id: msgId, role: 'assistant', content: contentToSave }));
                assistantSaved = true;
                lastSavedAssistantMsgId = msgId;
                rememberAssistantMsgId(msgId);
              } else {
                queueAssistantDbUpdate(msgId, contentToSave, true);
              }
              // message_end is a lifecycle boundary: flush immediately so the
              // final visible assistant snapshot lands before metrics/msgId reset.
              queueAssistantEvent(contentToSave, true);
            }
          }

          if (usage) {
            const contextTokensForHint = calculateContextTokens(usage as any);
            rememberPiContextTokenHint(sessionId, contextTokensForHint);
            try {
              rememberPiContextTokenHint((entry.session as any)?.sessionManager?.getSessionId?.(), contextTokensForHint);
            } catch { /* best-effort */ }
            // PiRunContext owns usage accumulation; keep local mirrors until the
            // remaining terminal state machine moves behind the context boundary.
            const usageDelta = runCtx.recordUsage(usage);
            const iterInput = usageDelta.input;
            const iterOutput = usageDelta.output;
            const iterCacheRead = usageDelta.cacheRead;
            const iterCacheWrite = usageDelta.cacheWrite;
            const iterReasoning = usageDelta.reasoning;
            const iterCostUsd = usageDelta.costUsd;
            // Log full usage for GPT-5 reasoning-token diagnosis.
            // Azure's reasoning_tokens aren't always in usage.output, so we dump
            // the raw object to catch any provider-specific fields.
            if (msgStopReason === 'error' || iterOutput > 1000) {
              console.log(`[Pi] usage detail: session=${sessionId.slice(0, 8)} iter=${iterationCount} usage=${JSON.stringify(usage)}`);
            }
            iterationCount = runCtx.iterationCount;
            cumulativeInput = runCtx.cumulativeInput;
            cumulativeOutput = runCtx.cumulativeOutput;
            cumulativeCacheRead = runCtx.cumulativeCacheRead;
            cumulativeCacheWrite = runCtx.cumulativeCacheWrite;
            cumulativeReasoning = runCtx.cumulativeReasoning;
            cumulativeCostUsd = runCtx.cumulativeCostUsd;
            lastIterationInput = runCtx.lastIterationInput;
            lastIterationOutput = runCtx.lastIterationOutput;
            lastIterationCacheRead = runCtx.lastIterationCacheRead;
            lastIterationCacheWrite = runCtx.lastIterationCacheWrite;
            lastIterationReasoning = runCtx.lastIterationReasoning;
            lastCostUsd = runCtx.lastCostUsd;
          }

          // 2026-05-17 — iteration 별 별개 row 분리.
          // 한 prompt() 안에서 agent-loop 가 (assistant → tool_use →
          // tool_result → assistant → ...) multi-iteration 으로 진행될 때,
          // 이전엔 모두 같은 msgId 에 덮어쓰면서 마지막 짧은 답만 남고
          // 중간 tool calls 트레이스가 손실되었음. 매 assistant message_end
          // 후 새 msgId + 빈 accumulator + assistantSaved=false 로 리셋해서
          // 다음 iter 가 깨끗한 새 DB row 에 시작하도록 함.
          // 결정: workspace/decisions/2026-05-17-pi-engine-iteration-msgid.md
          if (msg?.role === 'assistant') {
            // 이 iter 의 metrics 를 *이 iter 의 msgId* 에 즉시 박기 (reset 전).
            // emitTurnDone() 의 updateMessageMetrics 는 prompt() 끝에만 한 번
            // 호출되어 reset 이후의 빈 msgId 에 noop 되니, 매 iter 의 metric 을
            // 여기서 처리해야 정합적.
            if (assistantSaved && usage) {
              const iterDuration = Date.now() - turnStartTime;
              trackDbWrite(callbacks.updateMessageMetrics(msgId, {
                durationMs: iterDuration,
                inputTokens: lastIterationInput,
                outputTokens: lastIterationOutput,
                // Persist cache breakdown to messages.metadata.usage (jsonb)
                // via message-store.updateMessageMetrics. Zero values are
                // skipped server-side, so non-caching providers stay clean.
                cacheReadTokens: lastIterationCacheRead,
                cacheCreationTokens: lastIterationCacheWrite,
                reasoningTokens: lastIterationReasoning,
                costUsd: lastCostUsd,
              }));
            }
            runCtx.rotateAssistantIteration();
            msgId = runCtx.msgId;
            accumulator = runCtx.accumulator;
            assistantSaved = false;
          }
          resolveWait?.();
          break;
        }

        // 2026-05-16 silent-exit root cause:
        // When `_runLoop` in pi-agent-core (agent.js:378-400) catches an error
        // from streamAssistantResponse (auth, transport, malformed request, etc.),
        // it emits ONLY `agent_end` with errorMsg.errorMessage carrying the real
        // cause — NO message_start/end for the assistant, NO turn_end. Without
        // this case the error vanishes: prompt() resolves with iterations=0 and
        // the user sees a session that never replies.
        //
        // Signature (spawn-rpc case 2026-05-16):
        //   agent_start → turn_start → message_start(user) → message_end(user) → agent_end
        // (notice no assistant message_start / message_end).
        case 'agent_end': {
          let agentEndCarriedError = false;
          let agentEndIsCodexUsageLimit = false;
          let agentEndIsTransientAbort = false;
          let agentEndIsTransientRetry = false;
          let agentEndNeedsOverflowSettle = false;
          try {
            const analysis = analyzePiAgentEndError({
              messages: (event as any).messages || [],
              provider: entry.session.model?.provider,
              isCodexUsageLimitError,
              isCodexAuthInvalidatedError,
              isPiTransientAbortError,
              canAutoRetryTransientAbort,
            });
            if (analysis) {
              if (analysis.isCodexUsageLimit || analysis.isCodexAuthInvalid) {
                codexUsageLimitFallbackRequested = true;
                codexUsageLimitMessage = analysis.fullErrText;
                agentEndIsCodexUsageLimit = true;
              }
              const isPreflightOversized = isOversizedPreflightError(analysis.fullErrText);
              const isContextOverflow = isPiContextOverflowFailure(analysis.fullErrText);
              const isUpstreamRejectedInput = isPiUpstreamRejectedInputFailure(analysis.fullErrText);
              if (isPreflightOversized) {
                oversizedPreflightRecoveryRequested = true;
                oversizedPreflightMessage = analysis.fullErrText;
              } else if (isContextOverflow || isUpstreamRejectedInput) {
                providerErrorMustRemainError = true;
              }
              // Preflight oversized errors can start SDK compaction asynchronously.
              // Do not use the short agent_end error terminalizer here: it can fire
              // before compaction_end and surface a false "오류로 종료" while the SDK
              // is still doing the recovery work.
              agentEndNeedsOverflowSettle = isPreflightOversized || isContextOverflow || isUpstreamRejectedInput || overflowCompactionInProgress || overflowCompactionObservedThisTurn;
              const userErrText = formatPiProviderErrorForUser(analysis.fullErrText);
              const operatorHint = formatPiProviderErrorForOperatorLog(analysis.fullErrText);
              const accountStatusLog = isPiModelAccountStatusFailure(analysis.fullErrText)
                ? ' userNotice="현재 모델 계정 인증/사용량 상태 문제" operatorAction="codex-lb reauth/plan/billing/usage-refresh 확인"'
                : '';
              console.warn(`[Pi] agent_end carried error (no message_end fired): session=${sessionId.slice(0, 8)} stopReason=${analysis.stopReason} class=${classifyPiFailure(analysis.fullErrText).kind} operatorHint=${operatorHint}${accountStatusLog} errorMessage=${analysis.errText}`);
              if (isContextOverflow || isUpstreamRejectedInput) {
                const requestDebug = getPiResponsesRequestDebugInfo(sessionId);
                console.warn(`[Pi] agent_end provider rejection observation ${JSON.stringify({
                  sessionId: sessionId.slice(0, 8),
                  runId: runCorrelationId.slice(0, 8),
                  errorClass: { contextOverflow: isContextOverflow, upstreamRejectedInput: isUpstreamRejectedInput },
                  requestDebug: requestDebug ? {
                    ageMs: Date.now() - requestDebug.ts,
                    towerCorrelation: requestDebug.towerCorrelation,
                    model: requestDebug.model,
                    promptCacheKey: requestDebug.promptCacheKey ? requestDebug.promptCacheKey.slice(0, 16) : undefined,
                    previousResponseId: requestDebug.previousResponseId ? requestDebug.previousResponseId.slice(0, 16) : undefined,
                    inputItems: requestDebug.inputItems,
                    inputTypes: requestDebug.inputTypes,
                    toolCount: requestDebug.toolCount,
                    maxOutputTokens: requestDebug.maxOutputTokens,
                    bodyEstimatedPromptTokens: requestDebug.bodyEstimatedPromptTokens,
                    contextHintTokens: requestDebug.contextHintTokens,
                    requestBodyBytes: requestDebug.requestBodyBytes,
                    hasReasoning: requestDebug.hasReasoning,
                    parallelToolCalls: requestDebug.parallelToolCalls,
                  } : null,
                })}`);
              }
              stopReason = 'error';
              agentEndCarriedError = true;
              // Codex usage-limit AND auth-invalidation both route to the model
              // fallback chain, not the transient auto-retry path (retrying the
              // same dead OAuth token would just fail again).
              if (!analysis.isCodexUsageLimit && !analysis.isCodexAuthInvalid) {
                agentEndIsTransientAbort = analysis.isTransientAbort;
                if (isPreflightOversized) {
                  console.warn(`[Pi] oversized preflight blocked upstream in agent_end; will attempt compaction recovery: session=${sessionId.slice(0, 8)} error=${analysis.errText}`);
                } else if (analysis.shouldAutoRetryTransient) {
                  transientAbortRetryRequested = true;
                  transientAbortRetryMessage = analysis.fullErrText;
                  agentEndIsTransientRetry = true;
                  console.warn(`[Pi] transient abort detected in agent_end; deferring visible error for auto-retry: session=${sessionId.slice(0, 8)} error=${analysis.errText}`);
                } else if (analysis.isTransientAbort) {
                  suppressTransientAbortVisibleError('agent_end', analysis.fullErrText);
                } else if (!providerErrorVisibleSurfacedThisTurn) {
                  eventQueue.push({
                    type: 'engine_error',
                    sessionId,
                    message: `Pi 모델 응답 오류 (agent_end): ${userErrText}`,
                    recoverable: true,
                    retryable: false,
                  });
                  providerErrorVisibleSurfacedThisTurn = true;
                  // Also save a visible assistant message so the user sees something
                  if (!assistantSaved) {
                    trackDbWrite(callbacks.saveMessage({
                      id: msgId,
                      role: 'assistant',
                      content: [{ type: 'text', text: `⚠️ ${userErrText}` }],
                    }));
                    assistantSaved = true;
                    lastSavedAssistantMsgId = msgId;
                    rememberAssistantMsgId(msgId);
                  }
                } else {
                  console.warn(`[Pi] suppressing duplicate agent_end provider error: session=${sessionId.slice(0, 8)} error=${analysis.errText}`);
                }
              }
            }
          } catch (handlerErr: any) {
            console.warn(`[Pi] agent_end handler failed: ${handlerErr?.message || handlerErr}`);
          }
          // Safety net (issue #38): when agent_end carries an error, the SDK's
          // _runLoop catch path skipped message_end and turn_end. If prompt()
          // also fails to settle (race observed in codex SSE terminated cases),
          // neither `.then` nor `.catch` fires emitTurnDone → frontend stays
          // stuck on "응답 준비 중" / sidebar "run" badge forever.
          //
          // Schedule a fallback that fires turn_done after 5s if prompt()
          // hasn't settled by then. The once-guard inside emitTurnDone makes
          // this safe even if `.then`/`.catch` eventually wins the race.
          // Skip for codex usage-limit fallback path — that branch deliberately
          // continues into a second prompt() and expects normal turn_done flow.
          if (agentEndCarriedError && !agentEndIsCodexUsageLimit && !agentEndIsTransientRetry && !transientAbortRetryRequested) {
            if (agentEndIsTransientAbort || transientAbortVisibleSuppressed) {
              // Post-side-effect transport drops are already classified as transient
              // and must not use the aggressive 5s agent_end zombie terminalizer: in
              // production this prematurely killed otherwise-settling Pi prompts after
              // a tool loop. Let the normal closing terminalizer give the SDK its
              // configured settle window, and force-close as aborted if it is truly dead.
              markClosing('agent_end-transient-transport', 'aborted');
            } else {
              const settleMs = agentEndNeedsOverflowSettle ? OVERFLOW_COMPACTION_SETTLE_MS : AGENT_END_ERROR_TERMINALIZE_MS;
              const settleWhy = agentEndNeedsOverflowSettle ? 'agent_end-context-overflow-settle' : 'agent_end-carried-error';
              markClosing(settleWhy, 'error', settleMs);
              clearAgentEndTerminalizer();
              agentEndTerminalizerTimer = setTimeout(() => {
                agentEndTerminalizerTimer = null;
                if (!promptSettled && !terminalizer.isTerminalForced && !transientAbortRetryRequested) {
                  console.warn(`[Pi] terminalizer firing (agent_end carried error, prompt() did not settle within ${settleMs}ms): session=${sessionId.slice(0, 8)} overflowSettle=${agentEndNeedsOverflowSettle}`);
                  forceTerminalizeRun(
                    agentEndNeedsOverflowSettle ? 'agent_end-context-overflow-settle-stuck' : 'agent_end-carried-error-stuck',
                    'error',
                  ).catch((e: any) => {
                    console.warn(`[Pi] terminalizer failed: ${e?.message || e}`);
                  });
                }
              }, settleMs);
            }
          }
          resolveWait?.();
          break;
        }
      }
    });

    const editedFiles = new Set<string>();

    // 4. Execute prompt
    //
    // turn_done contract: ALWAYS emit exactly one turn_done per prompt, regardless of
    // whether Pi SDK fired message_end with usage. Without this, turns that produced no
    // usage event (e.g. short answers, aborts, SDK hiccups) leave the frontend's
    // turn-metrics state stale and can leave sessions stuck in "streaming" UI because
    // the Inbox relies on turn completion + updatedAt bump to show cards.
    // (See 2026-04-11 Pi real-time update bug.)
    const estimateLiveContextTokens = (): number => {
      try {
        const agentMessages = (entry.session as any)?.agent?.state?.messages;
        const messageEstimate = Array.isArray(agentMessages)
          ? agentMessages.reduce((sum: number, m: unknown) => sum + estimateTokens(m as any), 0) + (entry.promptStaticTokenEstimate || 0)
          : 0;
        const requestDebug = getPiResponsesRequestDebugInfo(sessionId);
        const requestBodyEstimate = typeof requestDebug?.bodyEstimatedPromptTokens === 'number'
          ? requestDebug.bodyEstimatedPromptTokens
          : 0;
        const hintedEstimate = getPiContextTokenHint(sessionId) || 0;
        return Math.max(messageEstimate, requestBodyEstimate, hintedEstimate);
      } catch {
        return 0;
      }
    };

    let promptSettled = false;
    const terminalizer = new PiRunTerminalizer({
      sessionId,
      runCtx,
      acceptedAt: opts.acceptedAt,
      workLedgerTurnStartedAt: opts.acceptedAt || new Date(runCtx.turnStartTime).toISOString(),
      callbacks,
      eventQueue,
      modelLabel: () => `${entry.session.model?.provider}/${entry.session.model?.id}`,
      getState: () => ({
        stopReason,
        assistantSaved,
        currentMsgId: msgId,
        lastSavedAssistantMsgId,
        iterationCount,
        lastIterationInput,
        lastIterationOutput,
        lastIterationCacheRead,
        lastIterationCacheWrite,
        lastIterationReasoning,
        lastCostUsd,
        watchdogAborted,
        transientAbortVisibleSuppressed,
        toolCallsForTelemetry,
        autoResume: autoResumeRun,
        autoResumeReason,
        queueLenBeforeDone: eventQueue.length,
        oversizedPreflightRecoveryRequested,
        compactionSucceededThisTurn: runCtx.compactionSucceededThisTurn,
        lastAssistant: lastAssistantTelemetry,
      }),
      estimateLiveContextTokens,
      flushAssistantEvent,
      flushAssistantDbUpdate,
      flushDbWrites,
      trackDbWrite,
      markClosing,
      abortSession: () => { try { entry.session.abort(); } catch { /* best-effort */ } },
      setDone: () => { done = true; },
      wakeYieldLoop: () => resolveWait?.(),
      beforeTowerTerminal: () => lifecycleShadow.observeTowerTerminal(Boolean(entry.session.isIdle)),
    });
    const emitTurnDone = (errorStopReason?: 'error' | 'aborted') => terminalizer.emitTurnDone(errorStopReason);
    const forceTerminalizeRun = (why: string, stop: 'error' | 'aborted' = 'error') => terminalizer.forceTerminalizeRun(why, stop);

    console.log(`[Pi] prompt() calling: session=${sessionId.slice(0, 8)}`);
    // The SDK is now accepting steers. Steers arriving from here on go straight
    // to the SDK; the startup-window buffer is flushed just below, right after
    // prompt() begins.
    entry.runPhase = 'running';
    entry.promptActive = true;

    const surfaceWatchdogAbort = async () => {
      const reason = formatWatchdogReason(watchdogAborted!, STREAM_IDLE_MS, BLOCK_TIMEOUT_MS);
      const watchdogNote: any = { type: 'text', text: `⚠️ Pi 스트림 watchdog: ${reason}`, watchdogReason: watchdogAborted };
      eventQueue.push({
        type: 'engine_error',
        sessionId,
        message: `⚠️ Pi 스트림 watchdog: ${reason}`,
        recoverable: true,
      });
      // Persist the reason to messages DB so it survives reloads + appears
      // in session history. Without this, the engine_error toast above is
      // the only trace and the next viewer sees an unexplained silent stop.
      // If a partial assistant row already exists, append the watchdog note to
      // that row instead of dropping the reason just because assistantSaved=true.
      // Refs: workspace/decisions/2026-05-26-pi-sdk-upgrade-policy.md (Test 2),
      //       incident 474d2679-033f-45d0-918e-52fbc67b9975, issue #22.
      if (!assistantSaved) {
        trackDbWrite(callbacks.saveMessage({
          id: msgId,
          role: 'assistant',
          content: [watchdogNote],
        }));
        assistantSaved = true;
        lastSavedAssistantMsgId = msgId;
        rememberAssistantMsgId(msgId);
      } else {
        const pendingDbUpdate = coalescer.getPendingAssistantDbUpdate();
        const currentContent = pendingDbUpdate?.msgId === msgId
          ? pendingDbUpdate.content
          : accumulator.toTowerBlocks();
        const contentWithReason = [...currentContent, watchdogNote];
        coalescer.clearPendingAssistantDbUpdate();
        coalescer.clearAssistantDbTimer();
        trackDbWrite(callbacks.updateMessageContent(msgId, contentWithReason));
        queueAssistantEvent(contentWithReason, true);
      }
    };

    const surfaceTransientAbortFailure = async (retryMax = getTransientAbortRetryMax(transientAbortRetryMessage)) => {
      const message = transientAbortRetryMessage || 'Request was aborted';
      transientAbortVisibleSuppressed = true;
      stopReason = 'aborted';
      if (entry.abortRequested) {
        // User stop is a normal control result. The authoritative turn_terminal
        // projection renders one neutral chat status box; do not also persist an
        // assistant warning or emit an engine_error toast.
        console.log(`[Pi] user stop settled without transient failure notice: session=${sessionId.slice(0, 8)}`);
        return;
      }
      const failureKind = classifyPiFailure(message).kind;
      const isProviderCapacity = failureKind === 'provider_capacity';
      const noticeText = isProviderCapacity ? PROVIDER_CAPACITY_EXHAUSTED_NOTICE_TEXT : TRANSIENT_ABORT_EXHAUSTED_NOTICE_TEXT;
      persistTerminalTransientNotice(noticeText);
      eventQueue.push({
        type: 'engine_error',
        sessionId,
        message: noticeText,
        recoverable: true,
        retryable: true,
      });
      await flushDbWrites();
      console.warn(`[Pi] transient/provider retryable auto-retry exhausted; persisted terminal notice in current turn: session=${sessionId.slice(0, 8)} attempts=${transientAbortRetryAttempts}/${retryMax} kind=${failureKind} error=${message.slice(0, 180)}`);
    };

    const runTransientRetriesIfNeeded = async (): Promise<boolean> => {
      const ownership = decidePiRetryOwnership(sdkRetryObservedThisRun);
      if (!ownership.towerRetryAllowed) {
        if (transientAbortRetryRequested) {
          console.warn(`[Pi] suppressing Tower retry after SDK ownership: session=${sessionId.slice(0, 8)} reason=${ownership.reason}`);
        }
        transientAbortRetryRequested = false;
        transientAbortRetryMessage = '';
        return true;
      }
      while (transientAbortRetryRequested && !entry.abortRequested && !watchdogAborted) {
        const retryMax = getTransientAbortRetryMax(transientAbortRetryMessage);
        if (transientAbortRetryAttempts >= retryMax) {
          await surfaceTransientAbortFailure();
          return false;
        }
        const retryUsesOriginalPrompt = !assistantSaved && iterationCount === 0 && toolCallsForTelemetry === 0;
        if (!retryUsesOriginalPrompt && transientAbortRetryAttempts > 0) {
          await surfaceTransientAbortFailure();
          return false;
        }
        transientAbortRetryAttempts++;
        const attempt = transientAbortRetryAttempts;
        const delayMs = getTransientAbortRetryDelayMs(transientAbortRetryMessage, attempt);
        const errText = transientAbortRetryMessage.slice(0, 160);
        console.warn(`[Pi] auto-retry transient/provider retryable error (${attempt}/${retryMax}) after ${delayMs}ms: session=${sessionId.slice(0, 8)} mode=${retryUsesOriginalPrompt ? 'replay' : 'continuation'} err=${errText}`);
        transientAbortRetryRequested = false;
        stopReason = undefined;
        clearClosingTerminalizer();
        clearAgentEndTerminalizer();
        entry.runPhase = 'running';
        entry.promptActive = true;
        await sleep(delayMs);
        try {
          if (retryUsesOriginalPrompt) {
            await promptWithFetchCorrelation(prompt);
          } else {
            const recoveryState = inspectPiRecoveryState(entry.session);
            const recoveryDecision = decidePiContinuationRecovery(recoveryState);
            console.log(`[Pi] transient retry primitive: session=${sessionId.slice(0, 8)} attempt=${attempt}/${retryMax} leafRole=${recoveryState.leafRole} queued=${recoveryState.queuedMessages} action=${recoveryDecision.action} reason=${recoveryDecision.reason}`);
            if (recoveryDecision.action === 'native_continue') {
              await continueWithPiNativeLifecycle('transient retry after started work');
            } else if (recoveryDecision.action === 'recovery_prompt') {
              await promptWithFetchCorrelation(TRANSIENT_INTERRUPTION_RECOVERY_PROMPT);
            } else {
              await surfaceTransientAbortFailure(retryMax);
              return false;
            }
          }
        } catch (retryErr: any) {
          const retryMessage = retryErr?.message || 'Pi prompt failed';
          if (isPiTransientAbortError(retryMessage) && !entry.abortRequested && !watchdogAborted) {
            transientAbortRetryRequested = true;
            transientAbortRetryMessage = retryMessage;
            continue;
          }
          throw retryErr;
        }
      }
      return true;
    };

    const compactSessionBeforePromptIfNeeded = async (source: string): Promise<boolean> => {
      const decision = shouldProactivelyCompactPiSession({
        session: entry.session as any,
        towerSessionId: sessionId,
        promptStaticTokenEstimate: entry.promptStaticTokenEstimate,
        compactionSucceededThisTurn: runCtx.compactionSucceededThisTurn,
        overflowCompactionInProgress,
      });
      if (!decision.shouldCompact) {
        if (decision.shouldAdvise) {
          console.warn(`[Pi] compaction advisory before prompt: session=${sessionId.slice(0, 8)} source=${source} pressure=${decision.pressure.toFixed(3)} probe=${decision.probeTokens}/${decision.contextWindow} trigger=${decision.triggerSource} auth=${decision.authoritativeTokens} risk=${decision.riskProbeTokens} riskSource=${decision.riskProbeSource} riskAccepted=${decision.riskProbeAccepted} riskInflated=${decision.riskProbeInflated} lastUsage=${decision.lastUsageTokens} messageEstimate=${decision.messageEstimate} requestBody=${decision.requestBodyTokens} towerHint=${decision.hintedTokens} sdkHint=${decision.sdkSessionHint} sdkWouldCompact=${decision.sdkWouldCompact} execution=disabled-env`);
        }
        return false;
      }

      console.warn(`[Pi] Tower proactive compaction before prompt: session=${sessionId.slice(0, 8)} source=${source} reason=${decision.compactionReason} pressure=${decision.pressure.toFixed(3)} probe=${decision.probeTokens}/${decision.contextWindow} trigger=${decision.triggerSource} auth=${decision.authoritativeTokens} risk=${decision.riskProbeTokens} riskSource=${decision.riskProbeSource} riskAccepted=${decision.riskProbeAccepted} riskInflated=${decision.riskProbeInflated} lastUsage=${decision.lastUsageTokens} messageEstimate=${decision.messageEstimate} requestBody=${decision.requestBodyTokens} towerHint=${decision.hintedTokens} sdkHint=${decision.sdkSessionHint} sdkWouldCompact=${decision.sdkWouldCompact}`);
      emitRecoveryCompactStart(`proactive-${source}`);
      const originalModel = entry.session.model;
      let compactionFallbackSpec = '';
      try {
        if (originalModel?.provider === 'litellm-responses') {
          for (const spec of getCodexFallbackModelSpecs()) {
            const fallbackModel = this.modelRegistryManager.resolvePiModel(spec);
            if (!fallbackModel) continue;
            compactionFallbackSpec = spec;
            console.warn(`[Pi] proactive compaction: using fallback ${spec} for compaction session=${sessionId.slice(0, 8)}`);
            await entry.session.setModel(fallbackModel);
            break;
          }
        }
        await entry.session.compact('The session is close to the model context limit. Summarize prior work aggressively before the next request, preserving current task state, edited files, decisions, and exact next steps.');
        const manager = (entry.session as any)?.sessionManager;
        const persistedCompactionCount = countPiCompactionEntries(manager);
        if (persistedCompactionCount > compactionEntriesAtRunStart) {
          forgetPiContextTokenHint(sessionId);
          try { forgetPiContextTokenHint((entry.session as any)?.sessionManager?.getSessionId?.()); } catch { /* best-effort */ }
          runCtx.compactionSucceededThisTurn = true;
          if (persistedCompactionCount > compactionEntriesAtRunStart + sdkCompactionSucceededEventsThisTurn) {
            sdkCompactionSucceededEventsThisTurn++;
          } else {
            console.warn(`[Pi] proactive compaction: reusing compaction already recorded by SDK event session=${sessionId.slice(0, 8)} before=${compactionEntriesAtRunStart} current=${persistedCompactionCount} events=${sdkCompactionSucceededEventsThisTurn}`);
          }
          emitRecoveryCompactDoneIfNeeded(`proactive-${source}`);
          await appendTowerFileLedgerAfterCompaction(`proactive:${source}`);
          return true;
        }

        const fallback = createPiLocalFallbackCompaction({
          session: manager,
          agent: (entry.session as any)?.agent,
          reason: 'proactive compact() returned without persisting a compaction entry',
        });
        if (!fallback.succeeded) {
          throw new Error(`Pi proactive compact() returned without persisting a compaction entry; local fallback failed: ${fallback.reason || 'unknown'}`);
        }
        forgetPiContextTokenHint(sessionId);
        try { forgetPiContextTokenHint((entry.session as any)?.sessionManager?.getSessionId?.()); } catch { /* best-effort */ }
        runCtx.compactionSucceededThisTurn = true;
        sdkCompactionSucceededEventsThisTurn++;
        emitRecoveryCompactDoneIfNeeded(`proactive-${source}-local-fallback`);
        await appendTowerFileLedgerAfterCompaction(`proactive-local-fallback:${source}`);
        console.warn(`[Pi] local fallback compaction created after proactive compact() no-persist: session=${sessionId.slice(0, 8)} compaction=${fallback.compactionId} before=${fallback.before} after=${fallback.after}`);
        return true;
      } catch (compactErr: any) {
        const compactMessage = compactErr?.message || String(compactErr || 'unknown');
        if (isPiCompactionNoOpMessage(compactMessage)) {
          emitRecoveryCompactSkippedIfNeeded('proactive-noop');
          console.log(`[Pi] proactive compaction skipped; continuing original prompt: session=${sessionId.slice(0, 8)} reason=${compactMessage.slice(0, 180)}`);
          return false;
        }
        throw compactErr;
      } finally {
        if (compactionFallbackSpec && originalModel && !entry.abortRequested) {
          try {
            await entry.session.setModel(originalModel);
            console.warn(`[Pi] proactive compaction: restored model ${originalModel.provider}/${originalModel.id} after compaction session=${sessionId.slice(0, 8)}`);
          } catch (restoreErr: any) {
            console.warn(`[Pi] proactive compaction: model restore failed session=${sessionId.slice(0, 8)} error=${restoreErr?.message || restoreErr}`);
          }
        }
      }
    };

    const shouldAttemptPostCompactContinuation = (requireCompaction = true) =>
      (!requireCompaction || runCtx.compactionSucceededThisTurn) &&
      !postCompactContinuationAttempted &&
      !entry.abortRequested &&
      !watchdogAborted;

    const hasDurableAssistantResult = () => Boolean(lastSavedAssistantMsgId || assistantSaved);

    const hasDurableFinalAssistantText = () => Boolean(
      hasDurableAssistantResult()
      && lastAssistantTelemetry?.textTail
      && lastAssistantTelemetry.textTail.trim().length > 0,
    );

    const clearSuccessfulOversizedRecoveryIfPossible = (params: {
      source: string;
      allowNoopWithoutCompaction?: boolean;
    }): boolean => {
      const compactionEvidence = runCtx.compactionSucceededThisTurn || Boolean(params.allowNoopWithoutCompaction);
      if (!compactionEvidence) return false;
      if (stopReason !== 'stop') return false;
      if (!hasDurableFinalAssistantText()) return false;
      oversizedPreflightRecoveryRequested = false;
      oversizedPreflightMessage = '';
      providerErrorMustRemainError = false;
      clearClosingTerminalizer();
      clearAgentEndTerminalizer();
      console.warn(`[Pi] oversized preflight recovery: completed after recovery despite earlier overflow session=${sessionId.slice(0, 8)} source=${params.source}`);
      return true;
    };

    const runPostCompactContinuationOnce = async (source: string, options?: { requireCompaction?: boolean }): Promise<boolean> => {
      if (!shouldAttemptPostCompactContinuation(options?.requireCompaction ?? true)) return false;
      const recoveryState = inspectPiRecoveryState(entry.session);
      const recoveryDecision = decidePiContinuationRecovery(recoveryState);
      console.log(`[Pi] recovery primitive: session=${sessionId.slice(0, 8)} trigger=post_compact source=${source} leafRole=${recoveryState.leafRole} queued=${recoveryState.queuedMessages} action=${recoveryDecision.action} reason=${recoveryDecision.reason}`);
      if (recoveryDecision.action !== 'native_continue') return false;
      postCompactContinuationAttempted = true;
      return runContinuationRecovery({
        trigger: 'post_compact',
        source,
        failureMessage: 'Pi post-compact continuation failed',
        logStart: `[Pi] post-compact continuation after abnormal interruption: session=${sessionId.slice(0, 8)} source=${source}`,
      });
    };

    const shouldAttemptTransientContinuation = () =>
      !transientContinuationAttempted &&
      !entry.abortRequested &&
      !watchdogAborted &&
      // Only use continuation once real assistant/tool work has started. A saved
      // transient-failure notice alone must not trick Tower into sending a
      // continuation prompt for a request that never actually began.
      (iterationCount > 0 || toolCallsForTelemetry > 0 || (assistantSaved && !transientAbortFailureNoticeSaved));

    const runTransientContinuationOnce = async (source: string): Promise<boolean> => {
      if (!shouldAttemptTransientContinuation()) return false;
      const recoveryState = inspectPiRecoveryState(entry.session);
      const recoveryDecision = decidePiContinuationRecovery(recoveryState);
      console.log(`[Pi] recovery primitive: session=${sessionId.slice(0, 8)} trigger=transient source=${source} leafRole=${recoveryState.leafRole} queued=${recoveryState.queuedMessages} action=${recoveryDecision.action} reason=${recoveryDecision.reason}`);
      if (recoveryDecision.action === 'needs_attention') return false;
      transientContinuationAttempted = true;
      return runContinuationRecovery({
        trigger: 'transient',
        source,
        failureMessage: 'Pi transient continuation failed',
        logStart: `[Pi] transient continuation after transport interruption: session=${sessionId.slice(0, 8)} source=${source} assistantSaved=${assistantSaved} iterations=${iterationCount} tools=${toolCallsForTelemetry}`,
        ...(recoveryDecision.action === 'recovery_prompt'
          ? { execute: () => promptWithFetchCorrelation(TRANSIENT_INTERRUPTION_RECOVERY_PROMPT) }
          : {}),
      });
    };

    const runIncompleteTurnContinuationOnce = async (source: string): Promise<boolean> => {
      const recoveryState = inspectPiRecoveryState(entry.session);
      const projectionSuggestsIncomplete = shouldAutoContinueIncompleteTurn({
        stopReason,
        lastAssistant: lastAssistantTelemetry,
        abortRequested: Boolean(entry.abortRequested),
        watchdogAborted: Boolean(watchdogAborted),
      });
      console.log(`[Pi] recovery decision: session=${sessionId.slice(0, 8)} trigger=incomplete_tool_boundary enabled=${incompleteToolBoundaryContinuationEnabled} projectionIncomplete=${projectionSuggestsIncomplete} leafRole=${recoveryState.leafRole} sdkIdle=${recoveryState.idle} queued=${recoveryState.queuedMessages} action=${recoveryState.leafRole === 'assistant' ? 'classify_incomplete' : incompleteToolBoundaryContinuationEnabled && projectionSuggestsIncomplete ? 'continue_native' : 'none'}`);
      if (incompleteTurnContinuationAttempted || entry.abortRequested || Boolean(watchdogAborted)) return false;
      if (!projectionSuggestsIncomplete) return false;

      incompleteTurnContinuationAttempted = true;
      // An assistant leaf cannot be resumed safely with Pi native continuation, and
      // automatically prompting for a final answer may repeat tool side effects.
      // Leave execution untouched; terminal classification below fails closed.
      if (recoveryState.leafRole === 'assistant') return false;
      if (!incompleteToolBoundaryContinuationEnabled) return false;

      return runContinuationRecovery({
        trigger: 'incomplete',
        source,
        failureMessage: 'Pi incomplete-turn continuation failed',
        logStart: `[Pi] auto-continuing incomplete turn: session=${sessionId.slice(0, 8)} source=${source} lastStop=${lastAssistantTelemetry?.stopReason ?? 'none'} lastHadTool=${lastAssistantTelemetry?.hasToolCall ?? false} continuationIntent=${lastAssistantTelemetry?.continuationIntent ?? false}`,
      });
    };


    const promptPromise = (async () => {
      try {
        try {
          await compactSessionBeforePromptIfNeeded('initial');
          if (autoResumeRun) {
            const recoveryState = inspectPiRecoveryState(entry.session);
            const restartDecision = decidePiRestartRecovery(recoveryState);
            console.log(`[Pi] restart recovery decision: session=${sessionId.slice(0, 8)} leafRole=${recoveryState.leafRole} sdkIdle=${recoveryState.idle} queued=${recoveryState.queuedMessages} action=${restartDecision.action} reason=${restartDecision.reason}`);
            if (restartDecision.action === 'native_continue') {
              await continueWithPiNativeLifecycle(autoResumeReason || 'auto-resume');
            } else if (restartDecision.action === 'recovery_prompt') {
              await promptWithFetchCorrelation(SERVER_RESTART_RECOVERY_PROMPT);
            } else {
              throw new Error(`Pi restart recovery requires attention (${restartDecision.reason}).`);
            }
          } else {
            await promptWithFetchCorrelation(prompt);
          }
        } catch (err: any) {
          const message = err?.message || 'Pi prompt failed';
          if (isPiTransientAbortError(message) && canAutoRetryTransientAbort()) {
            transientAbortRetryRequested = true;
            transientAbortRetryMessage = message;
          } else {
            throw err;
          }
        }

        console.log(`[Pi] prompt() resolved: session=${sessionId.slice(0, 8)} iterations=${iterationCount} tokens=${cumulativeInput}+${cumulativeOutput} stopReason=${stopReason}${watchdogAborted ? ` watchdog=${watchdogAborted}` : ''} streamPerf=raw:${streamPerf.rawMessageUpdates},ui:${streamPerf.assistantSnapshotsQueued}->${streamPerf.assistantSnapshotsFlushed},db:${streamPerf.assistantDbUpdatesQueued}->${streamPerf.assistantDbUpdatesFlushed}`);

        const transientRecovered = await runTransientRetriesIfNeeded();
        if (!transientRecovered) {
          const transientContinued = await runTransientContinuationOnce('transient-retry-exhausted');
          if (transientContinued) {
            await emitTurnDone();
            return;
          }
          const postCompactRecovered = await runPostCompactContinuationOnce('transient-retry-exhausted');
          await emitTurnDone(postCompactRecovered ? undefined : undefined);
          return;
        }

        if (oversizedPreflightRecoveryRequested && !oversizedPreflightRecoveryAttempted && !entry.abortRequested) {
          oversizedPreflightRecoveryAttempted = true;
          const reason = oversizedPreflightMessage || 'oversized Responses request';
          const preflightMetrics = parsePiPreflightContextMetrics(reason);
          const recoveryBudgets = piRecoveryKeepBudgets(preflightMetrics?.contextWindow || 0);
          console.warn(`[Pi] oversized preflight recovery: compacting session=${sessionId.slice(0, 8)} reason=provider-overflow detail=${reason.slice(0, 180)} body=${preflightMetrics?.bodyTokens || 0} safeTarget=${preflightMetrics?.safeTargetTokens || 0} budgets=${recoveryBudgets.join(',')}`);
          const recoveryAgent = (entry.session as any)?.agent;
          if (Array.isArray(recoveryAgent?.state?.messages)) {
            recoveryAgent.state.messages = sanitizePiMessagesForRecovery(recoveryAgent.state.messages);
          }
          try {
            const alreadyCompactedThisTurn = runCtx.compactionSucceededThisTurn && !overflowCompactionInProgress;
            if (alreadyCompactedThisTurn) {
              console.warn(`[Pi] oversized preflight recovery: reusing SDK compaction already completed this turn session=${sessionId.slice(0, 8)}`);
            } else {
              emitRecoveryCompactStart('oversized-preflight-recovery');
              const originalModel = entry.session.model;
              let compactionFallbackSpec = '';
              if (originalModel?.provider === 'litellm-responses') {
                for (const spec of getCodexFallbackModelSpecs()) {
                  const fallbackModel = this.modelRegistryManager.resolvePiModel(spec);
                  if (!fallbackModel) continue;
                  compactionFallbackSpec = spec;
                  console.warn(`[Pi] oversized preflight recovery: using fallback ${spec} for compaction session=${sessionId.slice(0, 8)}`);
                  await entry.session.setModel(fallbackModel);
                  break;
                }
              }
              try {
                await entry.session.compact('The next request exceeded the model context window. Summarize prior work aggressively, preserve current task state, edited files, decisions, and exact next steps.');
                const manager = (entry.session as any)?.sessionManager;
                const persistedCompactionCount = countPiCompactionEntries(manager);
                if (persistedCompactionCount > compactionEntriesAtRunStart + sdkCompactionSucceededEventsThisTurn) {
                  forgetPiContextTokenHint(sessionId);
                  try { forgetPiContextTokenHint((entry.session as any)?.sessionManager?.getSessionId?.()); } catch { /* best-effort */ }
                  runCtx.compactionSucceededThisTurn = true;
                  sdkCompactionSucceededEventsThisTurn++;
                  emitRecoveryCompactDoneIfNeeded('oversized-preflight-recovery');
                  await appendTowerFileLedgerAfterCompaction('oversized-preflight-recovery');
                } else {
                  const fallback = createPiLocalFallbackCompaction({
                    session: manager,
                    agent: (entry.session as any)?.agent,
                    reason: 'manual oversized-preflight recovery compact() returned without persisting a compaction entry',
                    keepRecentTokens: recoveryBudgets[0],
                  });
                  if (fallback.succeeded) {
                    forgetPiContextTokenHint(sessionId);
                    try { forgetPiContextTokenHint((entry.session as any)?.sessionManager?.getSessionId?.()); } catch { /* best-effort */ }
                    runCtx.compactionSucceededThisTurn = true;
                    sdkCompactionSucceededEventsThisTurn++;
                    emitRecoveryCompactDoneIfNeeded('oversized-preflight-recovery-local-fallback');
                    await appendTowerFileLedgerAfterCompaction('oversized-preflight-recovery-local-fallback');
                    console.warn(`[Pi] local fallback compaction created after compact() no-persist: session=${sessionId.slice(0, 8)} compaction=${fallback.compactionId} before=${fallback.before} after=${fallback.after}`);
                  } else {
                    throw new Error(`Pi compact() returned without persisting a compaction entry; local fallback failed: ${fallback.reason || 'unknown'}`);
                  }
                }
              } finally {
                if (compactionFallbackSpec && originalModel && !entry.abortRequested) {
                  try {
                    await entry.session.setModel(originalModel);
                    console.warn(`[Pi] oversized preflight recovery: restored model ${originalModel.provider}/${originalModel.id} after compaction session=${sessionId.slice(0, 8)}`);
                  } catch (restoreErr: any) {
                    console.warn(`[Pi] oversized preflight recovery: model restore failed session=${sessionId.slice(0, 8)} error=${restoreErr?.message || restoreErr}`);
                  }
                }
              }
            }
            oversizedPreflightRecoveryRequested = false;
            oversizedPreflightMessage = '';
            // Safe automatic replay only before any visible assistant/tool side effects.
            // If the oversized block happened deep in a tool loop, compaction is still
            // valuable, but replaying the original user prompt risks duplicate work.
            if (!assistantSaved && toolCallsForTelemetry === 0 && !entry.abortRequested) {
              stopReason = undefined;
              providerErrorMustRemainError = false;
              console.warn(`[Pi] oversized preflight recovery: retrying prompt after compaction session=${sessionId.slice(0, 8)}`);
              await promptWithFetchCorrelation(prompt);
              const recoveredRetry = await runTransientRetriesIfNeeded();
              if (!recoveredRetry) {
                const postCompactRecovered = await runPostCompactContinuationOnce('oversized-retry-transient');
                await emitTurnDone(postCompactRecovered ? undefined : undefined);
                return;
              }
              if (oversizedPreflightRecoveryRequested) {
                const aggressiveManager = (entry.session as any).sessionManager;
                const aggressiveFallback = createPiLocalFallbackCompaction({
                  session: aggressiveManager,
                  agent: (entry.session as any)?.agent,
                  reason: 'Responses payload remained oversized after first recovery; escalating retained history to 5 percent',
                  keepRecentTokens: recoveryBudgets[1],
                });
                if (aggressiveFallback.succeeded) {
                  console.warn(`[Pi] oversized preflight recovery: 5-percent fallback created session=${sessionId.slice(0, 8)} compaction=${aggressiveFallback.compactionId} keep=${recoveryBudgets[1]}`);
                } else {
                  console.warn(`[Pi] oversized preflight recovery: 5-percent fallback unavailable; escalating to minimal recovery session=${sessionId.slice(0, 8)} reason=${aggressiveFallback.reason || 'unknown'}`);
                }
                compactRecoverySessionFile = createPiCompactRecoverySessionFile(
                  aggressiveManager,
                  oversizedPreflightMessage || 'oversized preflight remained after SDK compaction',
                );
                if (compactRecoverySessionFile) {
                  console.warn(`[Pi] oversized preflight recovery: created compact-only recovery session file=${compactRecoverySessionFile} session=${sessionId.slice(0, 8)}`);
                  await callbacks.claimSessionId(compactRecoverySessionFile);
                  eventQueue.push({
                    type: 'engine_error',
                    sessionId,
                    message: '컨텍스트를 자동 정리했지만 기존 Pi 세션 파일의 kept history가 여전히 너무 큽니다. 복구용 요약-only 세션 파일을 만들었으니, 다음 메시지는 이 복구 지점에서 이어집니다.',
                    recoverable: true,
                    retryable: false,
                  });
                } else {
                  eventQueue.push({
                    type: 'engine_error',
                    sessionId,
                    message: '컨텍스트를 자동 정리했지만 아직 요청이 너무 큽니다. 이 세션은 새 세션으로 이어가는 것이 안전합니다.',
                    recoverable: true,
                    retryable: false,
                  });
                }
                await emitTurnDone('error');
                return;
              }
            } else {
              stopReason = undefined;
              providerErrorMustRemainError = false;
              console.warn(`[Pi] oversized preflight recovery: attempting safe post-compact recovery without replaying original prompt session=${sessionId.slice(0, 8)} assistantSaved=${assistantSaved} tools=${toolCallsForTelemetry}`);
              const postCompactRecovered = await runPostCompactContinuationOnce('oversized-preflight-post-compact');
              if (postCompactRecovered || clearSuccessfulOversizedRecoveryIfPossible({ source: 'oversized-preflight-post-compact' })) {
                await emitTurnDone();
                return;
              }
              const transientContinued = await runTransientContinuationOnce('oversized-continuation-transient');
              if (transientContinued || clearSuccessfulOversizedRecoveryIfPossible({ source: 'oversized-continuation-transient' })) {
                await emitTurnDone();
                return;
              }
              durableOutcome = 'retryable_failure';
              durableError = 'Pi oversized preflight recovery stopped before unsafe assistant-tail native continuation.';
              eventQueue.push({
                type: 'engine_error',
                sessionId,
                message: '컨텍스트를 자동 정리했지만 현재 transcript 형태에서는 자동 이어가기가 안전하지 않아 중단했습니다. 같은 세션에서 계속 진행을 요청하면 기존 결과를 유지한 채 이어갈 수 있습니다.',
                recoverable: true,
                retryable: true,
              });
              await emitTurnDone('error');
              return;
            }
          } catch (compactErr: any) {
            const compactMessage = compactErr?.message || String(compactErr || 'unknown');
            if (isPiCompactionNoOpMessage(compactMessage)) {
              // Nothing to compact must never become the terminal error for a
              // user's continue turn. Preserve the Session and issue one safe
              // continuation rather than replaying the original request.
              emitRecoveryCompactSkippedIfNeeded('oversized-preflight-noop');
              oversizedPreflightRecoveryRequested = false;
              oversizedPreflightMessage = '';
              stopReason = undefined;
              providerErrorMustRemainError = false;
              clearClosingTerminalizer();
              clearAgentEndTerminalizer();
              entry.runPhase = 'running';
              entry.promptActive = true;
              if (!assistantSaved && toolCallsForTelemetry === 0) {
                console.warn(`[Pi] oversized preflight compaction was a no-op; retrying original prompt once: session=${sessionId.slice(0, 8)}`);
                await promptWithFetchCorrelation(prompt);
              } else {
                console.warn(`[Pi] oversized preflight compaction was a no-op after work started; attempting safe continuation without replay: session=${sessionId.slice(0, 8)}`);
                const noopContinued = await runPostCompactContinuationOnce('oversized-preflight-noop', { requireCompaction: false });
                if (!noopContinued && !clearSuccessfulOversizedRecoveryIfPossible({ source: 'oversized-preflight-noop', allowNoopWithoutCompaction: true })) {
                  durableOutcome = 'retryable_failure';
                  durableError = 'Pi oversized preflight no-op recovery stopped before unsafe assistant-tail native continuation.';
                  eventQueue.push({
                    type: 'engine_error',
                    sessionId,
                    message: '요청은 너무 컸지만 현재 Pi 세션에는 압축할 항목이 없고, 자동 이어가기는 안전하지 않아 중단했습니다. 같은 세션에서 계속 진행을 요청하면 기존 결과를 유지한 채 이어갈 수 있습니다.',
                    recoverable: true,
                    retryable: true,
                  });
                  await emitTurnDone('error');
                  return;
                }
              }
              const continued = await runTransientRetriesIfNeeded();
              if (continued || clearSuccessfulOversizedRecoveryIfPossible({ source: 'oversized-preflight-noop', allowNoopWithoutCompaction: true })) {
                await emitTurnDone();
              } else {
                await emitTurnDone('error');
              }
              return;
            }
            if (clearSuccessfulOversizedRecoveryIfPossible({ source: 'oversized-preflight-recovery-error' })) {
              await emitTurnDone();
              return;
            }
            emitRecoveryCompactFailedIfNeeded('oversized-preflight-recovery-error');
            persistCompactionFailureNotice(compactMessage);
            console.warn(`[Pi] oversized preflight recovery compact failed: session=${sessionId.slice(0, 8)} error=${compactMessage}`);
            const isCapacity = isPiTransientAbortError(compactMessage);
            const isNativeUnavailable = isPiNativeContinuationUnavailable(compactMessage);
            eventQueue.push({
              type: 'engine_error',
              sessionId,
              message: isNativeUnavailable
                ? '컨텍스트 자동 정리 후 자동 이어가기를 시도했지만 현재 transcript 형태에서는 안전하지 않아 중단했습니다. 같은 세션에서 계속 진행을 요청하면 기존 결과를 유지한 채 이어갈 수 있습니다.'
                : isCapacity
                  ? `컨텍스트 자동 정리를 시작했지만 요약용 모델 슬롯이 일시적으로 가득 찼습니다. 세션을 버릴 필요는 없고, 잠시 후 이어서 보내면 다시 시도합니다. 원인: ${compactMessage.slice(0, 200)}`
                  : `컨텍스트가 너무 커서 자동 정리를 시도했지만 실패했습니다. 새 세션으로 이어가 주세요. 원인: ${compactMessage.slice(0, 240)}`,
              recoverable: true,
              retryable: isCapacity || isNativeUnavailable,
            });
            await emitTurnDone(entry.abortRequested ? 'aborted' : 'error');
            return;
          }
        }

        if (codexUsageLimitFallbackRequested && !codexUsageLimitFallbackAttempted && !entry.abortRequested) {
          codexUsageLimitFallbackAttempted = true;
          // Try each fallback spec in order. The default fallback is the full-VM
          // Azure GPT-5.5 emergency route; legacy litellm/smart is retired.
          // The triggering error was either a
          // Codex usage-limit or an OAuth-token invalidation; both recover by
          // moving off the ChatGPT-account-bound provider.
          const originalMessage = codexUsageLimitMessage;
          const fallbackSpecs = getCodexFallbackModelSpecs();
          let fallbackRecovered = false;
          let lastTriedSpec = '';
          for (const fallbackSpec of fallbackSpecs) {
            if (entry.abortRequested) break;
            const fallbackModel = this.modelRegistryManager.resolvePiModel(fallbackSpec);
            if (!fallbackModel) {
              console.warn(`[Pi] fallback model not resolvable, skipping: ${fallbackSpec} session=${sessionId.slice(0, 8)}`);
              continue;
            }
            lastTriedSpec = fallbackSpec;
            console.warn(`[Pi] Codex provider error; retrying with fallback ${fallbackSpec} session=${sessionId.slice(0, 8)}`);
            // Recovered Codex fallback is an implementation detail, not an actionable
            // user error. Keep it in logs; only surface a visible engine_error if all
            // fallback candidates fail below.
            stopReason = undefined;
            codexUsageLimitFallbackRequested = false;
            codexUsageLimitMessage = '';
            try {
              await entry.session.setModel(fallbackModel);
              await promptWithFetchCorrelation(prompt);
            } catch (fbErr: any) {
              console.warn(`[Pi] fallback ${fallbackSpec} threw, trying next: session=${sessionId.slice(0, 8)} error=${fbErr?.message || fbErr}`);
              continue;
            }
            const fallbackTransientRecovered = await runTransientRetriesIfNeeded();
            if (!fallbackTransientRecovered) {
              console.warn(`[Pi] fallback ${fallbackSpec} transient retries exhausted, trying next: session=${sessionId.slice(0, 8)}`);
              continue;
            }
            if (stopReason === 'error') {
              console.warn(`[Pi] fallback ${fallbackSpec} ended in error, trying next: session=${sessionId.slice(0, 8)}`);
              continue;
            }
            // Non-error turn — fallback succeeded. The prompt's message_end events
            // are processed by the same subscription above; continue into normal
            // turn_done handling below.
            fallbackRecovered = true;
            break;
          }
          if (!fallbackRecovered) {
            eventQueue.push({
              type: 'engine_error',
              sessionId,
              message: `Codex fallback 실패 — 모든 대체 모델(${fallbackSpecs.join(', ')})이 응답하지 못했습니다. 마지막 시도: ${lastTriedSpec || '없음'}. 원인: ${originalMessage.slice(0, 240)}`,
              recoverable: true,
            });
            await emitTurnDone('error');
            return;
          }
        }
        // Explicit user abort can settle through Pi's agent_end error channel
        // without rejecting prompt(). Preserve it as an aborted terminal turn;
        // otherwise the normal success path can misclassify it and omit turn_done.
        if (entry.abortRequested) {
          stopReason = 'aborted';
          await emitTurnDone('aborted');
          return;
        }

        // Watchdog-triggered abort: surface as engine_error so the user sees
        // *why* the turn ended (not a generic "aborted" which suggests user action).
        if (watchdogAborted) {
          await surfaceWatchdogAbort();
          await emitTurnDone('error');
          return;
        }
        // Only downgrade an empty trailing error when this turn already produced a
        // durable assistant result. A provider/context error with no assistant text
        // must remain an error so PiRunTerminalizer can surface it instead of
        // reporting a silent successful completion.
        if (stopReason === 'error' && !providerErrorMustRemainError && assistantSaved) {
          console.log(`[Pi] Downgrading trailing stopReason from error→stop after durable assistant output: session=${sessionId.slice(0, 8)}`);
          stopReason = 'stop';
        } else if (stopReason === 'error') {
          console.log(`[Pi] Preserving stopReason=error without durable assistant output: session=${sessionId.slice(0, 8)} providerMustRemain=${providerErrorMustRemainError}`);
        }

        const incompleteTurnContinued = await runIncompleteTurnContinuationOnce('prompt-resolved-incomplete');
        if (incompleteTurnContinued) {
          console.warn(`[Pi] incomplete turn continuation completed: session=${sessionId.slice(0, 8)}`);
        }
        const incompleteAfterRecovery = shouldAutoContinueIncompleteTurn({
          stopReason,
          lastAssistant: lastAssistantTelemetry,
          abortRequested: Boolean(entry.abortRequested),
          watchdogAborted: Boolean(watchdogAborted),
        });
        if (incompleteAfterRecovery) {
          durableOutcome = 'retryable_failure';
          durableError = 'Pi turn ended after tool calls without a final assistant answer.';
          console.warn(`[Pi] refusing completed outcome for incomplete tool boundary: session=${sessionId.slice(0, 8)} leafRole=${inspectPiRecoveryState(entry.session).leafRole}`);
          if (!incompleteTurnContinued) emitContinuationFailure(durableError);
        }
        if (recoveryClaimToken) {
          const settlement = await settlePiRecoveryOutcome({
            aborted: false,
            durableAssistant: Boolean(lastSavedAssistantMsgId),
            stopReason,
            noResultError: transientAbortRetryMessage || `Recovery ended without a durable assistant result (stop=${stopReason ?? 'none'}).`,
            callbacks: {
              complete: completeRecoveryClaim,
              release: releaseRecoveryClaim,
              isUnavailable: isPiNativeContinuationUnavailable,
            },
          });
          durableOutcome = settlement.outcome;
          durableError = settlement.error;
        }
        await emitTurnDone(durableOutcome === 'completed' ? undefined : 'error');
      } catch (err: any) {
        markClosing('prompt-rejected');
        const message = err?.message || 'Pi prompt failed';
        console.error(`[Pi] prompt() rejected: session=${sessionId.slice(0, 8)} error=${message}${watchdogAborted ? ` watchdog=${watchdogAborted}` : ''}`);
        const isAbortError = entry.abortRequested && /abort|cancel/i.test(message);
        if (watchdogAborted) {
          await surfaceWatchdogAbort();
        } else if (!isAbortError && !terminalizer.isTerminalForced) {
          if (isPiTransientAbortError(message)) {
            suppressTransientAbortVisibleError('prompt-rejected', message);
          } else {
            eventQueue.push({
              type: 'engine_error',
              sessionId,
              message,
              retryable: false,
            });
          }
        }
        // If the turn died immediately after a successful compaction, try one
        // continuation before handing control back to the user. This mirrors the
        // manual "계속" users were pressing after compact+connection-drop, but is
        // capped to one attempt and skips explicit user abort / watchdog abort.
        const transientContinued = !isAbortError && !watchdogAborted && transientAbortVisibleSuppressed
          ? await runTransientContinuationOnce('prompt-rejected')
          : false;
        const postCompactRecovered = !transientContinued && !isAbortError && !watchdogAborted
          ? await runPostCompactContinuationOnce('prompt-rejected')
          : false;
        if (recoveryClaimToken && !transientContinued && !postCompactRecovered) {
          const settlement = await settlePiRecoveryOutcome({
            executionError: message,
            aborted: Boolean(isAbortError),
            durableAssistant: Boolean(lastSavedAssistantMsgId),
            stopReason,
            noResultError: message,
            callbacks: {
              complete: completeRecoveryClaim,
              release: releaseRecoveryClaim,
              isUnavailable: isPiNativeContinuationUnavailable,
            },
          });
          durableOutcome = settlement.outcome;
          durableError = settlement.error;
        }
        // Still emit turn_done so the frontend clears streaming/turn-phase state.
        // Without this, errors + aborts leave the turn "in progress" on the client.
        await emitTurnDone(transientContinued || postCompactRecovered ? undefined : (watchdogAborted ? 'error' : (isAbortError ? 'aborted' : undefined)));
      } finally {
        promptSettled = true;
        lifecycleShadow.observePromptSettled(Boolean(entry.session.isIdle));
        clearClosingTerminalizer();
        clearAgentEndTerminalizer();
        clearToolHeartbeat();
        done = true;
        entry.runPhase = markPiRunClosing(entry.runPhase);
        entry.promptActive = false; // turn over — further steers must not hit the SDK
        this.startupSteerBuffer.delete(sessionId); // drop any turn-boundary stragglers
        const wakeYieldLoop = resolveWait as (() => void) | null;
        wakeYieldLoop?.();
      }
    })();
    entry.activePrompt = promptPromise;

    // Flush messages that arrived during the startup window into THIS turn, in
    // arrival order. prompt() has begun above, so the SDK now accepts steers.
    // (issue #17 — keeps rapid "1,2,3…" typed right as the turn starts together.)
    const startupBuffered = this.startupSteerBuffer.get(sessionId);
    if (startupBuffered?.length) {
      this.startupSteerBuffer.delete(sessionId);
      for (const b of startupBuffered) {
        if (b.msgId) {
          if (!entry.pendingSteers) entry.pendingSteers = [];
          entry.pendingSteers.push({ text: b.text, msgId: b.msgId, username: b.username });
        }
        try {
          await entry.session.steer(b.text);
          console.log(`[Pi] flushed startup-buffered steer: session=${sessionId.slice(0, 8)} msgId=${b.msgId?.slice(0, 8) || '-'}`);
        } catch (e: any) {
          console.warn(`[Pi] startup steer flush failed: ${e?.message || e}`);
        }
      }
    }

    // 5. Yield loop (with abort detection)
    // Store abort resolver on entry so abort() can break the loop,
    // but keep isRunning=true until Pi's prompt promise actually settles.
    try {
      while (!done || eventQueue.length > 0) {
        // User abort wakes the loop immediately, but Pi may enqueue the final
        // aborted turn_done while promptPromise is settling. Do not break early
        // and strand that terminal event in eventQueue; wait until done, then
        // drain the queue before yielding engine_done.
        if (eventQueue.length > 0) {
          yield eventQueue.shift()!;
        } else {
          await new Promise<void>(r => {
            resolveWait = r;
            entry._abortResolve = r;
          });
          resolveWait = null;
          entry._abortResolve = null;
        }
      }

      if (!terminalizer.isTerminalForced) {
        await promptPromise;
      } else {
        console.warn(`[Pi] skipping promptPromise await after forced terminalization: session=${sessionId.slice(0, 8)}`);
      }

      // 6. Engine done — include session file path for persistence
      if (sdkCompactionSucceededEventsThisTurn > 0) {
        const manager = (entry.session as any)?.sessionManager;
        const compactionEntriesAfterRun = countPiCompactionEntries(manager);
        if (compactionEntriesAfterRun <= compactionEntriesAtRunStart) {
          console.warn(`[Pi] compaction event did not persist a compaction entry: session=${sessionId.slice(0, 8)} events=${sdkCompactionSucceededEventsThisTurn} before=${compactionEntriesAtRunStart} after=${compactionEntriesAfterRun} model=${entry.session.model?.provider ?? '?'}/${entry.session.model?.id ?? '?'}`);
        }
      }
      const piSessionFile = compactRecoverySessionFile || entry.session.sessionFile;
      if (piSessionFile) {
        backupPiSessionFile(piSessionFile);
        this.interruptedSessionIds.delete(sessionId);
      }
      if (towerFileLedgerCheckpointPromises.length > 0) {
        await Promise.allSettled(towerFileLedgerCheckpointPromises);
      }
      yield {
        type: 'engine_done',
        sessionId,
        engineSessionId: piSessionFile,
        editedFiles: [...editedFiles],
        outcome: durableOutcome,
        assistantMessageId: durableOutcome === 'completed' ? lastSavedAssistantMsgId ?? undefined : undefined,
        error: durableError,
      };
    } catch (runErr: any) {
      console.error(`[Pi] run() loop error: session=${sessionId.slice(0, 8)} error=${runErr.message}`);
      throw runErr;
    } finally {
      console.log(`[Pi] run() finished: session=${sessionId.slice(0, 8)} done=${done} queueLen=${eventQueue.length}${watchdogAborted ? ` watchdog=${watchdogAborted}` : ''}`);
      watchdog.stop();
      if (recoveryLeaseHeartbeat) clearInterval(recoveryLeaseHeartbeat);
      unsub();
      // Clear any delayed coalescer/debounce timers. Terminal paths flush before
      // turn_done; this prevents post-run timer callbacks from mutating a closed
      // session after engine_done has been yielded.
      clearClosingTerminalizer();
      clearAgentEndTerminalizer();
      clearToolHeartbeat();
      coalescer.clearAllTimers();
      coalescer.resetPending();
      entry.activePrompt = null;
      entry.abortRequested = false;
      entry.safeStopRequested = false;
      entry._abortResolve = null;
      entry.isRunning = false;
      entry.promptActive = false;
      entry.runPhase = 'closed';
      clearCurrentRootTurn(sessionId);
      if (compactRecoverySessionFile || terminalizer.isTerminalForced) {
        try { entry.session.dispose(); } catch { /* best-effort */ }
        this.sessions.delete(sessionId);
        if (terminalizer.isTerminalForced) {
          console.warn(`[Pi] disposed terminal-forced SDK session so next turn cold-starts: session=${sessionId.slice(0, 8)}`);
        }
      }
      // Defensive — should already be deleted at handoff, but cover any
      // path that exits before the handoff (e.g. early throws).
      this.startingSessions.delete(sessionId);
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // Session lifecycle
  // ═══════════════════════════════════════════════════════════════

  private async switchModelIfNeeded(entry: PiSessionEntry, modelStr: string) {
    if (entry.harness?.allowedModels && !entry.harness.allowedModels.includes(modelStr)) {
      throw new Error(`Pinned Harness ${entry.harness.id}@${entry.harness.version} does not allow model ${modelStr}`);
    }
    const parts = modelStr.split('/');
    if (parts.length < 2) return;
    const provider = parts[0];
    const modelId = parts.slice(1).join('/');

    const currentModel = entry.session.model;
    if (currentModel && currentModel.provider === provider && currentModel.id === modelId) {
      return; // same model, no switch needed
    }

    const registry = this.modelRegistryManager.getModelRegistry();
    const newModel = registry.find(provider, modelId);
    if (newModel) {
      await entry.session.setModel(newModel);
      console.log(`[Pi] Model switched to ${provider}/${modelId}`);
    } else {
      console.warn(`[Pi] Model switch skipped: ${provider}/${modelId} not found in registry (keeping current model ${entry.session.model?.provider ?? '?'}/${entry.session.model?.id ?? '?'})`);
    }
  }

  private async createSession(sessionId: string, opts: RunOpts, callbacks?: EngineCallbacks): Promise<PiSessionEntry> {
    const modelRuntime = await this.modelRegistryManager.getModelRuntime();
    const registry = this.modelRegistryManager.getModelRegistry();
    // A native Pi resume already owns its conversation history in sessionFile.
    // Reattach only the Session's pinned Harness; never resolve today's mutable
    // Project binding or silently pin a replacement contract during recovery.
    const harness = opts.engineSessionId
      ? await getPinnedSessionHarnessSnapshot({
          sessionId,
          requestedEngine: 'pi',
          requestedModel: opts.model,
        })
      : await getOrPinSessionHarnessSnapshot({
          sessionId,
          projectId: opts.projectId,
          requestedEngine: 'pi',
          requestedModel: opts.model,
          requestedHarnessId: opts.harnessId,
          requestedHarnessVersion: opts.harnessVersion,
          requestedRuntimeProfileId: opts.runtimeProfileId,
          requestedRuntimeProfileVersion: opts.runtimeProfileVersion,
          invocationKind: 'session',
        });
    const effectiveModelId = opts.model || harness.defaultModel || undefined;
    await this.modelRegistryManager.applyProjectVaultApiKeyOverrides({
      projectId: opts.projectId,
      userId: opts.userId,
      model: effectiveModelId,
    });
    const model = this.modelRegistryManager.resolveSessionModel(effectiveModelId);

    // ── Build Tower context for Pi ──
    const projectName = path.basename(opts.cwd || process.cwd());
    const { resourceLoader, towerPrompt, memoryContext } = await buildPiSessionResources({
      sessionId,
      opts,
      model,
      projectName,
      harness,
    });

    // ── Session persistence ──
    // Do not let SessionManager.open parse an extreme legacy JSONL into a full
    // object graph. Create a bounded summary-only epoch first, while streaming
    // the source file and skipping multi-megabyte entries.
    let effectiveEngineSessionId = opts.engineSessionId;
    if (effectiveEngineSessionId && shouldCreatePiOversizedRecoveryEpoch(effectiveEngineSessionId)) {
      const recoveryFile = await createPiOversizedRecoveryEpochFromFile(
        effectiveEngineSessionId,
        'source Pi JSONL exceeded the safe startup-memory threshold',
      );
      if (!recoveryFile) throw new Error(`Oversized Pi conversation could not be recovered safely (${effectiveEngineSessionId})`);
      effectiveEngineSessionId = recoveryFile;
      await callbacks?.claimSessionId(recoveryFile);
      console.warn(`[Pi] oversized resume redirected to bounded recovery epoch: session=${sessionId.slice(0, 8)} source=${opts.engineSessionId} recovery=${recoveryFile}`);
    }
    const { sessionMgr, resumeFailedMsg } = openOrCreatePiSessionManager({
      sessionId,
      cwd: opts.cwd,
      engineSessionId: effectiveEngineSessionId,
    });

    const parentSessionFile = sessionMgr.getSessionFile();
    const {
      allToolNames,
      allCustomTools,
      towerMcpServers,
      promptStaticTokenEstimate,
      piBeforeToolCall,
      piAfterToolCall,
    } = await buildPiToolAssembly({
      sessionId,
      opts,
      callbacks,
      registry,
      parentSessionFile,
      projectName,
      towerPrompt,
      memoryContext,
      harness,
      modelContextWindow: model.contextWindow,
    });
    const harnessFingerprint = buildHarnessRuntimeFingerprint(harness, allToolNames);
    console.log('[Harness] resolved', JSON.stringify({
      sessionId,
      harnessId: harnessFingerprint.harnessId,
      harnessVersion: harnessFingerprint.harnessVersion,
      runtimeProfileId: harnessFingerprint.runtimeProfileId,
      runtimeProfileVersion: harnessFingerprint.runtimeProfileVersion,
      engine: harnessFingerprint.engine,
      resolutionSource: harnessFingerprint.resolutionSource,
      promptBundleHash: harnessFingerprint.promptBundleHash,
      toolSetHash: harnessFingerprint.toolSetHash,
      toolCount: harnessFingerprint.toolCount,
    }));

    const configuredModel = loadModelsFile().pi.find(entry => entry.provider === model.provider && entry.modelId === model.id);
    const defaultThinkingLevel = configuredModel?.defaultReasoning || 'medium';
    const effectiveThinkingLevel = opts.effort === 'low' || opts.effort === 'medium' || opts.effort === 'high' || opts.effort === 'xhigh'
      ? opts.effort
      : opts.effort === 'max'
        ? 'xhigh'
        : defaultThinkingLevel;
    console.log('[ModelPolicy] resolved', JSON.stringify({
      sessionId,
      policyId: opts.modelPolicyId || null,
      policyRevision: opts.modelPolicyRevision || null,
      requestedModel: opts.model || null,
      effectiveModel: model ? `${model.provider}/${model.id}` : null,
      requestedEffort: opts.requestedEffort || opts.effort || defaultThinkingLevel,
      effectiveEffort: effectiveThinkingLevel,
      effortDowngraded: opts.effortDowngraded === true || opts.effort === 'max',
    }));

    const { session } = await createAgentSession({
      cwd: opts.cwd,
      model,
      // Default thinking level. Azure/gpt-5.x family should not be forced "off"
      // because Pi SDK's no-reasoning shim correlates with empty response.failed
      // events. Use low for the default LiteLLM Smartest route to reduce latency
      // and cost; keep medium for other reasoning models. An explicit Agent/Model
      // Policy may opt into high/xhigh; max maps to xhigh until Pi supports more.
      thinkingLevel: effectiveThinkingLevel,
      tools: allToolNames,
      // Our guard-wrapped piTools (same factory calls, ToolGuard layer added) +
      // session-specific customTools + MCP tools. piTools first so they override
      // SDK builtin definitions for the same names — keeping our ToolGuard active.
      customTools: allCustomTools,
      modelRuntime,
      resourceLoader,
      sessionManager: sessionMgr,
      settingsManager: createPiSettingsManager(),
    });

    // ── W3 hook wiring (post-create assignment) ──
    // The coding-agent wrapper's CreateAgentSessionOptions doesn't forward
    // beforeToolCall / afterToolCall (pi-coding-agent/dist/core/sdk.d.ts:11-55
    // omits them). But the underlying Agent class in @earendil-works/pi-agent-core
    // exposes both as public read-write properties (agent.d.ts:41-42), and the
    // agent loop reads them at execution time (agent-loop.js:363, 419), so
    // direct assignment after construction works.
    session.agent.beforeToolCall = piBeforeToolCall;
    session.agent.afterToolCall = piAfterToolCall;
    // Give only a bounded newest visual tool result one provider opportunity.
    // Older or over-budget PDF/image pixels become provider-only references.
    session.agent.transformContext = createPiVisualContextTransform({ contextWindow: session.model?.contextWindow });
    // Do not inject service_tier=priority for Smartest by default. Router-side
    // priority/fast experiments showed capacity volatility; the stable default is
    // the normal LiteLLM/Codex-LB tier unless an explicit operator experiment opts in.

    // Claim the session file path so Tower DB can restore it later
    const sessionFile = sessionMgr.getSessionFile();
    if (sessionFile) {
      backupPiSessionFile(sessionFile);
      if (callbacks) {
        callbacks.claimSessionId(sessionFile);
      }
      console.log(`[Pi] Session file: ${sessionFile}`);
    }

    const entry: PiSessionEntry = {
      session,
      isRunning: false,
      harness,
      harnessFingerprint,
      toolContext: {
        userId: opts.userId,
        userRole: opts.userRole,
        projectId: opts.projectId,
        workbenchRolloutEnabled: opts.projectId
          ? (await resolveWorkbenchRollout(opts.projectId)).enabled
          : false,
      },
      abortRequested: false,
      activePrompt: null,
      _abortResolve: null,
      resumeFailedMessage: resumeFailedMsg,
      mcpServers: Object.keys(towerMcpServers).length > 0 ? towerMcpServers : undefined,
      promptStaticTokenEstimate,
    };
    this.sessions.set(sessionId, entry);
    console.log(`[Pi] Session created: ${sessionId.slice(0, 8)} model=${model?.provider}/${model?.id}`);
    return entry;
  }

  /**
   * Persistent channel reply for Pi sessions — `@ai` 채널에서 engine=pi 선택 시
   * 진입하는 경로. Before this method existed, ai-quick-reply.ts:280 의 분기가
   * Pi 에 대해 fallback path (engine.quickReply) 로 갔고, *세션 컨텍스트가
   * 매 호출 cold start* 였음.
   *
   * 구현 전략 — 기존 `run()` 을 internal-sessionId 로 한 번 호출하고 yield 되는
   * TowerMessage 를 ChannelReplyOpts 의 콜백 (onChunk / onToolUse / onCompact)
   * 으로 변환. 이렇게 하면 W2 의 task callbacks, W3 의 hook adapter,
   * createSession 의 MCP / skills / model 결정 path 가 *그대로 재사용* 됨.
   *
   * Resume — opts.resumeSessionId 는 Pi sessionFile path. RunOpts.engineSessionId
   * 로 forward 하면 createSession 안의 preparePiResumeSession 이 처리. 결과
   * sessionFile path 는 engine_done 이벤트에서 받아 ChannelReplyResult 로 반환,
   * ai-quick-reply 가 다음 호출의 resume 용으로 DB 에 저장.
   *
   * Cleanup — 매 호출 후 internal session 을 dispose 해서 sessions Map 누적
   * 방지. Pi sessionFile 자체는 디스크에 남아있어서 resume 가능 (createSession 의
   * preparePiResumeSession 이 sessionFile 부터 새 session 객체 생성).
   *
   * See:
   *   - claude-engine.ts:522 (Claude 측 참고 구현)
   *   - workspace/projects/piagent/parity-roadmap-2026-05.md §W4
   *   - workspace/decisions/2026-05-17-pi-claude-parity-roadmap.md (W4 P1)
   */
  async channelReply(prompt: string, opts: ChannelReplyOpts): Promise<ChannelReplyResult> {
    return channelReplyWithPiRun({
      prompt,
      opts,
      run: this.run.bind(this),
      dispose: this.dispose.bind(this),
    });
  }

  async quickReply(prompt: string, opts: QuickReplyOpts): Promise<string> {
    return quickReplyWithPiProviders(prompt, opts, this.modelRegistryManager);
  }

  async *compact(
    sessionId: string,
    opts: RunOpts,
    callbacks: EngineCallbacks,
    prompt = 'The user explicitly requested /compact. Summarize prior work aggressively before the next request, preserving current task state, edited files, decisions, and exact next steps.',
  ): AsyncGenerator<TowerMessage> {
    if (this.isRunning(sessionId)) {
      yield { type: 'engine_error', sessionId, message: 'Pi session is already running. Wait for the current turn to finish.', recoverable: true };
      return;
    }

    this.startingSessions.add(sessionId);
    let entry = this.sessions.get(sessionId);
    if (!entry) {
      try {
        entry = await this.createSession(sessionId, opts, callbacks);
      } catch (err: any) {
        this.startingSessions.delete(sessionId);
        yield { type: 'engine_error', sessionId, message: `Pi session creation failed: ${err.message}`, recoverable: true };
        return;
      }
    }
    this.startingSessions.delete(sessionId);

    entry.isRunning = true;
    entry.runPhase = 'running';
    entry.abortRequested = false;
    yield { type: 'compact', sessionId, phase: 'boundary' };
    yield { type: 'compact', sessionId, phase: 'compacting' };

    try {
      const before = countPiCompactionEntries((entry.session as any)?.sessionManager);
      await entry.session.compact(prompt);
      const manager = (entry.session as any)?.sessionManager;
      const after = countPiCompactionEntries(manager);
      if (after <= before) {
        const fallback = createPiLocalFallbackCompaction({
          session: manager,
          agent: (entry.session as any)?.agent,
          reason: 'manual /compact returned without persisting a compaction entry',
        });
        if (!fallback.succeeded) {
          if (isPiCompactionNoOpMessage(fallback.reason)) {
            yield { type: 'compact', sessionId, phase: 'skipped' };
            yield { type: 'engine_done', sessionId, engineSessionId: manager?.getSessionFile?.(), editedFiles: [] };
            return;
          }
          throw new Error(`Pi compact() returned without persisting a compaction entry; local fallback failed: ${fallback.reason || 'unknown'}`);
        }
      }
      forgetPiContextTokenHint(sessionId);
      try { forgetPiContextTokenHint((entry.session as any)?.sessionManager?.getSessionId?.()); } catch { /* best-effort */ }
      const checkpoint = await appendTowerFileLedgerCheckpoint({
        sessionId,
        session: manager,
        reason: 'manual-compact',
      });
      if (checkpoint.appended) {
        console.log(`[Pi] tower file ledger checkpoint appended: session=${sessionId.slice(0, 8)} entry=${checkpoint.entryId} files=${checkpoint.fileCount} omitted=${checkpoint.omittedCount} reason=manual-compact`);
      } else if (checkpoint.reason && checkpoint.reason !== 'no file ledger rows') {
        console.warn(`[Pi] tower file ledger checkpoint skipped: session=${sessionId.slice(0, 8)} reason=${checkpoint.reason}`);
      }
      yield { type: 'compact', sessionId, phase: 'done', markerId: `compact-${sessionId}-${Date.now()}-${crypto.randomUUID().slice(0, 8)}` };
      yield { type: 'engine_done', sessionId, engineSessionId: (entry.session as any)?.sessionManager?.getSessionFile?.(), editedFiles: [] };
    } catch (err: any) {
      const compactMessage = err?.message || String(err || 'unknown');
      if (isPiCompactionNoOpMessage(compactMessage)) {
        yield { type: 'compact', sessionId, phase: 'skipped' };
        yield { type: 'engine_done', sessionId, engineSessionId: (entry.session as any)?.sessionManager?.getSessionFile?.(), editedFiles: [] };
        return;
      }
      yield { type: 'compact', sessionId, phase: 'failed' };
      yield { type: 'engine_error', sessionId, message: `Pi context compaction did not complete: ${compactMessage}`, recoverable: true };
      yield { type: 'engine_done', sessionId, engineSessionId: (entry.session as any)?.sessionManager?.getSessionFile?.(), editedFiles: [] };
    } finally {
      entry.isRunning = false;
      entry.runPhase = 'closed';
      entry.promptActive = false;
      this.startingSessions.delete(sessionId);
    }
  }

  async requestStopAtBoundary(sessionId: string): Promise<{ accepted: boolean; waitingFor?: 'active_tool' | 'engine_boundary'; reason?: string }> {
    const entry = this.sessions.get(sessionId);
    const disposition = classifyPiSafeStopRequest({
      isRunning: Boolean(entry?.isRunning),
      promptActive: Boolean(entry?.promptActive),
      runPhase: entry?.runPhase,
      alreadyRequested: Boolean(entry?.safeStopRequested),
    });
    if (!disposition.accepted || !entry) {
      return disposition;
    }
    if (disposition.duplicate) {
      return { accepted: true, waitingFor: disposition.waitingFor };
    }

    entry.safeStopRequested = true;
    if (disposition.waitingFor === 'engine_boundary') {
      entry.abortRequested = true;
      try { entry.session.abort(); } catch { /* best-effort at an idle engine boundary */ }
      entry._abortResolve?.();
      return { accepted: true, waitingFor: 'engine_boundary' };
    }
    return { accepted: true, waitingFor: disposition.waitingFor };
  }

  async steer(sessionId: string, message: string, messageId?: string, username?: string | null): Promise<void> {
    const entry = this.sessions.get(sessionId);
    const steerDisposition = classifyPiSteer({
      phase: entry?.runPhase,
      promptActive: entry?.promptActive,
      isRunning: entry?.isRunning,
      isStarting: this.startingSessions.has(sessionId),
    });

    if (steerDisposition.kind === 'reject') {
      throw new Error(steerDisposition.message);
    }

    // Startup window: the turn is claimed but the SDK's prompt() hasn't begun
    // accepting steers yet. Buffer in arrival order; run() flushes the buffer
    // into THIS turn the instant prompt() starts.
    if (steerDisposition.kind === 'buffer') {
      if (this.hasDuplicateSteer(sessionId, entry, message, messageId)) {
        console.warn(`[Pi] duplicate steer dropped (startup window): session=${sessionId.slice(0, 8)} msgId=${messageId?.slice(0, 8) || '-'}`);
        return;
      }
      const buf = this.startupSteerBuffer.get(sessionId) ?? [];
      buf.push({ text: message, msgId: messageId, username });
      this.startupSteerBuffer.set(sessionId, buf);
      console.log(`[Pi] steer() buffered (startup window): session=${sessionId.slice(0, 8)} msgId=${messageId?.slice(0, 8) || '-'}`);
      return;
    }

    if (!entry) {
      // classifyPiSteer() should make this unreachable for kind='deliver'. Keep
      // a defensive throw so TypeScript and future refactors preserve the guard.
      throw new Error('Pi session is not currently running; cannot steer.');
    }

    if (this.hasDuplicateSteer(sessionId, entry, message, messageId)) {
      console.warn(`[Pi] duplicate steer dropped: session=${sessionId.slice(0, 8)} msgId=${messageId?.slice(0, 8) || '-'}`);
      return;
    }

    // Record msgId BEFORE handing the text to the SDK. The SDK's steer() may
    // synchronously emit a `queue_update` with this text present; the run()
    // handler matches it back via pendingSteers and emits steer_delivered
    // when it later disappears (= the agent consumed it).
    if (messageId) {
      if (!entry.pendingSteers) entry.pendingSteers = [];
      entry.pendingSteers.push({ text: message, msgId: messageId, username });
    }
    console.log(`[Pi] steer() queued: session=${sessionId.slice(0, 8)} chars=${message.length} msgId=${messageId?.slice(0, 8) || '-'}`);
    await entry.session.steer(message);
  }

  async cancelSteer(sessionId: string, messageId: string): Promise<{ ok: boolean; text?: string; reason?: string }> {
    const entry = this.sessions.get(sessionId);
    if (!entry?.session) return { ok: false, reason: 'not_running' };

    const pending = entry.pendingSteers ?? [];
    const idx = pending.findIndex((p) => p.msgId === messageId);
    if (idx === -1) return { ok: false, reason: 'already_consumed' };

    const target = pending[idx];
    const sdkSteering = typeof (entry.session as any).getSteeringMessages === 'function'
      ? Array.from((entry.session as any).getSteeringMessages() as readonly string[])
      : [];
    if (!sdkSteering.includes(target.text)) {
      return { ok: false, reason: 'already_consumed' };
    }

    const remaining = pending.filter((_, i) => i !== idx);
    entry.suppressSteerDelivery = true;
    try {
      // Pi SDK currently exposes clearQueue(), but not remove-one. To cancel one
      // steer safely, clear the SDK queue and restore every still-pending steer
      // except the cancelled msgId. While doing this, queue_update events are
      // suppressed above so the temporary empty snapshot is not misread as
      // "the agent consumed every steer".
      const cleared = typeof (entry.session as any).clearQueue === 'function'
        ? (entry.session as any).clearQueue() as { steering?: string[]; followUp?: string[] }
        : { steering: [], followUp: [] };

      entry.pendingSteers = [];
      entry.lastSteering = [];

      for (const p of remaining) {
        entry.pendingSteers.push(p);
        await entry.session.steer(p.text);
      }

      if (Array.isArray(cleared.followUp) && typeof (entry.session as any).followUp === 'function') {
        for (const text of cleared.followUp) {
          await (entry.session as any).followUp(text);
        }
      }

      entry.lastSteering = typeof (entry.session as any).getSteeringMessages === 'function'
        ? Array.from((entry.session as any).getSteeringMessages() as readonly string[])
        : remaining.map((p) => p.text);
      console.log(`[Pi] steer cancelled: session=${sessionId.slice(0, 8)} msgId=${messageId.slice(0, 8)}`);
      return { ok: true, text: target.text };
    } catch (err: any) {
      console.warn(`[Pi] cancelSteer failed: session=${sessionId.slice(0, 8)} msgId=${messageId.slice(0, 8)} err=${err?.message || err}`);
      return { ok: false, reason: err?.message || 'cancel_failed' };
    } finally {
      entry.suppressSteerDelivery = false;
      entry.lastSteering = typeof (entry.session as any).getSteeringMessages === 'function'
        ? Array.from((entry.session as any).getSteeringMessages() as readonly string[])
        : (entry.pendingSteers ?? []).map((p) => p.text);
    }
  }

  abort(sessionId: string): void {
    const entry = this.sessions.get(sessionId);
    if (entry?.isRunning) {
      entry.abortRequested = true;
      entry.session.abort();
      // Force-resolve the yield loop in case SDK doesn't emit events after abort,
      // but keep isRunning=true until the prompt promise actually settles.
      entry._abortResolve?.();
    }
  }

  dispose(sessionId: string): void {
    const entry = this.sessions.get(sessionId);
    if (entry) {
      // Close in-process MCP servers (sandbox + tower-spawn) before disposing
      // the Pi session. Best-effort: close errors must not block disposal.
      if (entry.mcpServers) {
        for (const [name, server] of Object.entries(entry.mcpServers)) {
          try {
            const closeFn = server?.instance?.close;
            if (typeof closeFn === 'function') {
              Promise.resolve(closeFn.call(server.instance)).catch((err) => {
                console.warn(`[pi-engine] MCP server "${name}" close failed:`, err);
              });
            }
          } catch (err) {
            console.warn(`[pi-engine] MCP server "${name}" close threw:`, err);
          }
        }
      }
      entry.session.dispose();
      this.sessions.delete(sessionId);
    }
  }

  isRunning(sessionId: string): boolean {
    // startingSessions covers the createSession/switchModel await window
    // before entry.isRunning gets set; both must report busy.
    if (this.startingSessions.has(sessionId)) return true;
    return this.sessions.get(sessionId)?.isRunning || false;
  }

  /**
   * Build a fresh Pi sessionFile from Tower's canonical message history.
   *
   * Used by Hard Switch (workspace/decisions/2026-05-19-engine-hard-switch-design.md).
   * The new sessionFile path is returned for the caller to persist as
   * `sessions.pi_session_file`. Next `run()` call passes it via
   * `opts.engineSessionId` to resume.
   *
   * Invariants (caller's job):
   *   - sessionId is not actively running (this.isRunning() === false)
   *   - messages are chronological and free of hidden/system markers
   *
   * What this method does NOT do:
   *   - Touch the Pi runtime in any way (no createAgentSession, no LLM call)
   *   - Update sessions.engine — that's recordEngineSwitch()'s job
   *   - Restore image blobs from disk — Phase 2
   */
  async rehydrateFromMessages(
    sessionId: string,
    messages: ReadonlyArray<import('./types.js').RehydrateInputMessage>,
    cwd: string,
  ): Promise<string> {
    return rehydratePiSessionFromMessages(sessionId, messages, cwd);
  }

  getActiveCount(): number {
    let count = 0;
    for (const entry of this.sessions.values()) {
      if (entry.isRunning) count++;
    }
    return count;
  }

  getRunningSessionIds(): string[] {
    // Include both fully-running sessions AND sessions in the initialization window
    // (startingSessions covers the gap between this.startingSessions.add() and entry.isRunning=true).
    // Without this, check_session_status and connected:streamingSessions miss Pi sessions
    // during the createSession/switchModel await phase.
    const ids: string[] = [...this.startingSessions];
    for (const [id, entry] of this.sessions) {
      if (entry.isRunning && !ids.includes(id)) ids.push(id);
    }
    return ids;
  }

  // Pi has no orphan processes (in-process SDK), but we still keep interrupted-session metadata.
  init(): void {
    this.interruptedSessionIds = new Set(consumeInterruptedPiSessions());
    // Clean up stale fork session files from previous runs
    cleanupStalePiForkSessions();
  }

  shutdown(): void {
    const runningSessions = [...this.sessions.entries()]
      .filter(([, entry]) => entry.isRunning)
      .map(([sessionId]) => ({ sessionId, rootTurnId: getCurrentRootTurn(sessionId) }));
    this.interruptedSessionIds = new Set(runningSessions.map(({ sessionId }) => sessionId));
    gracefulPiShutdown(runningSessions.map(({ sessionId, rootTurnId }) => ({ id: sessionId, rootTurnId })));
    for (const entry of this.sessions.values()) {
      // Best-effort MCP close — see dispose() for rationale.
      if (entry.mcpServers) {
        for (const [name, server] of Object.entries(entry.mcpServers)) {
          try {
            const closeFn = server?.instance?.close;
            if (typeof closeFn === 'function') {
              Promise.resolve(closeFn.call(server.instance)).catch((err) => {
                console.warn(`[pi-engine] MCP server "${name}" close failed during shutdown:`, err);
              });
            }
          } catch {}
        }
      }
      try { entry.session.dispose(); } catch {}
    }
    this.sessions.clear();
  }

}

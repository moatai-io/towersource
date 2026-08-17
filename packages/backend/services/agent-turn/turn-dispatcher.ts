// Owns: the lightweight wake loop for durable agent-turn retries.
// Public API: createAgentTurnDispatcher. See README.md.

import { findDueAgentTurnRetries, type DueAgentTurnRetry } from './turn-supervisor.js';

export type AgentTurnDispatchCandidate = DueAgentTurnRetry;

export type AgentTurnDispatcher = {
  start(): void;
  wake(): void;
  wakeSoon(delayMs?: number): void;
  stop(): void;
};

let activeDispatcher: AgentTurnDispatcher | null = null;

type AgentTurnDispatcherDependencies = {
  dispatch(candidates: AgentTurnDispatchCandidate[]): Promise<void>;
  findDue?: typeof findDueAgentTurnRetries;
  intervalMs?: number;
  batchSize?: number;
  logger?: Pick<Console, 'log' | 'warn'>;
};

/**
 * Create one process-local wake loop over the durable `agent_turns` schedule.
 *
 * Discovery is intentionally separate from claim/execution. The existing Pi
 * recovery path still claims each root turn with `owner_token`, so duplicate
 * wakes or another backend process cannot create a second authoritative owner.
 */
export function createAgentTurnDispatcher(deps: AgentTurnDispatcherDependencies): AgentTurnDispatcher {
  const findDue = deps.findDue ?? findDueAgentTurnRetries;
  const intervalMs = Math.max(1_000, Math.min(deps.intervalMs ?? 15_000, 300_000));
  const batchSize = Math.max(1, Math.min(deps.batchSize ?? 20, 100));
  const logger = deps.logger ?? console;

  let interval: ReturnType<typeof setInterval> | null = null;
  let wakeTimer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;
  let scanning = false;
  let rerunRequested = false;

  const scan = async () => {
    if (stopped) return;
    if (scanning) {
      rerunRequested = true;
      return;
    }

    scanning = true;
    try {
      const candidates = await findDue({ limit: batchSize });
      if (candidates.length > 0) {
        logger.log(`[agent-turn-dispatcher] due=${candidates.length}`);
        await deps.dispatch(candidates);
      }
    } catch (error) {
      logger.warn('[agent-turn-dispatcher] scan failed:', error);
    } finally {
      scanning = false;
      if (rerunRequested && !stopped) {
        rerunRequested = false;
        queueMicrotask(() => void scan());
      }
    }
  };

  const wakeSoon = (delayMs = 0) => {
    if (stopped) return;
    const boundedDelay = Math.max(0, Math.min(delayMs, intervalMs));
    if (wakeTimer) clearTimeout(wakeTimer);
    wakeTimer = setTimeout(() => {
      wakeTimer = null;
      void scan();
    }, boundedDelay);
  };

  return {
    start() {
      if (stopped || interval) return;
      interval = setInterval(() => void scan(), intervalMs);
      wakeSoon(0);
    },
    wake() {
      wakeSoon(0);
    },
    wakeSoon,
    stop() {
      stopped = true;
      rerunRequested = false;
      if (interval) clearInterval(interval);
      if (wakeTimer) clearTimeout(wakeTimer);
      interval = null;
      wakeTimer = null;
    },
  };
}

/** Start the one backend dispatcher after active-mode startup gates pass. */
export function startAgentTurnDispatcher(deps: AgentTurnDispatcherDependencies): AgentTurnDispatcher {
  if (activeDispatcher) return activeDispatcher;
  activeDispatcher = createAgentTurnDispatcher(deps);
  activeDispatcher.start();
  return activeDispatcher;
}

/** Request a prompt scan after durable settlement clears `next_attempt_at`. */
export function wakeAgentTurnDispatcher(delayMs = 0): void {
  activeDispatcher?.wakeSoon(delayMs);
}

/** Stop timers during graceful backend shutdown. */
export function stopAgentTurnDispatcher(): void {
  activeDispatcher?.stop();
  activeDispatcher = null;
}

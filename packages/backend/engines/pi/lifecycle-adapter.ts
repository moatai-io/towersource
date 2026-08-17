// Observes Pi SDK lifecycle signals without changing Tower's terminal authority.
// Public API: PiLifecycleAdapter.

export type PiLifecycleShadowPhase =
  | 'running'
  | 'waiting_retry'
  | 'compacting'
  | 'settled';

export interface PiLifecycleShadowSnapshot {
  phase: PiLifecycleShadowPhase;
  agentEndSeen: boolean;
  agentSettledSeen: boolean;
  sdkIdleAtAgentSettled?: boolean;
  sdkIdleAtPromptSettled?: boolean;
  sdkIdleAtTowerTerminal?: boolean;
  promptSettled: boolean;
  towerTerminalSeen: boolean;
  summarizationRetryCount: number;
  compactionDepth: number;
  waitForIdle: 'unsupported' | 'pending' | 'resolved' | 'rejected';
  mismatches: string[];
}

interface PiLifecycleEvent {
  type?: string;
  success?: boolean;
}

/**
 * Shadow-only normalizer for Pi 0.82 lifecycle signals.
 *
 * It must not emit Tower events, close a run, abort a session, or delay prompt
 * settlement. Tower's terminalizer/watchdog remain authoritative while the
 * normalized observations are compared in production.
 */
export class PiLifecycleAdapter {
  private phase: PiLifecycleShadowPhase = 'running';
  private agentEndSeen = false;
  private agentSettledSeen = false;
  private sdkIdleAtAgentSettled: boolean | undefined;
  private sdkIdleAtPromptSettled: boolean | undefined;
  private sdkIdleAtTowerTerminal: boolean | undefined;
  private promptSettled = false;
  private towerTerminalSeen = false;
  private summarizationRetryCount = 0;
  private compactionDepth = 0;
  private waitForIdleState: PiLifecycleShadowSnapshot['waitForIdle'] = 'unsupported';
  private readonly mismatchSet = new Set<string>();

  constructor(private readonly sessionLabel: string) {}

  observeSdkEvent(event: PiLifecycleEvent, sdkIdle: boolean): void {
    switch (event.type) {
      case 'agent_end':
        this.agentEndSeen = true;
        break;
      case 'agent_settled':
        this.agentSettledSeen = true;
        this.sdkIdleAtAgentSettled = sdkIdle;
        this.phase = 'settled';
        if (!sdkIdle) this.mismatchSet.add('agent_settled_without_sdk_idle');
        break;
      case 'summarization_retry_scheduled':
        this.summarizationRetryCount++;
        this.phase = 'waiting_retry';
        break;
      case 'summarization_retry_attempt_start':
        this.phase = 'waiting_retry';
        break;
      case 'summarization_retry_finished':
        this.phase = event.success ? 'running' : 'waiting_retry';
        break;
      case 'compaction_start':
        this.compactionDepth++;
        this.phase = 'compacting';
        break;
      case 'compaction_end':
        this.compactionDepth = Math.max(0, this.compactionDepth - 1);
        if (this.compactionDepth === 0 && this.phase === 'compacting') this.phase = 'running';
        break;
    }
  }

  startWaitForIdleProbe(waitForIdle: (() => Promise<void>) | undefined): void {
    if (!waitForIdle) return;
    this.waitForIdleState = 'pending';
    void waitForIdle().then(
      () => {
        this.waitForIdleState = 'resolved';
        this.log('waitForIdle-resolved');
      },
      (error: unknown) => {
        this.waitForIdleState = 'rejected';
        this.mismatchSet.add('waitForIdle_rejected');
        console.warn(`[PiLifecycleShadow] session=${this.sessionLabel} checkpoint=waitForIdle-rejected error=${JSON.stringify(String(error || 'unknown'))}`);
      },
    );
  }

  observePromptSettled(sdkIdle: boolean): void {
    this.promptSettled = true;
    this.sdkIdleAtPromptSettled = sdkIdle;
    if (!sdkIdle) this.mismatchSet.add('prompt_settled_without_sdk_idle');
    if (!this.agentSettledSeen) this.mismatchSet.add('prompt_settled_without_agent_settled');
    this.log('prompt-settled');
  }

  observeTowerTerminal(sdkIdle: boolean): void {
    this.towerTerminalSeen = true;
    this.sdkIdleAtTowerTerminal = sdkIdle;
    if (!this.agentSettledSeen) this.mismatchSet.add('tower_terminal_before_agent_settled');
    if (!sdkIdle) this.mismatchSet.add('tower_terminal_while_sdk_busy');
    this.log('tower-terminal');
  }

  snapshot(): PiLifecycleShadowSnapshot {
    return {
      phase: this.phase,
      agentEndSeen: this.agentEndSeen,
      agentSettledSeen: this.agentSettledSeen,
      sdkIdleAtAgentSettled: this.sdkIdleAtAgentSettled,
      sdkIdleAtPromptSettled: this.sdkIdleAtPromptSettled,
      sdkIdleAtTowerTerminal: this.sdkIdleAtTowerTerminal,
      promptSettled: this.promptSettled,
      towerTerminalSeen: this.towerTerminalSeen,
      summarizationRetryCount: this.summarizationRetryCount,
      compactionDepth: this.compactionDepth,
      waitForIdle: this.waitForIdleState,
      mismatches: [...this.mismatchSet],
    };
  }

  private log(checkpoint: string): void {
    console.log(`[PiLifecycleShadow] session=${this.sessionLabel} checkpoint=${checkpoint} snapshot=${JSON.stringify(this.snapshot())}`);
  }
}

import { describe, expect, it, vi } from 'vitest';
import { PiLifecycleAdapter } from '../pi/lifecycle-adapter.js';

describe('PiLifecycleAdapter shadow mode', () => {
  it('normalizes successful SDK settlement without becoming terminal authority', () => {
    const adapter = new PiLifecycleAdapter('session1');

    adapter.observeSdkEvent({ type: 'agent_end' }, false);
    adapter.observeSdkEvent({ type: 'agent_settled' }, true);
    adapter.observePromptSettled(true);
    adapter.observeTowerTerminal(true);

    expect(adapter.snapshot()).toMatchObject({
      phase: 'settled',
      agentEndSeen: true,
      agentSettledSeen: true,
      sdkIdleAtAgentSettled: true,
      sdkIdleAtPromptSettled: true,
      sdkIdleAtTowerTerminal: true,
      promptSettled: true,
      towerTerminalSeen: true,
      mismatches: [],
    });
  });

  it('tracks retry and compaction phases', () => {
    const adapter = new PiLifecycleAdapter('session2');

    adapter.observeSdkEvent({ type: 'summarization_retry_scheduled' }, false);
    expect(adapter.snapshot()).toMatchObject({ phase: 'waiting_retry', summarizationRetryCount: 1 });

    adapter.observeSdkEvent({ type: 'summarization_retry_attempt_start' }, false);
    adapter.observeSdkEvent({ type: 'summarization_retry_finished', success: true }, false);
    expect(adapter.snapshot().phase).toBe('running');

    adapter.observeSdkEvent({ type: 'compaction_start' }, false);
    expect(adapter.snapshot()).toMatchObject({ phase: 'compacting', compactionDepth: 1 });
    adapter.observeSdkEvent({ type: 'compaction_end' }, false);
    expect(adapter.snapshot()).toMatchObject({ phase: 'running', compactionDepth: 0 });
  });

  it('records ordering and idle mismatches for production comparison', () => {
    const adapter = new PiLifecycleAdapter('session3');

    adapter.observeTowerTerminal(false);
    adapter.observePromptSettled(false);

    expect(adapter.snapshot().mismatches).toEqual([
      'tower_terminal_before_agent_settled',
      'tower_terminal_while_sdk_busy',
      'prompt_settled_without_sdk_idle',
      'prompt_settled_without_agent_settled',
    ]);
  });

  it('probes waitForIdle asynchronously without blocking lifecycle observations', async () => {
    const adapter = new PiLifecycleAdapter('session4');
    const waitForIdle = vi.fn().mockResolvedValue(undefined);

    adapter.startWaitForIdleProbe(waitForIdle);
    expect(adapter.snapshot().waitForIdle).toBe('pending');

    await vi.waitFor(() => expect(adapter.snapshot().waitForIdle).toBe('resolved'));
    expect(waitForIdle).toHaveBeenCalledOnce();
  });
});

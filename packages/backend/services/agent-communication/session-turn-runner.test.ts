import { describe, expect, it, vi } from 'vitest';
import type { Engine, EngineCallbacks, RunOpts, TowerMessage } from '../../engines/types.js';
import { runSessionTurnStream } from './session-turn-runner.js';

const callbacks = {} as EngineCallbacks;
const runOpts = { cwd: '/workspace' } satisfies RunOpts;

function engineWith(messages: TowerMessage[]): Engine {
  return {
    async *run() {
      for (const message of messages) yield message;
    },
    async quickReply() {
      return '';
    },
  };
}

describe('runSessionTurnStream', () => {
  it('acknowledges start, preserves message order, and collects terminal evidence', async () => {
    const start = { acknowledge: vi.fn(), fail: vi.fn() };
    const onMessage = vi.fn();
    const messages: TowerMessage[] = [
      { type: 'assistant', sessionId: 's1', msgId: 'a1', content: [{ type: 'text', text: '완료' }] },
      {
        type: 'turn_terminal',
        sessionId: 's1',
        rootTurnId: 'r1',
        outcome: 'completed',
        reason: 'assistant_persisted',
        terminalAt: '2026-08-10T00:00:00.000Z',
        assistantMessageId: 'a1',
      },
      { type: 'engine_done', sessionId: 's1', outcome: 'completed', assistantMessageId: 'a1' },
    ];

    const result = await runSessionTurnStream({
      sessionId: 's1',
      prompt: 'report',
      engine: engineWith(messages),
      runOpts,
      callbacks,
      startAcknowledgement: start,
      onMessage,
    });

    expect(start.acknowledge).toHaveBeenCalledOnce();
    expect(start.fail).not.toHaveBeenCalled();
    expect(onMessage.mock.calls.map(([message]) => message.type)).toEqual([
      'assistant',
      'turn_terminal',
      'engine_done',
    ]);
    expect(result).toMatchObject({
      yieldedMessages: 3,
      lastAssistantText: '완료',
      terminalMessage: { outcome: 'completed', rootTurnId: 'r1' },
      engineDoneMessage: { outcome: 'completed', assistantMessageId: 'a1' },
    });
  });

  it('fails the start acknowledgement when the engine iterator throws', async () => {
    const error = new Error('iterator failed');
    const start = { acknowledge: vi.fn(), fail: vi.fn() };
    const engine: Engine = {
      async *run() {
        throw error;
      },
      async quickReply() {
        return '';
      },
    };

    await expect(runSessionTurnStream({
      sessionId: 's1',
      prompt: 'report',
      engine,
      runOpts,
      callbacks,
      startAcknowledgement: start,
      onMessage: vi.fn(),
    })).rejects.toThrow('iterator failed');

    expect(start.acknowledge).toHaveBeenCalledOnce();
    expect(start.fail).toHaveBeenCalledWith(error);
  });

  it('does not infer completion when the iterator ends without terminal evidence', async () => {
    const result = await runSessionTurnStream({
      sessionId: 's1',
      prompt: 'report',
      engine: engineWith([]),
      runOpts,
      callbacks,
      onMessage: vi.fn(),
    });

    expect(result).toEqual({
      yieldedMessages: 0,
      lastAssistantText: '',
      terminalMessage: undefined,
      engineDoneMessage: undefined,
    });
  });
});

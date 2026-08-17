import { describe, expect, it } from 'vitest';
import { decidePiTurnTerminal, decideTurnTerminal, toTurnTerminalMessage } from './turn-terminal';

const base = { sessionId: 'session-1', rootTurnId: 'root-1', terminalAt: '2026-08-02T00:00:00.000Z' };

describe('engine-neutral turn terminal authority', () => {
  it('classifies Claude and Pi with the same durable-assistant contract', () => {
    expect(decideTurnTerminal({ ...base, engineOutcome: 'completed', assistantMessageId: 'claude-a1' })).toMatchObject({
      outcome: 'completed',
      assistantMessageId: 'claude-a1',
    });
    expect(decidePiTurnTerminal({ ...base, engineOutcome: 'completed', assistantMessageId: 'pi-a1' })).toMatchObject({
      outcome: 'completed',
      assistantMessageId: 'pi-a1',
    });
  });

  it('requires an explicit completed outcome and durable assistant id', () => {
    expect(decidePiTurnTerminal({ ...base, engineOutcome: 'completed', assistantMessageId: 'assistant-1' })).toEqual({
      ...base,
      outcome: 'completed',
      reason: 'durable_assistant_completed',
      assistantMessageId: 'assistant-1',
    });
  });

  it('fails closed when completed has no durable assistant owner', () => {
    expect(decidePiTurnTerminal({ ...base, engineOutcome: 'completed' })).toMatchObject({
      outcome: 'needs_attention',
      reason: 'missing_durable_assistant',
    });
  });

  it('normalizes retry, failure, claim, and user stop without inferring success', () => {
    expect(decidePiTurnTerminal({ ...base, engineOutcome: 'retryable_failure', error: 'drop' })).toMatchObject({ outcome: 'waiting_retry' });
    expect(decidePiTurnTerminal({ ...base, engineOutcome: 'failed', error: 'bad' })).toMatchObject({ outcome: 'needs_attention' });
    expect(decidePiTurnTerminal({ ...base, engineOutcome: 'claim_denied' })).toMatchObject({ outcome: 'claim_denied' });
    expect(decidePiTurnTerminal({ ...base, engineOutcome: 'completed', assistantMessageId: 'a', stopMode: 'safe' })).toMatchObject({ outcome: 'stopped', reason: 'safe_stop' });
    expect(decidePiTurnTerminal({ ...base, engineOutcome: 'completed', assistantMessageId: 'a', stopMode: 'force' })).toMatchObject({ outcome: 'stopped', reason: 'forced_stop' });
  });

  it('projects the domain decision to one authoritative event shape', () => {
    const decision = decidePiTurnTerminal({ ...base, engineOutcome: 'completed', assistantMessageId: 'assistant-1' });
    expect(toTurnTerminalMessage(decision)).toEqual({ type: 'turn_terminal', ...decision });
  });
});

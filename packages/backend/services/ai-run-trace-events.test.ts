import { beforeEach, describe, expect, it, vi } from 'vitest';

const execute = vi.fn();
vi.mock('../db/pg-repo.js', () => ({ execute }));

const { recordAiRunTraceEvent } = await import('./ai-run-trace-events.js');

describe('recordAiRunTraceEvent', () => {
  beforeEach(() => execute.mockReset());

  it('persists structural trace metadata while scrubbing raw private text slots', async () => {
    await recordAiRunTraceEvent({
      sessionId: 'session-1',
      rootTurnId: 'turn-1',
      messageId: 'msg-1',
      projectId: 'project-1',
      actorUserId: 123,
      engine: 'pi',
      model: 'gpt-5.5',
      eventType: 'commentary_signal',
      payload: {
        phase: 'commentary',
        raw: 'do not store',
        text: 'do not store',
        commentary_text: 'do not store',
        activeToolName: 'bash',
      },
    });

    expect(execute).toHaveBeenCalledTimes(1);
    const params = execute.mock.calls[0][1];
    const payload = JSON.parse(params[9]);
    expect(payload).toEqual({ phase: 'commentary', activeToolName: 'bash' });
    expect(JSON.stringify(payload)).not.toContain('do not store');
  });
});

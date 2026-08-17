import { describe, expect, it, vi } from 'vitest';
import { recordSessionSendShadow } from './send-shadow.js';

const input = {
  senderSessionId: 'session-a',
  recipientSessionId: 'session-b',
  senderUserId: 7,
  projectId: 'project-1',
  text: 'review this',
  renderedPrompt: '_(A 에서)_: review this',
  onComplete: 'wake' as const,
  sourceRootTurnId: 'legacy-message-1',
  workerId: 'worker-1',
  agentRunId: 'run-1',
};

describe('Session send inbox shadow', () => {
  it('projects the legacy send into a durable request envelope', async () => {
    const accept = vi.fn().mockResolvedValue({
      messageId: 'shadow-1', deliveryId: 'shadow-1:0', acceptedAt: '2026-08-10T12:00:00Z', duplicate: false,
    });

    await expect(recordSessionSendShadow(input, accept)).resolves.toMatchObject({ messageId: 'shadow-1' });
    expect(accept).toHaveBeenCalledWith(expect.objectContaining({
      senderSessionId: 'session-a', recipientSessionId: 'session-b', senderUserId: 7,
      kind: 'request', deliveryPolicy: 'wake', sourceRootTurnId: 'legacy-message-1',
      operationId: 'legacy-message-1', workerId: 'worker-1', agentRunId: 'run-1',
      body: { text: 'review this', renderedPrompt: '_(A 에서)_: review this', sourceType: 'agent_send' },
    }));
  });

  it('maps none to store-only without inventing delivery completion', async () => {
    const accept = vi.fn().mockResolvedValue({ messageId: 'shadow-2' });
    await recordSessionSendShadow({ ...input, onComplete: 'none' }, accept);
    expect(accept).toHaveBeenCalledWith(expect.objectContaining({ deliveryPolicy: 'store-only' }));
  });

  it('keeps a shadow database failure outside the legacy send failure surface', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const accept = vi.fn().mockRejectedValue(new Error('shadow unavailable'));

    await expect(recordSessionSendShadow(input, accept)).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('send shadow write failed'), expect.any(Error));
    warn.mockRestore();
  });
});

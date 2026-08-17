import { beforeEach, describe, expect, it, vi } from 'vitest';

const txQueryOne = vi.fn();
const txExecute = vi.fn();
const query = vi.fn();
const queryOne = vi.fn();

vi.mock('../../db/pg-repo.js', () => ({
  query: (...args: unknown[]) => query(...args),
  queryOne: (...args: unknown[]) => queryOne(...args),
  transaction: async (fn: (client: object) => Promise<unknown>) => fn({}),
  withClient: () => ({ queryOne: txQueryOne, execute: txExecute }),
}));

const { acceptAgentMessage, getAgentMessage, listAgentInbox } = await import('./inbox-store.js');

const envelope = {
  id: 'msg-1',
  senderSessionId: 'session-a',
  recipientSessionId: 'session-b',
  senderUserId: 7,
  projectId: 'project-1',
  kind: 'request' as const,
  body: { text: 'review this' },
  deliveryPolicy: 'wake' as const,
  correlationId: 'corr-1',
  rootConversationId: 'conv-1',
  operationId: 'op-1',
};

function row(id: string) {
  return {
    id,
    sender_session_id: 'session-a', recipient_session_id: 'session-b', sender_user_id: 7,
    project_id: 'project-1', kind: 'request', body: { text: 'review this' },
    delivery_policy: 'wake', priority: 'normal', correlation_id: 'corr-1',
    causation_id: null, in_reply_to_message_id: null, root_conversation_id: 'conv-1',
    worker_id: null, agent_run_id: null, source_root_turn_id: null, operation_id: 'op-1',
    status: 'accepted', created_at: '2026-08-10T12:00:00.000Z', expires_at: null,
  };
}

describe('Agent inbox store', () => {
  beforeEach(() => {
    txQueryOne.mockReset();
    txExecute.mockReset();
    query.mockReset();
    queryOne.mockReset();
  });

  it('atomically creates the message and initial pending delivery', async () => {
    txQueryOne.mockResolvedValueOnce({ id: 'msg-1', created_at: '2026-08-10T12:00:00.000Z' });
    txExecute.mockResolvedValueOnce({ changes: 1 });

    await expect(acceptAgentMessage(envelope)).resolves.toEqual({
      messageId: 'msg-1', deliveryId: 'msg-1:0', acceptedAt: '2026-08-10T12:00:00.000Z', duplicate: false,
    });

    expect(txQueryOne).toHaveBeenCalledWith(expect.stringContaining('INSERT INTO agent_messages'), expect.any(Array));
    expect(txExecute).toHaveBeenCalledWith(expect.stringContaining("VALUES ($1,$2,$3,'pending',0,NOW())"), ['msg-1:0', 'msg-1', 'session-b']);
  });

  it('returns the existing receipt for an idempotent retry', async () => {
    txQueryOne
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({ id: 'msg-existing', created_at: '2026-08-10T11:00:00.000Z' })
      .mockResolvedValueOnce({ id: 'msg-existing:0' });

    await expect(acceptAgentMessage(envelope)).resolves.toEqual({
      messageId: 'msg-existing', deliveryId: 'msg-existing:0', acceptedAt: '2026-08-10T11:00:00.000Z', duplicate: true,
    });
    expect(txExecute).not.toHaveBeenCalled();
  });

  it('rejects invalid self-send and reply envelopes before persistence', async () => {
    await expect(acceptAgentMessage({ ...envelope, recipientSessionId: 'session-a' })).rejects.toThrow('Sender and recipient Sessions must differ');
    await expect(acceptAgentMessage({ ...envelope, kind: 'reply' as const })).rejects.toThrow('Replies require inReplyToMessageId');
    expect(txQueryOne).not.toHaveBeenCalled();
  });

  it('maps durable rows and bounds inbox list size', async () => {
    queryOne.mockResolvedValueOnce(row('msg-1'));
    query.mockResolvedValueOnce([row('msg-1'), row('msg-2')]);

    await expect(getAgentMessage('msg-1')).resolves.toMatchObject({ id: 'msg-1', deliveryPolicy: 'wake' });
    await expect(listAgentInbox('session-b', 999)).resolves.toHaveLength(2);
    expect(query).toHaveBeenCalledWith(expect.stringContaining('ORDER BY created_at ASC, id ASC'), ['session-b', 200]);
  });
});

import { beforeEach, describe, expect, it, vi } from 'vitest';

const execute = vi.fn();
const query = vi.fn();
const queryOne = vi.fn();
vi.mock('../../db/pg-repo.js', () => ({ execute, query, queryOne }));

const { issueConversationResumeGrant, resumeConversation } = await import('./conversation-resume.js');

describe('AI Service Conversation resume grants', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns a raw resume token once and stores only its hash', async () => {
    const grant = await issueConversationResumeGrant({ conversationId: 'conv-1', serviceId: 'svc-1', channelId: 'channel-1', tenantKey: 'tenant-1', userKey: 'user-1' });
    expect(grant.resumeToken).toMatch(/^tasr_v1\.[A-Za-z0-9_-]+$/);
    const params = execute.mock.calls[0][1] as unknown[];
    expect(params[5]).toMatch(/^[a-f0-9]{64}$/);
    expect(params).not.toContain(grant.resumeToken);
  });

  it('requires token, visitor identity, Channel and Conversation scope before returning bounded history', async () => {
    queryOne.mockResolvedValue({ id: 'conv-1', deployment_id: 'dep-1' });
    query.mockResolvedValue([
      { role: 'user', content: { text: '질문' }, created_at: '2026-08-09T00:00:00.000Z' },
      { role: 'tool', content: { text: 'private tool evidence' }, created_at: '2026-08-09T00:00:01.000Z' },
      { role: 'assistant', content: { text: '답변' }, created_at: '2026-08-09T00:00:02.000Z' },
    ]);
    const result = await resumeConversation({ conversationId: 'conv-1', channelId: 'channel-1', tenantKey: 'tenant-1', userKey: 'user-1', resumeToken: 'tasr_v1.valid' });
    expect(queryOne).toHaveBeenCalledWith(expect.stringContaining('g.tenant_key=$3 AND g.user_key=$4 AND g.token_hash=$5'), expect.arrayContaining(['conv-1', 'channel-1', 'tenant-1', 'user-1']));
    expect(query).toHaveBeenCalledWith(expect.stringContaining("role IN ('user','assistant','system')"), ['conv-1', 'channel-1', 200]);
    expect(result).toEqual({ id: 'conv-1', deploymentId: 'dep-1', messages: [
      { role: 'user', text: '질문', createdAt: '2026-08-09T00:00:00.000Z' },
      { role: 'assistant', text: '답변', createdAt: '2026-08-09T00:00:02.000Z' },
    ] });
  });

  it('fails closed for an invalid or expired resume grant', async () => {
    queryOne.mockResolvedValue(undefined);
    const invalidResumeToken = 'tasr_' + 'v1.invalid';
    await expect(resumeConversation({ conversationId: 'conv-1', channelId: 'channel-1', tenantKey: 'tenant-1', userKey: 'user-1', resumeToken: invalidResumeToken }))
      .rejects.toThrow('invalid or expired');
    expect(query).not.toHaveBeenCalled();
  });
});

import { beforeEach, describe, expect, it, vi } from 'vitest';

const execute = vi.fn();
const queryOne = vi.fn();
vi.mock('../../db/pg-repo.js', () => ({ execute, queryOne }));

const { getChannelUsageSummary, recordChannelUsageEvent } = await import('./channel-usage.js');

describe('AI Service Channel usage ledger', () => {
  beforeEach(() => vi.clearAllMocks());

  it('records channel usage with service/channel/tenant/user dimensions', async () => {
    await recordChannelUsageEvent({
      serviceId: 'svc-1',
      channelId: 'ch-1',
      conversationId: 'conv-1',
      tenantKey: 'tenant-1',
      userKey: 'user-1',
      eventType: 'message_turn',
      exposure: 'auth-required',
      metadata: { route: 'public' },
    });

    expect(execute).toHaveBeenCalledWith(expect.stringContaining('ai_service_channel_usage_events'), [
      'svc-1', 'ch-1', 'conv-1', 'tenant-1', 'user-1', 'message_turn', 'auth-required', JSON.stringify({ route: 'public' }),
    ]);
  });

  it('summarizes recent usage and quota status without mutating state', async () => {
    queryOne.mockResolvedValueOnce({ config: { servingQuota: { windowSeconds: 60, channelLimit: 120, tenantLimit: 30, tenantDailyLimit: 1000 } } });
    queryOne.mockResolvedValueOnce({
      message_turns: '96',
      channel_daily_message_turns: '180',
      credential_issued: '3',
      conversations_created: '4',
      unique_tenants: '2',
      top_tenant_key: 'tenant-1',
      top_tenant_message_turns: '80',
    });

    const summary = await getChannelUsageSummary({ serviceId: 'svc-1', channelId: 'ch-1' });

    expect(queryOne).toHaveBeenNthCalledWith(2, expect.stringContaining('tenant_counts'), ['svc-1', 'ch-1', 60]);
    expect(execute).not.toHaveBeenCalled();
    expect(summary).toMatchObject({
      serviceId: 'svc-1',
      channelId: 'ch-1',
      windowSeconds: 60,
      channelLimit: 120,
      tenantLimit: 30,
      tenantDailyLimit: 1000,
      channelMessageTurns: 96,
      channelDailyMessageTurns: 180,
      credentialIssued: 3,
      conversationsCreated: 4,
      uniqueTenants: 2,
      topTenant: { tenantKey: 'tenant-1', messageTurns: 80 },
      quota: { channelRemaining: 24, status: 'near' },
    });
  });
});

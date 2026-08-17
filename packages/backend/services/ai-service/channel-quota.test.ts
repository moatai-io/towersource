import { beforeEach, describe, expect, it, vi } from 'vitest';

const queryOne = vi.fn();
vi.mock('../../db/pg-repo.js', () => ({ queryOne }));

const { assertChannelQuota, getChannelQuotaConfig, updateChannelQuotaConfig } = await import('./channel-quota.js');

describe('AI Service Channel quota enforcement', () => {
  beforeEach(() => vi.clearAllMocks());

  it('allows traffic under configured per-channel, per-tenant and daily limits', async () => {
    queryOne.mockResolvedValueOnce({ config: { servingQuota: { windowSeconds: 60, channelLimit: 20, tenantLimit: 5, tenantDailyLimit: 50 } } });
    queryOne.mockResolvedValueOnce({ channel_count: '10', tenant_count: '2', tenant_daily_count: '8' });
    await expect(assertChannelQuota({ serviceId: 'svc-1', channelId: 'ch-1', tenantKey: 'tenant-1' })).resolves.toBeUndefined();
  });

  it('rejects when the channel limit is reached', async () => {
    queryOne.mockResolvedValueOnce({ config: null });
    queryOne.mockResolvedValueOnce({ channel_count: '20', tenant_count: '2', tenant_daily_count: '8' });
    await expect(assertChannelQuota({ serviceId: 'svc-1', channelId: 'ch-1', tenantKey: 'tenant-1', channelLimit: 20, tenantLimit: 5 })).rejects.toThrow('Channel quota exceeded');
  });

  it('rejects when the tenant limit is reached', async () => {
    queryOne.mockResolvedValueOnce({ config: null });
    queryOne.mockResolvedValueOnce({ channel_count: '10', tenant_count: '5', tenant_daily_count: '8' });
    await expect(assertChannelQuota({ serviceId: 'svc-1', channelId: 'ch-1', tenantKey: 'tenant-1', channelLimit: 20, tenantLimit: 5 })).rejects.toThrow('tenant quota exceeded');
  });

  it('rejects when the tenant daily limit is reached', async () => {
    queryOne.mockResolvedValueOnce({ config: null });
    queryOne.mockResolvedValueOnce({ channel_count: '10', tenant_count: '2', tenant_daily_count: '50' });
    await expect(assertChannelQuota({ serviceId: 'svc-1', channelId: 'ch-1', tenantKey: 'tenant-1', channelLimit: 20, tenantLimit: 5, tenantDailyLimit: 50 })).rejects.toThrow('tenant daily quota exceeded');
  });

  it('reads legacy publicQuota and updates servingQuota in channel config', async () => {
    queryOne.mockResolvedValueOnce({ config: { publicQuota: { perChannelPerMinute: 10, perTenantPerMinute: 3, perTenantPerDay: 40 } } });
    await expect(getChannelQuotaConfig({ serviceId: 'svc-1', channelId: 'ch-1' })).resolves.toMatchObject({ channelLimit: 10, tenantLimit: 3, tenantDailyLimit: 40 });

    queryOne.mockResolvedValueOnce({ config: { servingQuota: { windowSeconds: 30, channelLimit: 50, tenantLimit: 7, tenantDailyLimit: 500, tokenLimit: 1_000_000 } } });
    await expect(updateChannelQuotaConfig({ serviceId: 'svc-1', channelId: 'ch-1', limits: { windowSeconds: 30, channelLimit: 50, tenantLimit: 7, tenantDailyLimit: 500 } })).resolves.toMatchObject({ windowSeconds: 30, channelLimit: 50, tenantLimit: 7, tenantDailyLimit: 500, tokenLimit: 1_000_000 });
    expect(queryOne).toHaveBeenLastCalledWith(expect.stringContaining("jsonb_set(COALESCE(config,'{}'::jsonb), '{servingQuota}'"), ['ch-1', 'svc-1', JSON.stringify({ windowSeconds: 30, channelLimit: 50, tenantLimit: 7, tenantDailyLimit: 500, tokenLimit: 1_000_000 })]);
  });
});

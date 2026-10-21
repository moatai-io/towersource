import { beforeEach, describe, expect, it, vi } from 'vitest';
const client = { query: vi.fn() };
vi.mock('../../db/pg-repo.js', () => ({ transaction: async (fn: any) => fn(client) }));
import { joinAgentAsAdministrator } from './admin-agent-membership.js';
const rows = (value: any[]) => ({ rows: value });
describe('explicit administrator Agent membership', () => {
  beforeEach(() => vi.resetAllMocks());
  it.each(['member','viewer'])('denies %s before project lookup', async role => {
    client.query.mockResolvedValueOnce(rows([{ role, disabled: 0 }]));
    await expect(joinAgentAsAdministrator('p', 7)).rejects.toMatchObject({ status: 403 });
    expect(client.query).toHaveBeenCalledTimes(1);
  });
  it('denies retired or missing Agent', async () => {
    client.query.mockResolvedValueOnce(rows([{ role: 'admin', disabled: 0 }])).mockResolvedValueOnce(rows([]));
    await expect(joinAgentAsAdministrator('p', 7)).rejects.toMatchObject({ status: 404 });
  });
  it('preserves existing membership without escalating owner privileges', async () => {
    client.query.mockResolvedValueOnce(rows([{ role: 'operator', disabled: 0 }])).mockResolvedValueOnce(rows([{ id:'p', user_id:8, name:'Agent' }])).mockResolvedValueOnce(rows([{ role:'member' }]));
    await expect(joinAgentAsAdministrator('p', 7)).resolves.toMatchObject({ changed:false, role:'member' });
    expect(client.query).toHaveBeenCalledTimes(3);
  });
  it.each(['admin','operator'])('joins %s as ordinary member with audit', async role => {
    client.query.mockResolvedValueOnce(rows([{ role, disabled:0 }])).mockResolvedValueOnce(rows([{ id:'p', user_id:8, name:'Agent' }])).mockResolvedValueOnce(rows([])).mockResolvedValueOnce(rows([])).mockResolvedValueOnce(rows([])).mockResolvedValueOnce(rows([{ id:'audit' }])).mockResolvedValueOnce(rows([]));
    await expect(joinAgentAsAdministrator('p',7)).resolves.toMatchObject({ changed:true,role:'member' });
    expect(client.query.mock.calls[3][0]).toContain("'member'");
    expect(client.query.mock.calls[6][0]).toContain('administrator_participation_events');
  });
});

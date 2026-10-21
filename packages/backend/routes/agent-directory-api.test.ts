import { beforeEach, describe, expect, it, vi } from 'vitest';
const m = vi.hoisted(() => ({ previous: vi.fn(), list: vi.fn(), visibility: vi.fn() }));
vi.mock('../services/pm/agent-directory.js', () => ({
  listPreviousAgentParticipation: m.previous, listAgentDirectory: m.list, agentDirectoryVisibility: m.visibility,
  AgentDirectoryError: class extends Error { constructor(public status: number, message: string) { super(message); } },
}));
import router from './agent-directory-api.js';
import { AgentDirectoryError } from '../services/pm/agent-directory.js';
async function call(method: string, path: string, body?: any, user: any = { userId: 7, role: 'admin' }) {
  const route = router.stack.find((layer: any) => layer.route?.path === path && layer.route.methods[method])!.route!;
  const res: any = { status: vi.fn().mockReturnThis(), json: vi.fn() };
  await route.stack.at(-1)!.handle({ user, body, params: { projectId: 'agent' } } as any, res, vi.fn());
  return res;
}
beforeEach(() => { vi.resetAllMocks(); m.list.mockResolvedValue([]); m.visibility.mockResolvedValue({ projectId: 'agent', visibility: 'listed' }); });
describe('agent directory HTTP boundary', () => {
  it('passes identity but not the cached elevated role to current-account policy', async () => {
    const res = await call('get', '/'); expect(m.list).toHaveBeenCalledWith(7); expect(res.json).toHaveBeenCalledWith({ agents: [] });
  });
  it('rejects missing auth before querying', async () => {
    expect((await call('get', '/', null, null)).status).toHaveBeenCalledWith(401); expect(m.list).not.toHaveBeenCalled();
  });
  it.each([{}, { visibility: 'listed' }, { visibility: 'private', confirmed: true }, { visibility: 'listed', confirmed: 'true' }, { visibility: 'listed', confirmed: true, role: 'owner' }, []])('rejects invalid/unconfirmed input %j', async body => {
    expect((await call('patch', '/:projectId/visibility', body)).status).toHaveBeenCalledWith(400); expect(m.visibility).not.toHaveBeenCalled();
  });
  it('reads protected visibility settings', async () => {
    await call('get', '/:projectId/visibility'); expect(m.visibility).toHaveBeenCalledWith(7, 'agent');
  });
  it('applies an exact confirmed setting', async () => {
    await call('patch', '/:projectId/visibility', { visibility: 'confidential', confirmed: true });
    expect(m.visibility).toHaveBeenCalledWith(7, 'agent', 'confidential');
  });
  it('preserves service permission failures', async () => {
    m.visibility.mockRejectedValue(new AgentDirectoryError(403, 'Owner required'));
    expect((await call('patch', '/:projectId/visibility', { visibility: 'listed', confirmed: true })).status).toHaveBeenCalledWith(403);
  });
  it('does not expose database/path errors', async () => {
    m.list.mockRejectedValue(new Error('/protected/path SQL database detail'));
    const res = await call('get', '/'); expect(res.status).toHaveBeenCalledWith(500); expect(res.json).toHaveBeenCalledWith({ error: 'Agent directory unavailable' });
  });
});

it('lists name-only previous participation through current account policy', async () => {
  m.previous.mockResolvedValue([{ id: 'old-agent', name: 'Old agent' }]);
  const res = await call('get', '/previous-participation');
  expect(m.previous).toHaveBeenCalledWith(7);
  expect(res.json).toHaveBeenCalledWith({ agents: [{ id: 'old-agent', name: 'Old agent' }] });
});
it('rejects unauthenticated history discovery', async () => {
  expect((await call('get', '/previous-participation', undefined, null)).status).toHaveBeenCalledWith(401);
  expect(m.previous).not.toHaveBeenCalled();
});

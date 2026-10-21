vi.mock('./personal-session.js',()=>({ensurePersonalSecretarySession:vi.fn().mockResolvedValue('secretary')}));
import { describe, it, expect, vi, beforeEach } from 'vitest';
vi.mock('../../db/pg-repo.js', () => ({ queryOne: vi.fn(), query: vi.fn(), execute: vi.fn() }));
vi.mock('../pm/project-access.js', () => ({ canAccessSession: vi.fn() }));
vi.mock('../pm/project-membership-manager.js', () => ({ isProjectMember: vi.fn() }));
vi.mock('./provider.js', () => ({ prepareProviders: vi.fn(), safeCandidate: (c: any) => !c.title.includes('password:') }));
import { createSecretariatService, activeRole, canReadSource, SecretariatAccessError } from './service.js';
import { queryOne } from '../../db/pg-repo.js';
import { canAccessSession } from '../pm/project-access.js';
import { isProjectMember } from '../pm/project-membership-manager.js';
import type { SecretariatStore } from './store.js';

const candidate = { id: 'work', sourceKey: 'work:now', title: '보고서 초안', outcome: '비교표를 작성한다.',
  sessionId: 'session', projectId: 'project', updatedAt: '2026-09-21T00:00:00Z' };
function fixture() {
  const store = {
    secretaryContext: vi.fn().mockResolvedValue([]),
    context: vi.fn().mockResolvedValue([{ role: 'user', text: '비용 기준이 필요합니다.' }]),
    settings: vi.fn().mockResolvedValue({ enabled: true }), setEnabled: vi.fn().mockResolvedValue({ enabled: true }),
    proposals: vi.fn().mockResolvedValue([]), hasUnread: vi.fn().mockResolvedValue(false), read: vi.fn().mockResolvedValue(true),
    defer: vi.fn().mockResolvedValue(undefined), claim: vi.fn().mockResolvedValue({ userId: 7, token: 'claim', generation: 0 }), stillAllowed: vi.fn().mockResolvedValue(true),
    sourceCurrent: vi.fn().mockResolvedValue(true), candidates: vi.fn().mockResolvedValue([candidate]), insert: vi.fn().mockResolvedValue(true), finish: vi.fn().mockResolvedValue(undefined), dueUsers: vi.fn(),
  };
  const provider = { choose: vi.fn().mockResolvedValue({ id: 'work', score: 0.9 }),
    write: vi.fn().mockResolvedValue({ title: '비교표를 정리할까요?', body: '초안의 비교 항목을 먼저 정할까요?', delivery: 'popup' }) };
  const deps = { store: store as unknown as SecretariatStore, activeRole: vi.fn().mockResolvedValue('member'),
    canReadSource: vi.fn().mockResolvedValue(true), prepare: vi.fn().mockResolvedValue(provider) };
  return { service: createSecretariatService(deps), deps, store, provider };
}
beforeEach(() => vi.clearAllMocks());
describe('personal Secretariat execution', () => {
  it('does nothing when account is ineligible or opt-in is off', async () => {
    const f = fixture(); f.deps.activeRole.mockResolvedValue(null);
    expect(await f.service.runUser(7)).toBe('skipped');
    f.deps.activeRole.mockResolvedValue('member'); f.store.settings.mockResolvedValue({ enabled: false });
    expect(await f.service.runUser(7)).toBe('skipped');
    expect(f.store.claim).not.toHaveBeenCalled(); expect(f.deps.prepare).not.toHaveBeenCalled();
  });
  it('pauses unread before claim, credentials, Jev, and Lite', async () => {
    const f = fixture(); f.store.hasUnread.mockResolvedValue(true);
    expect(await f.service.runUser(7)).toBe('skipped');
    expect(f.store.claim).not.toHaveBeenCalled(); expect(f.deps.prepare).not.toHaveBeenCalled();
    expect(f.provider.choose).not.toHaveBeenCalled(); expect(f.provider.write).not.toHaveBeenCalled();
    expect(f.store.defer).toHaveBeenCalledWith(7);
  });
  it('does not run without a durable winning claim', async () => {
    const f = fixture(); f.store.claim.mockResolvedValue(null);
    expect(await f.service.runUser(7)).toBe('skipped'); expect(f.deps.prepare).not.toHaveBeenCalled();
  });
  it('makes one Jev and one tool-free Lite call then inserts owner-scoped proposal', async () => {
    const f = fixture(); expect(await f.service.runUser(7)).toBe('proposed');
    expect(f.deps.prepare).toHaveBeenCalledWith(7, 'project');
    expect(f.provider.choose).toHaveBeenCalledTimes(1); expect(f.provider.write).toHaveBeenCalledWith(expect.objectContaining({ id: candidate.id }), [{ role: 'user', text: '비용 기준이 필요합니다.' }]);
    expect(f.store.insert).toHaveBeenCalledWith({ userId: 7, token: 'claim', generation: 0 }, expect.objectContaining({ id: candidate.id }),
      { title: '비교표를 정리할까요?', body: '초안의 비교 항목을 먼저 정할까요?', delivery: 'popup' });
    expect(f.store.finish).toHaveBeenCalledWith(expect.anything(), 'proposed', expect.objectContaining({ reason: 'proposal_created', modelCalls: 2 }));
  });
  it('does not send other Project metadata under a gateway Project grant', async () => {
    const f = fixture(); f.store.candidates.mockResolvedValue([candidate, { ...candidate, id: 'other', projectId: 'other-project' }]);
    await f.service.runUser(7); expect(f.deps.prepare).toHaveBeenCalledWith(7, 'other-project'); expect(f.provider.choose).toHaveBeenCalledWith(expect.arrayContaining([expect.objectContaining({ id: 'other' })]), expect.any(Function));
  });
  it('rejects inaccessible or secret-bearing sources before provider setup', async () => {
    const f = fixture(); f.deps.canReadSource.mockResolvedValue(false);
    await f.service.runUser(7); expect(f.deps.prepare).not.toHaveBeenCalled();
    f.deps.canReadSource.mockResolvedValue(true); f.store.candidates.mockResolvedValue([{ ...candidate, title: 'password: fake' }]);
    await f.service.runUser(7); expect(f.deps.prepare).not.toHaveBeenCalled();
  });
  it('withdraws inaccessible unread proposals without exposing content or blocking forever', async () => {
    const f = fixture(); f.store.proposals.mockResolvedValue([{ id: 'hidden', readAt: null, sessionId: 'lost', projectId: 'lost' }]);
    f.deps.canReadSource.mockResolvedValue(false);
    expect((await f.service.inbox(7)).proposals).toEqual([]);
    expect(f.store.read).toHaveBeenCalledWith(7, 'hidden');
  });
  it('skips Lite when Jev abstains or chooses an unknown source', async () => {
    const f = fixture(); f.provider.choose.mockResolvedValue(null); await f.service.runUser(7);
    f.provider.choose.mockResolvedValue({ id: 'unknown', score: 0.9 }); await f.service.runUser(7);
    expect(f.provider.write).not.toHaveBeenCalled(); expect(f.store.insert).not.toHaveBeenCalled();
  });
  it('rechecks opt-out/unread immediately after Jev before Lite', async () => {
    const f = fixture(); f.provider.choose.mockImplementation(async () => {
      f.store.stillAllowed.mockResolvedValue(false); return { id: 'work', direction: 'make_next_step_smaller' };
    });
    expect(await f.service.runUser(7)).toBe('skipped'); expect(f.provider.write).not.toHaveBeenCalled();
  });
  it('does not call Lite if Jev work completed or source changed', async () => {
    const f = fixture(); f.provider.choose.mockImplementation(async () => {
      f.store.sourceCurrent.mockResolvedValue(false); return { id: 'work', score: 0.9 };
    });
    expect(await f.service.runUser(7)).toBe('skipped'); expect(f.provider.write).not.toHaveBeenCalled();
  });
  it('rechecks source permission immediately after Lite before insert', async () => {
    const f = fixture(); f.provider.write.mockImplementation(async () => {
      f.deps.canReadSource.mockResolvedValue(false); return { title: 'test', body: 'test?' };
    });
    expect(await f.service.runUser(7)).toBe('skipped'); expect(f.store.insert).not.toHaveBeenCalled();
  });
  it('fails quietly on missing provider and never inserts a fallback', async () => {
    const f = fixture(); f.deps.prepare.mockRejectedValue(new Error('unconfigured'));
    expect(await f.service.runUser(7)).toBe('skipped'); expect(f.store.insert).not.toHaveBeenCalled();
    expect(f.store.finish).toHaveBeenCalledWith(expect.anything(), 'skipped', expect.anything());
  });
  it('does not insert invalid/empty Lite output', async () => {
    const f = fixture(); f.provider.write.mockResolvedValue(null);
    expect(await f.service.runUser(7)).toBe('skipped'); expect(f.store.insert).not.toHaveBeenCalled();
  });
  it('scopes settings/read by authenticated owner and denies inactive accounts', async () => {
    const f = fixture(); await f.service.setEnabled(7, true); await f.service.read(7, 'id');
    expect(f.store.setEnabled).toHaveBeenCalledWith(7, true); expect(f.store.read).toHaveBeenCalledWith(7, 'id');
    f.deps.activeRole.mockResolvedValue(null); await expect(f.service.inbox(7)).rejects.toBeInstanceOf(SecretariatAccessError);
  });
});
describe('source access checks', () => {
  it('requires current active eligible account', async () => {
    vi.mocked(queryOne).mockResolvedValueOnce(undefined); expect(await activeRole(7)).toBeNull();
  });
  it('requires member and operator Project membership even for an owned session', async () => {
    vi.mocked(queryOne).mockResolvedValueOnce({ role: 'operator' }).mockResolvedValueOnce({ ok: 1 });
    vi.mocked(isProjectMember).mockResolvedValue(false);
    expect(await canReadSource(7, 'session', 'project')).toBe(false); expect(canAccessSession).not.toHaveBeenCalled();
  });
  it('uses current session audience checks, not ownership alone', async () => {
    vi.mocked(queryOne).mockResolvedValueOnce({ role: 'member' }).mockResolvedValueOnce({ ok: 1 });
    vi.mocked(isProjectMember).mockResolvedValue(true); vi.mocked(canAccessSession).mockResolvedValue({ allowed: false, status: 403, message: 'denied' });
    expect(await canReadSource(7, 'session', 'project')).toBe(false);
    expect(canAccessSession).toHaveBeenCalledWith('session', 7, 'member');
  });
});

it('manual check bypasses opt-in gate without enabling automatic checks', async () => {
  const f = fixture(); f.store.settings.mockResolvedValue({ enabled: false });
  expect(await f.service.runUser(7, true)).toBe('proposed');
  expect(f.store.claim).toHaveBeenCalledWith(7, true);
  expect(f.store.insert).toHaveBeenCalledWith(expect.anything(), expect.anything(), expect.objectContaining({ delivery: 'inbox' }));
});

it('passes only selected-task secretary context to proposal writer', async () => {
  const f = fixture();
  f.store.secretaryContext.mockResolvedValue([{ role: 'user', text: '[Recent private secretary conversation] 그건 끝났어.' }]);
  await f.service.runUser(7);
  expect(f.store.secretaryContext).toHaveBeenCalledWith(7, expect.objectContaining({sessionId:'session',projectId:'project'}));
  expect(f.provider.write).toHaveBeenCalledWith(expect.anything(), expect.arrayContaining([{role:'user',text:'[Recent private secretary conversation] 그건 끝났어.'}]));
});

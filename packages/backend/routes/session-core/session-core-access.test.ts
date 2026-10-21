import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

const mocks = vi.hoisted(() => ({
  queryOne: vi.fn(), member: vi.fn(), share: vi.fn(), list: vi.fn(), panel: vi.fn(),
  get: vi.fn(), byKey: vi.fn(), create: vi.fn(), messages: vi.fn(), paginated: vi.fn(), context: vi.fn(), update: vi.fn(), composer: vi.fn(),
}));
vi.mock('../../db/pg-repo.js', () => ({ queryOne: mocks.queryOne }));
vi.mock('../../services/pm/project-membership-manager.js', () => ({ isProjectMember: mocks.member, getAccessibleProjectIds: vi.fn() }));
vi.mock('../../services/session/session-share-manager.js', () => ({ hasInternalShareAccess: mocks.share }));
vi.mock('../../services/session/session-manager.js', () => ({
  createSession: mocks.create, getPanelSessions: mocks.panel, getSession: mocks.get,
  getSessionByKey: mocks.byKey, getSessionPanelSessions: mocks.panel, getSessions: mocks.list, updateSession: mocks.update,
}));
vi.mock('../../services/message-store.js', () => ({ getComposerMessageContext: mocks.composer, getMessages: mocks.messages, getMessagesPaginated: mocks.paginated }));
vi.mock('../../services/session/session-creation-context.js', () => ({ resolveSessionCreationContext: mocks.context }));
vi.mock('../ws-handler.js', () => ({ broadcastToAll: vi.fn(), broadcastToUser: vi.fn() }));
import router from './session-core-router.js';

let server: Server;
let base: string;
let role: string;
const rows: Record<string, any> = {};
beforeEach(async () => {
  vi.resetAllMocks();
  role = 'operator';
  for (const key of Object.keys(rows)) delete rows[key];
  rows.private = { user_id: 20, project_id: 'project-a', visibility: 'private', room_id: null, label: null };
  rows.shared = { ...rows.private, visibility: 'project' };
  rows.owned = { ...rows.private, user_id: 10 };
  mocks.queryOne.mockImplementation(async (sql: string, params: any[]) => {
    if (sql.includes('FROM sessions')) return rows[params[0]];
    if (sql.includes('FROM chat_rooms')) return { exists: true, is_member: false };
    if (sql.includes('FROM project_members')) return { role: 'member' };
    return undefined;
  });
  mocks.member.mockResolvedValue(true);
  mocks.share.mockResolvedValue(false);
  mocks.byKey.mockImplementation(async (id: string) => ({ id }));
  mocks.get.mockImplementation(async (id: string) => ({ id, projectId: rows[id]?.project_id }));
  mocks.messages.mockResolvedValue([{ content: 'conversation text' }]);
  mocks.paginated.mockResolvedValue({ messages: [{ content: 'conversation text' }], hasMore: false });
  mocks.context.mockResolvedValue({ projectId: 'project-a', cwd: '/projects/project-a' });
  mocks.create.mockResolvedValue({ id: 'new-own-session', visibility: 'private' });
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { (req as any).user = { userId: 10, role }; next(); });
  app.use(router);
  server = createServer(app);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterEach(async () => { await new Promise<void>((resolve, reject) => server.close(err => err ? reject(err) : resolve())); });

async function post(body: unknown) {
  return fetch(`${base}/sessions`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
}

describe('Session Core HTTP privacy boundaries with real access predicates', () => {
  it('allows an explicitly project-shared Introduction conversation through normal access checks', async () => {
    mocks.context.mockResolvedValueOnce({ projectId: 'intro', cwd: '/projects/introduction' });
    const result = await post({ projectId: 'intro', visibility: 'project' });
    expect(result.status).toBe(200);
    expect(mocks.create).toHaveBeenCalled();
  });

  it.each(['/sessions/private', '/sessions/private/full', '/sessions/private/messages', '/sessions/private/messages?limit=10'])(
    'denies company administrator at %s before any message read', async (url) => {
      expect((await fetch(base + url)).status).toBe(403);
      expect(mocks.messages).not.toHaveBeenCalled();
      expect(mocks.paginated).not.toHaveBeenCalled();
    },
  );
  it('preserves owner and member message reads while rejecting private shares', async () => {
    expect((await fetch(`${base}/sessions/owned/messages`)).status).toBe(200);
    mocks.share.mockResolvedValue(true);
    expect((await fetch(`${base}/sessions/private/messages?limit=10`)).status).toBe(403);
    rows.private.visibility = 'project';
    mocks.member.mockResolvedValue(true);
    expect((await fetch(`${base}/sessions/private/messages?limit=10`)).status).toBe(200);
  });
  it.each(['admin', 'operator'])('rejects %s private metadata, message reads and audience inheritance before content reads', async (value) => {
    role = value;
    mocks.share.mockResolvedValue(true);
    mocks.member.mockResolvedValue(true);
    expect((await fetch(`${base}/sessions/private`)).status).toBe(403);
    expect((await fetch(`${base}/sessions/private/messages?limit=10`)).status).toBe(403);
    expect((await post({ parentSessionId: 'private', projectId: 'project-a' })).status).toBe(403);
    // Metadata lookup resolves shortCode to UUID before the audience decision.
    expect(mocks.byKey).toHaveBeenCalledTimes(1);
    expect(mocks.messages).not.toHaveBeenCalled();
    expect(mocks.create).not.toHaveBeenCalled();
  });
  it('returns metadata-only rows without a second per-row access pass', async () => {
    mocks.member.mockResolvedValue(false);
    mocks.list.mockResolvedValue([
            { id: 'shared', name: 'shared title' },
      { id: 'owned', name: 'my title', summary: 'my summary' },
    ]);
    const result = await (await fetch(`${base}/sessions?limit=10`)).json();
    expect(result).toEqual([
      { id: 'shared', name: 'shared title' },
      { id: 'owned', name: 'my title', summary: 'my summary' },
    ]);
    expect((await fetch(`${base}/sessions/shared/messages`)).status).toBe(403);
  });
  it('filters inaccessible child sessions even when the parent is readable', async () => {
    mocks.panel.mockResolvedValue([{ id: 'private', name: 'private child' }, { id: 'owned', name: 'own child' }]);
    const result = await (await fetch(`${base}/sessions?parentSessionId=owned`)).json();
    expect(result).toEqual([{ id: 'owned', name: 'own child' }]);
  });
  it('checks parent before creation context can inherit hidden session facts', async () => {
    expect((await post({ parentSessionId: 'private', cwd: '/explicit-override' })).status).toBe(403);
    expect(mocks.context).not.toHaveBeenCalled();
    expect(mocks.create).not.toHaveBeenCalled();
  });
  it('does not let operator project authority bypass channel audience', async () => {
    expect((await post({ roomId: 'room-a', projectId: 'project-a' })).status).toBe(403);
    expect((await fetch(`${base}/sessions?roomId=room-a`)).status).toBe(403);
    expect(mocks.create).not.toHaveBeenCalled();
    expect(mocks.panel).not.toHaveBeenCalled();
  });
  it.each(['viewer', 'guest'])('rejects %s new sessions without project as well', async (value) => {
    role = value;
    expect((await post({ name: 'new' })).status).toBe(403);
    expect(mocks.create).not.toHaveBeenCalled();
  });
  it('lets company administrator use the Agent in a new own session', async () => {
    expect((await post({ projectId: 'project-a', name: 'new own conversation' })).status).toBe(200);
    expect(mocks.create).toHaveBeenCalledWith('new own conversation', '/projects/project-a', 10, 'project-a', undefined, undefined, undefined, undefined, undefined, undefined, { visibility: undefined });
  });
});

it('composer uses bounded context, not whole message history', async () => {
  mocks.composer.mockResolvedValue({ content: '[{"type":"text","text":"Ready"}]', contextRevision: 123 });
  const result = await fetch(`${base}/sessions/owned/composer-actions`);
  expect(result.status).toBe(200);
  expect((await result.json()).contextRevision).toBe(123);
  expect(mocks.composer).toHaveBeenCalledWith('owned');
  expect(mocks.messages).not.toHaveBeenCalled();
});
it('composer denies private session before reading context', async () => {
  const result = await fetch(`${base}/sessions/private/composer-actions`);
  expect(result.status).toBe(403);
  expect(mocks.composer).not.toHaveBeenCalled();
});

it('passes private visibility into creation before broadcasting, without a follow-up shared INSERT window', async () => {
  mocks.create.mockResolvedValue({ id: 'created', visibility: 'private' });
  const result = await fetch(`${base}/sessions`, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'private conversation', projectId: 'project-a', visibility: 'private' }) });
  expect(result.status).toBe(200);
  expect(mocks.create.mock.calls[0][10]).toEqual({ visibility: 'private' });
  expect(mocks.update).not.toHaveBeenCalled();
});
it('leaves project default visibility to the atomic creation service', async () => {
  mocks.create.mockResolvedValue({ id: 'created', visibility: 'project' });
  const result = await fetch(`${base}/sessions`, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'team conversation', projectId: 'project-a' }) });
  expect(result.status).toBe(200);
  expect(mocks.create.mock.calls[0][10]).toEqual({ visibility: undefined });
  expect(mocks.update).not.toHaveBeenCalled();
});

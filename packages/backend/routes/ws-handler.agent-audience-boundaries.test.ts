import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';

/** Actual function bodies, synthetic state; no WS server, DB or provider startup. */
const source = readFileSync(new URL('./ws-handler.ts', import.meta.url), 'utf8');
const ast = ts.createSourceFile('ws-handler.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
function actual(name: string, globals: Record<string, unknown>) {
  const node = ast.statements.find(s => ts.isFunctionDeclaration(s) && s.name?.text === name);
  if (!node || !ts.isFunctionDeclaration(node)) throw new Error(`Function missing: ${name}`);
  const text = node.getText(ast).replace(/^export\s+/, '');
  const js = ts.transpileModule(text, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
  return vm.runInNewContext(`${js}\n${name}`, globals);
}
function actualDeliveryQueues(): Map<string, Promise<void>> {
  const declaration = ast.statements.find(s => ts.isVariableStatement(s)
    && s.declarationList.declarations.some(d => d.name.getText(ast) === 'sessionDeliveryQueues'));
  if (!declaration) throw new Error('sessionDeliveryQueues declaration missing');
  const js = ts.transpileModule(declaration.getText(ast), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  return vm.runInNewContext(`${js}\nsessionDeliveryQueues`, { Map, Promise });
}
function client(role = 'member') {
  return { id: 'client-a', sessionId: 'old-session', userId: 7, userRole: role, ws: { readyState: 1, send: vi.fn(), close: vi.fn() } };
}

describe('Inbound socket identity refresh', () => {
  it('passes fresh role rather than body or cached admin role to chat', async () => {
    const c = client('admin'); const handleChat = vi.fn();
    const getUserAuthState = vi.fn(async () => ({ role: 'viewer', disabled: false, approvalStatus: 'active' }));
    await actual('handleMessage', { getUserAuthState, handleChat })(c, { type: 'chat', userId: 99, role: 'admin' });
    expect(c.userRole).toBe('viewer'); expect(getUserAuthState).toHaveBeenCalledWith(7);
    expect(handleChat).toHaveBeenCalledWith(c, expect.objectContaining({ type: 'chat' }));
    expect(getUserAuthState.mock.invocationCallOrder[0]).toBeLessThan(handleChat.mock.invocationCallOrder[0]);
  });
  it.each([null, { role: 'admin', disabled: true, approvalStatus: 'active' }, { role: 'admin', disabled: false, approvalStatus: 'pending' }])('blocks inactive current state %j before dispatch', async state => {
    const c = client('admin'); const handleChat = vi.fn();
    await actual('handleMessage', { getUserAuthState: vi.fn(async () => state), handleChat })(c, { type: 'chat' });
    expect(c.ws.close).toHaveBeenCalledWith(4003, 'account_inactive'); expect(handleChat).not.toHaveBeenCalled();
  });
  it('fails closed on current auth lookup failure', async () => {
    const c = client(); const handleChat = vi.fn();
    await actual('handleMessage', { getUserAuthState: vi.fn(async () => { throw new Error('synthetic unavailable'); }), handleChat })(c, { type: 'chat' });
    expect(c.ws.close).toHaveBeenCalledWith(4003, 'account_inactive'); expect(handleChat).not.toHaveBeenCalled();
  });
});

describe('Conversation control is denied before subscription changes', () => {
  it('does not move a reader subscription or enter execution on denied send', async () => {
    const c = client('operator'); const send = vi.fn(); const addSessionClient = vi.fn(); const removeSessionClient = vi.fn();
    const canSendSessionMessage = vi.fn(async () => ({ allowed: false, message: 'owner required' }));
    await actual('handleChat', { canSendSessionMessage, send, addSessionClient, removeSessionClient })(c, { sessionId: 'another-session', message: 'synthetic' });
    expect(canSendSessionMessage).toHaveBeenCalledWith('another-session', 7, 'operator');
    expect(c.sessionId).toBe('old-session'); expect(addSessionClient).not.toHaveBeenCalled(); expect(removeSessionClient).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalledWith(c.ws, expect.objectContaining({ errorCode: 'ACCESS_DENIED' }));
  });
});

describe('Session all-event audience filtering', () => {
  async function broadcast(c: ReturnType<typeof client>, allowed: boolean, failure = false, currentRole = c.userRole) {
    const canAccessSession = vi.fn(async () => { if (failure) throw new Error('unavailable'); return { allowed }; });
    const getUserAuthState = vi.fn(async () => ({ role: currentRole, disabled: false, approvalStatus: 'active' }));
    const g = { WebSocket: { OPEN: 1 }, clients: new Map([[c.id, c]]), canAccessSession, getUserAuthState };
    const isSessionScopedAllEvent = actual('isSessionScopedAllEvent', {});
    await actual('localBroadcastToAll', { ...g, isSessionScopedAllEvent })({ type: 'session_meta_update', sessionId: 'private-session', updates: { name: 'synthetic-private-title' } });
    return canAccessSession;
  }
  it('does not bypass private audience for company operator', async () => {
    const c = client('operator'); const check = await broadcast(c, false);
    expect(check).toHaveBeenCalledWith('private-session', 7, 'operator'); expect(c.ws.send).not.toHaveBeenCalled();
  });
  it('checks current audience for both shared viewers and platform admins', async () => {
    const shared = client('operator'); await broadcast(shared, true); expect(shared.ws.send).toHaveBeenCalledOnce();
    const admin = client('admin'); const check = await broadcast(admin, true);
    expect(check).toHaveBeenCalledWith('private-session', 7, 'admin'); expect(admin.ws.send).toHaveBeenCalledOnce();
  });
  it('does not let cached admin bypass a current role downgrade', async () => {
    const c = client('admin'); const check = await broadcast(c, false, false, 'operator');
    expect(c.userRole).toBe('operator'); expect(check).toHaveBeenCalledWith('private-session', 7, 'operator');
    expect(c.ws.send).not.toHaveBeenCalled();
  });
  it('fails closed when audience lookup fails', async () => {
    const c = client('operator'); await broadcast(c, true, true); expect(c.ws.send).not.toHaveBeenCalled();
  });
});

describe('Queued streaming current audience acceptance', () => {
  function setup(recipients = [client()]) {
    const sessionDeliveryQueues = actualDeliveryQueues();
    const sessionClients = new Map([['session-a', new Set(recipients.map(c => c.id))]]);
    const canAccessSession = vi.fn(async () => ({ allowed: true }));
    const getUserAuthState = vi.fn(async () => ({ role: 'member', disabled: false, approvalStatus: 'active' }));
    const deliver = actual('localBroadcastToSession', {
      WebSocket: { OPEN: 1 }, clients: new Map(recipients.map(c => [c.id, c])),
      sessionClients, sessionDeliveryQueues, canAccessSession, getUserAuthState,
    });
    async function drain() {
      while (sessionDeliveryQueues.size) await Promise.all([...sessionDeliveryQueues.values()]);
    }
    return { recipients, sessionClients, sessionDeliveryQueues, canAccessSession, getUserAuthState, deliver, drain };
  }
  it('denies current audience despite cached subscription', async () => {
    const s = setup(); s.canAccessSession.mockResolvedValue({ allowed: false });
    s.deliver('session-a', { type: 'tower_message', message: { text: 'synthetic-after-revocation' } });
    await s.drain();
    expect(s.canAccessSession).toHaveBeenCalledWith('session-a', 7, 'member');
    expect(s.recipients[0].ws.send).not.toHaveBeenCalled();
    expect(s.sessionDeliveryQueues.size).toBe(0);
  });
  it('refreshes cached admin role before checking audience', async () => {
    const c = client('admin'); const s = setup([c]);
    s.getUserAuthState.mockResolvedValue({ role: 'operator', disabled: false, approvalStatus: 'active' });
    s.canAccessSession.mockResolvedValue({ allowed: false });
    s.deliver('session-a', { sequence: 1 }); await s.drain();
    expect(s.canAccessSession).toHaveBeenCalledWith('session-a', 7, 'operator');
    expect(c.userRole).toBe('operator'); expect(c.ws.send).not.toHaveBeenCalled();
  });
  it.each(['disabled', 'pending', 'lookup-failure', 'audience-failure'])('fails closed for %s', async condition => {
    const s = setup();
    if (condition === 'disabled') s.getUserAuthState.mockResolvedValue({ role: 'admin', disabled: true, approvalStatus: 'active' });
    if (condition === 'pending') s.getUserAuthState.mockResolvedValue({ role: 'admin', disabled: false, approvalStatus: 'pending' });
    if (condition === 'lookup-failure') s.getUserAuthState.mockRejectedValue(new Error('synthetic auth unavailable'));
    if (condition === 'audience-failure') s.canAccessSession.mockRejectedValue(new Error('synthetic audience unavailable'));
    s.deliver('session-a', { sequence: 1 }); await s.drain();
    expect(s.recipients[0].ws.send).not.toHaveBeenCalled(); expect(s.sessionDeliveryQueues.size).toBe(0);
  });
  it('serializes delayed frames, preserves done ordering, exclusion and closed socket handling', async () => {
    const c = client(); const closed = client(); closed.id = 'closed'; closed.ws.readyState = 3;
    const s = setup([c, closed]); let release!: () => void;
    const blocked = new Promise<void>(resolve => { release = resolve; });
    s.canAccessSession.mockImplementationOnce(async () => { await blocked; return { allowed: true }; });
    s.deliver('session-a', { sequence: 1 }); s.deliver('session-a', { sequence: 2, type: 'sdk_done' });
    s.deliver('session-a', { sequence: 3 }, c.id);
    await vi.waitFor(() => expect(s.canAccessSession).toHaveBeenCalledOnce());
    expect(c.ws.send).not.toHaveBeenCalled();
    release(); await s.drain();
    expect(c.ws.send.mock.calls.map(([text]) => JSON.parse(text).sequence)).toEqual([1, 2]);
    expect(closed.ws.send).not.toHaveBeenCalled(); expect(s.sessionDeliveryQueues.size).toBe(0);
  });
  it('does not let a slow recipient block another recipient', async () => {
    const a = client(); const b = client(); b.id = 'client-b'; b.userId = 8;
    const s = setup([a, b]); let release!: () => void;
    const blocked = new Promise<void>(resolve => { release = resolve; });
    s.canAccessSession.mockImplementation(async (_id?: string, userId?: number) => { if (userId === 7) await blocked; return { allowed: true }; });
    s.deliver('session-a', { sequence: 1 });
    await vi.waitFor(() => expect(b.ws.send).toHaveBeenCalledOnce());
    expect(a.ws.send).not.toHaveBeenCalled(); release(); await s.drain();
    expect(a.ws.send).toHaveBeenCalledOnce();
  });
  it('rechecks each queued frame after an earlier frame fails', async () => {
    const s = setup(); s.canAccessSession.mockRejectedValueOnce(new Error('synthetic failure'));
    s.deliver('session-a', { sequence: 1 }); s.deliver('session-a', { sequence: 2 }); await s.drain();
    expect(s.recipients[0].ws.send.mock.calls.map(([text]) => JSON.parse(text).sequence)).toEqual([2]);
    expect(s.canAccessSession).toHaveBeenCalledTimes(2);
  });
  it('drops frames if subscription disappears before queued delivery starts', async () => {
    const s = setup(); s.deliver('session-a', { sequence: 1 });
    s.sessionClients.get('session-a')!.clear(); await s.drain();
    expect(s.getUserAuthState).not.toHaveBeenCalled(); expect(s.recipients[0].ws.send).not.toHaveBeenCalled();
  });
});

import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const db = vi.hoisted(() => ({ queryOne: vi.fn() }));
vi.mock('../db/pg-repo.js', () => ({ queryOne: db.queryOne }));
vi.mock('../services/pm/project-membership-manager.js', () => ({ isProjectMember: vi.fn(async () => true), getAccessibleProjectIds: vi.fn() }));
vi.mock('../services/session/session-share-manager.js', () => ({ hasInternalShareAccess: vi.fn(async () => true) }));
import { canAccessSession, canMutateSessionMetadata, canAdministerSession } from '../services/pm/project-access.js';
import { canManageUserRole } from '../services/authority/user-management-policy.js';
import { UserManagementForbiddenError } from '../services/auth/auth.js';
import { assertOrdinaryAgentCreationAuthority } from '../services/authority/agent-authority-policy-update.js';

/**
 * Bounded handler integration: execute the actual api.ts arrow function extracted
 * with the TypeScript AST, not a copied policy or substring assertion. Real Session
 * access helpers consume synthetic DB facts; persistence/provider effects are spies.
 * This deliberately does NOT exercise Express middleware, JWT or a live HTTP server.
 */
const source = readFileSync(new URL('./api.ts', import.meta.url), 'utf8');
const ast = ts.createSourceFile('api.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
function handler(method: string, route: string, globals: Record<string, unknown>) {
  const found: ts.ArrowFunction[] = [];
  for (const statement of ast.statements) {
    if (!ts.isExpressionStatement(statement) || !ts.isCallExpression(statement.expression)) continue;
    const call = statement.expression;
    if (!ts.isPropertyAccessExpression(call.expression) || call.expression.expression.getText(ast) !== 'router'
      || call.expression.name.text !== method || !call.arguments[0] || !ts.isStringLiteral(call.arguments[0])
      || call.arguments[0].text !== route) continue;
    const last = call.arguments[call.arguments.length - 1];
    if (ts.isArrowFunction(last)) found.push(last);
  }
  expect(found, `${method} ${route} must have one real handler`).toHaveLength(1);
  const js = ts.transpileModule(`const selected = ${found[0].getText(ast)};`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
  return vm.runInNewContext(`${js}\nselected;`, { ...globals, console: { info: vi.fn() } });
}
const spies = {
  updateSession: vi.fn(), setSessionFavorite: vi.fn(), broadcastToAll: vi.fn(),
  createUser: vi.fn(), createAdminManagedAccount: vi.fn(), updateUserRole: vi.fn(), updateUserUsername: vi.fn(), updateUserProfile: vi.fn(),
  resetUserPassword: vi.fn(), disableUser: vi.fn(), disconnectUserSockets: vi.fn(), execute: vi.fn(),
  reactivateUser: vi.fn(), listUserAuthEvents: vi.fn(),
  createProject: vi.fn(), updateProject: vi.fn(),
};
let session: { user_id: number; project_id: string; visibility: string; room_id: string | null };
let targetRole: string;
const syntheticUsers = [{ id: 8, username: 'synthetic', role: 'admin' }, { id: 9, username: 'ordinary', role: 'member' }];
function globals() {
  return {
    ...spies, canAccessSession, canMutateSessionMetadata, canAdministerSession, canManageUserRole,
    assertOrdinaryAgentCreationAuthority,
    listUsers: vi.fn(async () => syntheticUsers), getUserRole: vi.fn(async () => targetRole),
    getSession: vi.fn(async () => ({ ...session, engine: 'pi', turnCount: 0 })),
    getProject: vi.fn(async () => ({ id: 'agent-a' })), isProjectOwner: vi.fn(async () => true),
    isPrivilegedRole: (role: string) => role === 'admin' || role === 'operator',
    broadcastToProjectMembers: vi.fn(), normalizePiSessionModelId: (id: string) => id,
    config: { defaultEngine: 'pi', agentFirstEnabled: true, publicUrl: 'https://tower.example.com' },
    fs: { existsSync: () => true, statSync: () => ({ isDirectory: () => true }) },
    InvalidUsernameError: class extends Error {}, UsernameTakenError: class extends Error {},
    UserManagementForbiddenError,
    AccountEmailConflictError: class extends Error {}, AccountEmailStateError: class extends Error {},
    AccountEmailDeliveryError: class extends Error {},
    require: (id: string) => {
      if (id.endsWith('pg-repo.js')) return db;
      if (id.endsWith('session-manager.js')) return { setSessionFavorite: spies.setSessionFavorite };
      if (id.endsWith('ws-handler.js')) return { broadcastToAll: spies.broadcastToAll };
      throw new Error(`Unexpected handler dependency: ${id}`);
    },
  };
}
async function invoke(method: string, route: string, role: string, body: Record<string, unknown> = {}, userId: number | undefined = 7) {
  const res = { status: vi.fn().mockReturnThis(), json: vi.fn().mockReturnThis(), setHeader: vi.fn().mockReturnThis() };
  await handler(method, route, globals())({
    body, params: { id: '8' }, query: {}, user: { userId, role }, ip: '127.0.0.1',
    socket: { remoteAddress: '127.0.0.1' }, get: vi.fn(() => 'synthetic-test-agent'),
  }, res);
  return res;
}
beforeEach(() => {
  vi.clearAllMocks(); targetRole = 'member';
  session = { user_id: 8, project_id: 'agent-a', visibility: 'project', room_id: null };
  db.queryOne.mockImplementation(async () => session);
  spies.createUser.mockResolvedValue({ id: 9, username: 'new-user', role: 'member' });
  spies.createAdminManagedAccount.mockResolvedValue({ id: 9, username: 'new-user', role: 'member' });
  spies.createProject.mockResolvedValue({ id: 'agent-a' });
  spies.updateProject.mockResolvedValue({ id: 'agent-a' });
  spies.updateUserRole.mockResolvedValue(true);
  spies.updateUserProfile.mockResolvedValue(true);
  spies.disableUser.mockImplementation(async (_id, actorRole) => actorRole === 'operator' && !canManageUserRole(actorRole, targetRole) ? 'forbidden' : 'disabled');
});

describe('Session PATCH actual handler and audience helpers', () => {
  it.each(['member', 'viewer', 'guest'])('allows %s personal favorite without Session metadata authority', async role => {
    const res = await invoke('patch', '/sessions/:id', role, { favorite: true });
    expect(res.status).not.toHaveBeenCalled();
    expect(spies.setSessionFavorite).toHaveBeenCalledWith('8', 7, true);
    // Existing updateSession ignores undefined fields; no global value was supplied.
    expect(spies.updateSession).not.toHaveBeenCalled();
  });
  it('rejects malformed favorite values without writing personal or shared state', async () => {
    const res = await invoke('patch', '/sessions/:id', 'member', { favorite: 'true' });
    expect(res.status).toHaveBeenCalledWith(400);
    expect(spies.setSessionFavorite).not.toHaveBeenCalled();
    expect(spies.updateSession).not.toHaveBeenCalled();
  });
  it.each(['member', 'viewer', 'guest'])('denies %s renaming another readable conversation', async role => {
    const res = await invoke('patch', '/sessions/:id', role, { name: 'reader-change' });
    expect(res.status).toHaveBeenCalledWith(403); expect(spies.updateSession).not.toHaveBeenCalled();
  });
  it.each([
    { totalTokens: 0 }, { totalCost: 0 }, { cwd: '/synthetic-directory' },
    { modelUsed: 'synthetic-model' }, { engine: 'pi', engineSessionId: '/synthetic-session' },
    { claudeSessionId: 'synthetic' }, { visibility: 'private' }, { label: 'changed' }, { autoNamed: true },
  ])('denies operator execution/content PATCH %j on another conversation', async body => {
    const res = await invoke('patch', '/sessions/:id', 'operator', body);
    expect(res.status).toHaveBeenCalledWith(403); expect(spies.updateSession).not.toHaveBeenCalled();
  });
  it('does not apply favorite before rejecting mixed content mutations', async () => {
    const res = await invoke('patch', '/sessions/:id', 'viewer', { favorite: true, totalTokens: 0 });
    expect(res.status).toHaveBeenCalledWith(403); expect(spies.setSessionFavorite).not.toHaveBeenCalled();
  });
  it('keeps another owner metadata private even for an operator', async () => {
    let res = await invoke('patch', '/sessions/:id', 'operator', { name: 'company-title', tags: ['work'] });
    expect(res.status).toHaveBeenCalledWith(403); expect(spies.updateSession).not.toHaveBeenCalled();
    spies.updateSession.mockClear(); session.visibility = 'private';
    res = await invoke('patch', '/sessions/:id', 'operator', { name: 'private-title' });
    expect(res.status).toHaveBeenCalledWith(403); expect(spies.updateSession).not.toHaveBeenCalled();
    session.visibility = 'project'; session.room_id = 'room-a';
    res = await invoke('patch', '/sessions/:id', 'operator', { name: 'channel-title' });
    expect(res.status).toHaveBeenCalledWith(403);
  });
  it('persists an authorized owner mixed favorite and metadata update', async () => {
    session.user_id = 7;
    const res = await invoke('patch', '/sessions/:id', 'member', { favorite: true, name: 'Owner title' });
    expect(res.status).not.toHaveBeenCalled();
    expect(spies.updateSession).toHaveBeenCalledWith('8', expect.objectContaining({ name: 'Owner title' }));
    expect(spies.setSessionFavorite).toHaveBeenCalledWith('8', 7, true);
  });
  it.each(['member', 'operator', 'admin'])('permits writable %s owner configuration changes', async role => {
    session.user_id = 7;
    const res = await invoke('patch', '/sessions/:id', role, { totalTokens: 0 });
    expect(res.status).not.toHaveBeenCalled(); expect(spies.updateSession).toHaveBeenCalledOnce();
  });
  it.each(['viewer', 'guest'])('denies read-only %s even as owner', async role => {
    session.user_id = 7;
    const res = await invoke('patch', '/sessions/:id', role, { name: 'owner-change' });
    expect(res.status).toHaveBeenCalledWith(403); expect(spies.updateSession).not.toHaveBeenCalled();
  });
  it('ignores requester identity fields for authority and rejects anonymous mutations', async () => {
    let res = await invoke('patch', '/sessions/:id', 'member', { userId: 8, role: 'admin', totalTokens: 0 });
    expect(res.status).toHaveBeenCalledWith(403); expect(spies.updateSession).not.toHaveBeenCalled();
    res = await invoke('patch', '/sessions/:id', 'member', { favorite: true }, 0);
    expect(res.status).toHaveBeenCalledWith(401);
  });
});

describe('Local user-management actual handlers', () => {
  it('never returns a password and hides privileged accounts from operators', async () => {
    const operator = await invoke('get', '/admin/users', 'operator');
    expect(operator.json.mock.calls[0][0]).toEqual([syntheticUsers[1]]);
    const admin = await invoke('get', '/admin/users', 'admin');
    expect(admin.json.mock.calls[0][0]).toEqual(syntheticUsers);
    expect(JSON.stringify(admin.json.mock.calls[0][0])).not.toContain('password');
  });
  it.each(['operator', 'admin'])('denies operator creating %s', async role => {
    const res = await invoke('post', '/admin/users', 'operator', {
      username: 'new-user', password: 'synthetic-only', passwordConfirm: 'synthetic-only',
      displayName: 'Synthetic User', email: 'new-user@example.com', role,
    });
    expect(res.status).toHaveBeenCalledWith(403); expect(spies.createAdminManagedAccount).not.toHaveBeenCalled();
  });
  it.each(['member', 'viewer', 'guest'])('permits operator creating ordinary %s', async role => {
    const res = await invoke('post', '/admin/users', 'operator', {
      username: 'new-user', password: 'synthetic-only', passwordConfirm: 'synthetic-only',
      displayName: 'Synthetic User', email: 'new-user@example.com', role,
    });
    expect(res.status).not.toHaveBeenCalled(); expect(spies.createAdminManagedAccount).toHaveBeenCalledOnce();
  });
  it.each(['operator', 'admin'])('denies operator granting %s', async role => {
    const res = await invoke('patch', '/admin/users/:id', 'operator', { role });
    expect(res.status).toHaveBeenCalledWith(403); expect(spies.updateUserRole).not.toHaveBeenCalled();
  });
  it.each(['operator', 'admin'])('protects existing %s from operator mutation or disabling', async role => {
    targetRole = role;
    for (const body of [{ role: 'member' }, { username: 'rename' }, { displayName: 'rename' }, { affiliation: 'changed' }]) {
      const res = await invoke('patch', '/admin/users/:id', 'operator', body);
      expect(res.status).toHaveBeenCalledWith(403);
    }
    const res = await invoke('delete', '/admin/users/:id', 'operator');
    expect(res.status).toHaveBeenCalledWith(403);
    for (const spy of [spies.updateUserRole, spies.updateUserUsername, spies.updateUserProfile]) expect(spy).not.toHaveBeenCalled();
    expect(spies.disableUser).toHaveBeenCalledWith(8, 'operator', 7);
    expect(spies.disconnectUserSockets).not.toHaveBeenCalled();
  });
  it('maps a role promoted before a conditional role update to 403 without follow-on mutations', async () => {
    spies.updateUserRole.mockResolvedValueOnce(false);
    const denied = await invoke('patch', '/admin/users/:id', 'operator', { role: 'viewer', displayName: 'should-not-write' });
    expect(denied.status).toHaveBeenCalledWith(403);
    expect(spies.updateUserRole).toHaveBeenCalledWith(8, 'viewer', 'operator');
    expect(spies.updateUserProfile).not.toHaveBeenCalled();
  });
  it('blocks operator profile changes when the target becomes privileged after the preflight', async () => {
    spies.updateUserProfile.mockResolvedValueOnce(false);
    const denied = await invoke('patch', '/admin/users/:id', 'operator', { displayName: 'should-not-write' });
    expect(spies.updateUserProfile).toHaveBeenCalledWith(8, { displayName: 'should-not-write', affiliation: undefined }, 'operator');
    expect(denied.status).toHaveBeenCalledWith(403);
  });
  it('blocks operator rename when the locked target is now privileged', async () => {
    spies.updateUserUsername.mockRejectedValueOnce(new UserManagementForbiddenError());
    const denied = await invoke('patch', '/admin/users/:id', 'operator', { username: 'renamed' });
    expect(spies.updateUserUsername).toHaveBeenCalledWith(8, 'renamed', 7, { reason: null, actorRole: 'operator' });
    expect(denied.status).toHaveBeenCalledWith(403);
  });
  it('maps a role changed before the locked disable check to 403 without disconnecting sockets', async () => {
    spies.disableUser.mockResolvedValueOnce('forbidden');
    const denied = await invoke('delete', '/admin/users/:id', 'operator');
    expect(denied.status).toHaveBeenCalledWith(403);
    expect(spies.disconnectUserSockets).not.toHaveBeenCalled();
  });
  it('denies all operator password reset but retains platform admin path', async () => {
    const denied = await invoke('patch', '/admin/users/:id/password', 'operator', { password: 'synthetic-only' });
    expect(denied.status).toHaveBeenCalledWith(403); expect(spies.resetUserPassword).not.toHaveBeenCalled();
    const allowed = await invoke('patch', '/admin/users/:id/password', 'admin', { password: 'synthetic-only' });
    expect(allowed.status).not.toHaveBeenCalled(); expect(spies.resetUserPassword).toHaveBeenCalledWith(8, 'synthetic-only');
  });
  it('passes the actor into the locked reactivation helper and maps blocked outcome to 403', async () => {
    spies.reactivateUser.mockResolvedValueOnce('forbidden');
    const denied = await invoke('post', '/admin/users/:id/reactivate', 'operator');
    expect(spies.reactivateUser).toHaveBeenCalledWith({ userId: 8, actorUserId: 7, actorRole: 'operator' });
    expect(denied.status).toHaveBeenCalledWith(403);
    spies.reactivateUser.mockResolvedValueOnce('reactivated');
    const allowed = await invoke('post', '/admin/users/:id/reactivate', 'admin');
    expect(allowed.json).toHaveBeenCalledWith({ ok: true });
  });
  it('never returns event rows when the locked target role is privileged', async () => {
    spies.listUserAuthEvents.mockResolvedValueOnce('forbidden');
    const denied = await invoke('get', '/admin/users/:id/auth-events', 'operator');
    expect(spies.listUserAuthEvents).toHaveBeenCalledWith({ userId: 8, actorRole: 'operator', before: undefined });
    expect(denied.status).toHaveBeenCalledWith(403);
    expect(denied.json).not.toHaveBeenCalledWith(expect.any(Array));
  });
});

describe('Profile authority input cannot grant host capability through coercion', () => {
  it.each([true, false])('allows operator explicit boolean superuser=%s', async superuser => {
    const res = await invoke('patch', '/projects/:id/agent-profile', 'operator', { superuser });
    expect(res.status).not.toHaveBeenCalled(); expect(spies.execute).toHaveBeenCalled();
  });
  it.each(['true', 1, null, { enabled: true }, ['true']])('does not persist nonboolean superuser %j as an authority change', async superuser => {
    const res = await invoke('patch', '/projects/:id/agent-profile', 'operator', { superuser, authorityPolicy: { superuser: true, allowHostAdmin: true } });
    expect(res.status).not.toHaveBeenCalled();
    const parameters = spies.execute.mock.calls[0][1];
    expect(parameters[7]).toBe(false); expect(parameters[8]).toBe(false);
    expect(JSON.stringify(parameters)).not.toContain('allowHostAdmin');
  });
});

// These execute the current routes with synthetic requests, not historical copies.
describe('Retired legacy OAuth cannot choose personal or host identities', () => {
  it.each([{}, { code: 'synthetic-code', state: 'tower_user:8' }, { code: 'synthetic-code' }])('returns 410 with no effects for %j', async query => {
    const effects = { fetch: vi.fn(), savePersonalGwsConfigSecretFromToken: vi.fn(), fs: { readFileSync: vi.fn(), writeFileSync: vi.fn() } };
    const res = { status: vi.fn().mockReturnThis(), json: vi.fn().mockReturnThis(), send: vi.fn().mockReturnThis() };
    await handler('get', '/oauth/google/callback', { ...globals(), ...effects })({ query, user: { userId: 7, role: 'member' } }, res);
    expect(res.status).toHaveBeenCalledWith(410);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ error: 'AGENT_GOOGLE_CONNECTION_REQUIRED' }));
    for (const spy of [effects.fetch, effects.savePersonalGwsConfigSecretFromToken, effects.fs.readFileSync, effects.fs.writeFileSync]) expect(spy).not.toHaveBeenCalled();
  });
});

describe('Project creation and PATCH cannot redefine ordinary execution roots', () => {
  it.each(['member', 'operator'])('denies %s custom creation roots before creating storage', async role => {
    for (const rootPath of ['/synthetic-host', null, '']) {
      const res = await invoke('post', '/projects', role, { name: 'Synthetic', rootPath });
      expect(res.status).toHaveBeenCalledWith(403);
    }
    expect(spies.createProject).not.toHaveBeenCalled(); expect(spies.execute).not.toHaveBeenCalled();
  });
  it.each(['member', 'operator'])('denies %s rootPath and root_path PATCH including null values', async role => {
    for (const key of ['rootPath', 'root_path']) {
      for (const value of ['/synthetic-host', null, '']) {
        const res = await invoke('patch', '/projects/:id', role, { [key]: value });
        expect(res.status).toHaveBeenCalledWith(403);
      }
    }
    expect(spies.updateProject).not.toHaveBeenCalled();
  });
  it.each(['member', 'operator', 'admin'])('rejects %s nested authority at creation before any persistence', async role => {
    for (const superuser of [true, 'true', 1, { enabled: true }, null]) {
      const res = await invoke('post', '/projects', role, { name: 'Synthetic', agentProfile: { authorityPolicy: { superuser } } });
      expect(res.status).toHaveBeenCalledWith(403);
    }
    expect(spies.createProject).not.toHaveBeenCalled(); expect(spies.execute).not.toHaveBeenCalled();
  });
  it.each(['member', 'operator'])('retains %s default-root creation and ordinary metadata PATCH', async role => {
    const created = await invoke('post', '/projects', role, { name: 'Synthetic', agentProfile: { authorityPolicy: { superuser: false } } });
    expect(created.status).not.toHaveBeenCalled(); expect(spies.createProject).toHaveBeenCalledOnce();
    const patched = await invoke('patch', '/projects/:id', role, { description: 'Synthetic description' });
    expect(patched.status).not.toHaveBeenCalled(); expect(spies.updateProject).toHaveBeenCalledOnce();
  });
  it('retains explicit platform-admin root management', async () => {
    let res = await invoke('post', '/projects', 'admin', { name: 'Synthetic', rootPath: '/synthetic-host' });
    expect(res.status).not.toHaveBeenCalled(); expect(spies.createProject).toHaveBeenCalledWith('Synthetic', 7, expect.objectContaining({ rootPath: '/synthetic-host' }));
    res = await invoke('patch', '/projects/:id', 'admin', { rootPath: '/synthetic-host' });
    expect(res.status).not.toHaveBeenCalled(); expect(spies.updateProject).toHaveBeenCalledWith('8', { rootPath: '/synthetic-host' });
  });
});

describe('Signed OAuth callback preserves current scoped management gate', () => {
  // JWT cryptography and DB management helper are tested elsewhere. This contract
  // checks that the actual callback consumes their decisions BEFORE provider work.
  function oauthGlobals(payload: Record<string, unknown> | null) {
    return {
      ...globals(), verifyToken: vi.fn(() => payload),
      assertAgentGoogleConnectionAccess: vi.fn(async () => true),
      assertCredentialManagementAccess: vi.fn(async () => {}), queryOne: vi.fn(async () => null),
      exchangeGoogleCode: vi.fn(async () => ({ accessToken: 'synthetic-access', refreshToken: 'synthetic-refresh' })),
      getGoogleUserInfo: vi.fn(async () => ({ email: 'synthetic@example.com' })),
      buildAgentGwsConfigBundle: vi.fn(async () => 'synthetic-bundle'), GOOGLE_DEFAULT_SCOPES: ['synthetic-scope'],
      upsertAgentGwsCredential: vi.fn(), upsertOrganizationGwsCredential: vi.fn(),
    };
  }
  async function callback(g: ReturnType<typeof oauthGlobals>) {
    const res = { status: vi.fn().mockReturnThis(), send: vi.fn().mockReturnThis(), redirect: vi.fn().mockReturnThis() };
    await handler('get', '/auth/google/callback', g)({ query: { code: 'synthetic-code', state: 'synthetic-signed-state', projectId: 'forged-agent', userId: 999 }, user: { userId: 999, role: 'admin' } }, res);
    return res;
  }
  const agentState = { userId: 7, role: 'member', aud: 'google-agent-oauth-state', connectionScope: 'agent', projectId: 'agent-a', credentialId: 'google-agent-a' };
  const organizationState = { userId: 7, role: 'operator', aud: 'google-organization-oauth-state', connectionScope: 'organization', credentialId: 'google-shared', connectionMode: 'create' };
  it.each([null, { ...agentState, aud: 'tower-cli' }, { ...agentState, projectId: undefined }])('rejects invalid signed flow %j before provider exchange', async payload => {
    const g = oauthGlobals(payload); const res = await callback(g);
    expect(res.redirect).toHaveBeenCalledWith(expect.stringContaining('invalid_or_expired_state'));
    expect(g.exchangeGoogleCode).not.toHaveBeenCalled(); expect(g.upsertAgentGwsCredential).not.toHaveBeenCalled();
  });
  it('checks current Agent management and uses signed identity rather than callback input', async () => {
    const g = oauthGlobals(agentState); await callback(g);
    expect(g.assertAgentGoogleConnectionAccess).toHaveBeenCalledWith(agentState, 'agent-a');
    expect(g.upsertAgentGwsCredential).toHaveBeenCalledWith(expect.objectContaining({ projectId: 'agent-a', credentialId: 'google-agent-a', actorUserId: 7 }));
    expect(g.upsertOrganizationGwsCredential).not.toHaveBeenCalled();
    expect(g.assertAgentGoogleConnectionAccess.mock.invocationCallOrder[0]).toBeLessThan(g.exchangeGoogleCode.mock.invocationCallOrder[0]);
  });
  it('rejects revoked Agent management before OAuth exchange', async () => {
    const g = oauthGlobals(agentState); g.assertAgentGoogleConnectionAccess.mockResolvedValue(false);
    const res = await callback(g);
    expect(res.redirect).toHaveBeenCalledWith(expect.stringContaining('agent_access_denied'));
    expect(g.exchangeGoogleCode).not.toHaveBeenCalled(); expect(g.upsertAgentGwsCredential).not.toHaveBeenCalled();
  });
  it('checks current company management rather than trusting the signed historical role', async () => {
    const g = oauthGlobals(organizationState); g.assertCredentialManagementAccess.mockRejectedValue(new Error('revoked'));
    const res = await callback(g);
    expect(g.assertCredentialManagementAccess).toHaveBeenCalledWith({ actorUserId: 7, scope: 'workspace' });
    expect(res.redirect).toHaveBeenCalledWith(expect.stringContaining('company_management_required'));
    expect(g.exchangeGoogleCode).not.toHaveBeenCalled(); expect(g.upsertOrganizationGwsCredential).not.toHaveBeenCalled();
  });
  it('persists an authorized organization flow using only its signed connection id', async () => {
    const g = oauthGlobals(organizationState); await callback(g);
    expect(g.upsertOrganizationGwsCredential).toHaveBeenCalledWith(expect.objectContaining({ credentialId: 'google-shared', actorUserId: 7 }));
    expect(g.assertCredentialManagementAccess.mock.invocationCallOrder[0]).toBeLessThan(g.exchangeGoogleCode.mock.invocationCallOrder[0]);
    expect(g.upsertAgentGwsCredential).not.toHaveBeenCalled();
  });
});

describe('Agent profile partial text updates', () => {
  it('marks only supplied displayName for atomic update and preserves other profile fields', async () => {
    const res = await invoke('patch', '/projects/:id/agent-profile', 'operator', { displayName: ' New AI ' });
    expect(res.status).not.toHaveBeenCalled();
    const [sql, parameters] = spies.execute.mock.calls[0];
    expect(parameters[1]).toBe('New AI');
    expect(parameters.slice(9)).toEqual([true, false, false, false, false]);
    for (const [index, field] of ['display_name', 'face', 'role', 'tagline', 'promise'].entries()) {
      expect(sql).toContain(`${field}=CASE WHEN $${index + 10}::boolean THEN EXCLUDED.${field} ELSE project_agent_profiles.${field} END`);
    }
    expect(parameters[6]).toBe(null); // no skill update
    expect(parameters[8]).toBe(false); // no authority update
  });
  it('distinguishes omitted fields from explicitly cleared text', async () => {
    await invoke('patch', '/projects/:id/agent-profile', 'operator', { tagline: '', face: null });
    const parameters = spies.execute.mock.calls[0][1];
    expect(parameters.slice(9)).toEqual([false, true, false, true, false]);
    expect(parameters[2]).toBe(null); expect(parameters[4]).toBe(null);
  });
  it.each(['', '   ', null, 123, 'x'.repeat(121)])('rejects invalid displayName %j before persistence', async displayName => {
    const res = await invoke('patch', '/projects/:id/agent-profile', 'operator', { displayName });
    expect(res.status).toHaveBeenCalledWith(400);
    expect(spies.execute).not.toHaveBeenCalled();
  });
});


describe('project member invitations', () => {
  it.each(['admin', 'operator', 'member'])('allows an invited %s without ownership', async role => {
    const addProjectMember = vi.fn();
    const isProjectMember = vi.fn(async () => true);
    const res = { status: vi.fn().mockReturnThis(), json: vi.fn().mockReturnThis() };
    await handler('post', '/projects/:id/members', {
      ...globals(), isProjectOwner: vi.fn(async () => false), isProjectMember, addProjectMember,
    })({ user: { userId: 7, role }, params: { id: 'agent-a' }, body: { userId: 9, role: 'owner' } }, res);
    expect(isProjectMember).toHaveBeenCalledWith('agent-a', 7, 'write');
    expect(addProjectMember).toHaveBeenCalledWith('agent-a', 9, 'member');
    expect(res.json).toHaveBeenCalledWith({ ok: true });
  });

  it.each(['member', 'admin', 'operator', 'viewer', 'guest'])('denies %s without write membership', async role => {
    const addProjectMember = vi.fn();
    const res = { status: vi.fn().mockReturnThis(), json: vi.fn().mockReturnThis() };
    await handler('post', '/projects/:id/members', {
      ...globals(), isProjectMember: vi.fn(async () => false), addProjectMember,
    })({ user: { userId: 7, role }, params: { id: 'agent-a' }, body: { userId: 9 } }, res);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(addProjectMember).not.toHaveBeenCalled();
  });
});

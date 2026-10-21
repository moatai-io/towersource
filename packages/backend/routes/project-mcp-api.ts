/** Mount under /api AFTER normal user authentication. Mount publicProjectMcpOAuthRouter BEFORE it. */
import { Router, type Request, type Response } from 'express';
import { assertProjectMcpAccess, assertProjectMcpManager } from '../services/project-mcp/project-mcp-access.js';
import { assertMcpServerName, mutateMcpManifest, readManagedMcpManifest } from '../services/project-mcp/project-mcp-manifest.js';
import { assertMcpPublicUrl } from '../services/project-mcp/project-mcp-network.js';
import { startMcpOAuth, finishMcpOAuth, disconnectMcpOAuth, getMcpOAuthStatus, MCP_SHARED_ACCOUNT_NOTICE } from '../services/project-mcp/project-mcp-oauth.js';
import type { ProjectMcpServerManifest } from '../services/project-mcp/project-mcp-loader.js';
const router = Router();
export const publicProjectMcpOAuthRouter = Router();
function identity(req: Request): number {
  const id = (req as any).user?.userId;
  if (!Number.isInteger(id) || id < 1) throw Object.assign(new Error('Authentication required'), { status: 401 });
  return id;
}
function projectId(req: Request): string {
  const value = String(req.params.projectId);
  if (!/^[a-zA-Z0-9_-]{1,100}$/.test(value)) throw Object.assign(new Error('Invalid project id'), { status: 400 });
  return value;
}
function handle(fn: (req: Request, res: Response) => Promise<unknown>) {
  return (req: Request, res: Response) => { void fn(req, res).catch((e: any) => {
    const denied = e.status === 403 || e.code === 'CREDENTIAL_MANAGEMENT_DENIED';
    res.status(denied ? 403 : e.status === 401 ? 401 : e.status === 409 ? 409 : 400)
      .json({ error: denied ? 'Agent connection access denied' : e.status === 401 ? 'Authentication required' : 'MCP connection operation failed. Check URL, OAuth support and Agent permissions.' });
  }); };
}
async function dto(project: string, server: ProjectMcpServerManifest) {
  return { id: server.name, name: server.name, displayName: server.displayName ?? server.name,
    description: server.description ?? '', url: server.url, enabled: server.enabled !== false,
    authType: server.authType ?? 'none', authScope: 'agent' as const,
    status: server.authType === 'oauth' ? await getMcpOAuthStatus(project, server.name, server.url ?? '') ? 'connected' : 'disconnected' : 'configured',
  };
}
router.get('/projects/:projectId/mcp/connections', handle(async (req, res) => {
  const id = projectId(req); const user = identity(req);
  const access = await assertProjectMcpAccess(id, user);
  let canManage = false;
  try { await assertProjectMcpManager(id, user); canManage = true; } catch { /* read access does not grant management */ }
  const manifest = await readManagedMcpManifest(access.rootPath);
  res.json({ connections: await Promise.all(manifest.servers.map(server => dto(id, server))), canManage,
    authScope: 'agent', sharedAccountNotice: MCP_SHARED_ACCOUNT_NOTICE });
}));
router.post('/projects/:projectId/mcp/connections', handle(async (req, res) => {
  const id = projectId(req); const access = await assertProjectMcpManager(id, identity(req));
  const { name, url, authType, displayName } = req.body ?? {};
  assertMcpServerName(name);
  if (typeof url !== 'string' || url.length > 2048 || !['oauth', 'none'].includes(authType)
    || (displayName !== undefined && (typeof displayName !== 'string' || displayName.length > 120))
    || Object.keys(req.body).some(k => !['name', 'url', 'authType', 'displayName'].includes(k))) throw new Error('Invalid connection definition');
  await assertMcpPublicUrl(url);
  const server: ProjectMcpServerManifest = { name, url, type: 'streamable-http', authType, displayName, enabled: true };
  await mutateMcpManifest(access.rootPath, servers => {
    if (servers.some(s => s.name === name)) throw Object.assign(new Error('Name already exists'), { status: 409 });
    return [...servers, server];
  });
  res.status(201).json({ connection: await dto(id, server) });
}));
router.post('/projects/:projectId/mcp/connections/:name/auth/start', handle(async (req, res) => {
  const id = projectId(req); const name = String(req.params.name); assertMcpServerName(name);
  if (req.body?.acknowledgeSharedAccount !== true) throw new Error('Shared-account acknowledgement required');
  const authorizationUrl = await startMcpOAuth(id, name, identity(req));
  res.json({ authorizationUrl, authScope: 'agent', sharedAccountNotice: MCP_SHARED_ACCOUNT_NOTICE });
}));
router.delete('/projects/:projectId/mcp/connections/:name/auth', handle(async (req, res) => {
  const id = projectId(req); const name = String(req.params.name); assertMcpServerName(name);
  await disconnectMcpOAuth(id, name, identity(req)); res.json({ disconnected: true });
}));
router.delete('/projects/:projectId/mcp/connections/:name', handle(async (req, res) => {
  const id = projectId(req); const name = String(req.params.name); assertMcpServerName(name);
  const user = identity(req); const access = await assertProjectMcpManager(id, user);
  await mutateMcpManifest(access.rootPath, servers => servers.filter(s => s.name !== name));
  await disconnectMcpOAuth(id, name, user); res.json({ removed: true });
}));
// No user-controlled redirect or error details: the secret-free result returns to the fixed Tower UI route.
publicProjectMcpOAuthRouter.get('/projects/:projectId/mcp/oauth/callback', async (req, res) => {
  res.setHeader('Cache-Control', 'no-store'); res.setHeader('Referrer-Policy', 'no-referrer');
  let status = 'error';
  try {
    const id = projectId(req);
    if (typeof req.query.state !== 'string' || typeof req.query.code !== 'string' || req.query.error) throw new Error('Invalid OAuth response');
    await finishMcpOAuth(id, req.query.state, req.query.code); status = 'connected';
  } catch { /* intentionally omit code/state/provider errors from logs and redirects */ }
  res.redirect(303, `/?mcpAuth=${status}`);
});
export default router;

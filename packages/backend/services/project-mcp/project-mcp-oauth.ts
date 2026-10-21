/** Agent-shared OAuth. State is single-use, PKCE/client/tokens stay in the Vault AES-GCM store. */
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { auth, type OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js';
import type { OAuthClientInformationMixed, OAuthClientMetadata, OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js';
import { query, queryOne, execute } from '../../db/pg-repo.js';
import { config } from '../../config.js';
import { setSecret, getSecretForProjectBinding, deleteSecret } from '../secret/secret-store.js';
import { assertProjectMcpAccess, assertProjectMcpExecution, assertProjectMcpManager } from './project-mcp-access.js';
import { readManagedMcpManifest } from './project-mcp-manifest.js';
import { assertMcpPublicUrl, projectMcpFetch } from './project-mcp-network.js';

export const MCP_SHARED_ACCOUNT_NOTICE = '로그인한 외부 계정을 이 Agent의 허용 사용자들이 함께 사용합니다. 개인 계정의 데이터와 외부 작업 권한도 공유될 수 있습니다.';
interface OAuthBundle { client?: OAuthClientInformationMixed; tokens?: OAuthTokens; verifier?: string; }
interface ConnectionRow { project_id: string; server_name: string; server_url: string; secret_name: string; secret_owner_user_id: number; connected: boolean; }
interface StateRow { project_id: string; server_name: string; server_url: string; actor_user_id: number; secret_name: string; }
const stateHash = (value: string) => createHash('sha256').update(value).digest('hex');
function callbackUrl(projectId: string): string {
  const base = new URL(config.publicUrl);
  if (base.protocol !== 'https:' && !(base.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(base.hostname))) throw new Error('Configure a public HTTPS Tower URL for OAuth');
  return new URL(`/api/projects/${encodeURIComponent(projectId)}/mcp/oauth/callback`, base).toString();
}
async function loadBundle(secretName: string, ownerId: number): Promise<OAuthBundle> {
  return JSON.parse(await getSecretForProjectBinding(secretName, ownerId));
}
async function saveBundle(secretName: string, ownerId: number, bundle: OAuthBundle): Promise<void> {
  await setSecret({ name: secretName, value: JSON.stringify(bundle), scope: 'user', ownerUserId: ownerId, createdBy: ownerId });
}
async function removeOAuthSecret(name: string, owner: number): Promise<void> {
  const row = await queryOne<{ id: number }>("SELECT id FROM secret_store WHERE name=$1 AND scope='user' AND owner_user_id=$2", [name, owner]);
  if (row) await deleteSecret(row.id);
}
function provider(input: { projectId: string; serverName: string; bundle: OAuthBundle; persist: () => Promise<void>; state?: string; redirect?: (url: URL) => Promise<void>; runtime?: boolean; refreshBundle?: () => Promise<void>; assertAccess: () => Promise<unknown> }): OAuthClientProvider {
  return {
    redirectUrl: callbackUrl(input.projectId),
    clientMetadata: {
      client_name: 'Tower Agent MCP', redirect_uris: [callbackUrl(input.projectId)],
      grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none',
    } satisfies OAuthClientMetadata,
    state: async () => { if (!input.state) throw new Error('Reconnect MCP from connection settings'); return input.state; },
    clientInformation: async () => { await input.assertAccess(); return input.bundle.client; },
    saveClientInformation: async client => {
      if (input.runtime) throw new Error('Reconnect MCP from connection settings');
      input.bundle.client = client; await input.persist();
    },
    tokens: async () => { await input.assertAccess(); await input.refreshBundle?.(); return input.bundle.tokens; },
    saveTokens: async tokens => { await input.assertAccess(); input.bundle.tokens = tokens; await input.persist(); },
    redirectToAuthorization: async url => { if (!input.redirect) throw new Error('Reconnect MCP from connection settings'); await input.redirect(url); },
    saveCodeVerifier: async verifier => { if (input.runtime) throw new Error('Reconnect MCP from connection settings'); input.bundle.verifier = verifier; await input.persist(); },
    codeVerifier: async () => { if (!input.bundle.verifier) throw new Error('OAuth PKCE unavailable'); return input.bundle.verifier; },
    invalidateCredentials: async scope => {
      await input.assertAccess();
      if (scope === 'all' || scope === 'client') delete input.bundle.client;
      if (scope === 'all' || scope === 'tokens') delete input.bundle.tokens;
      if (scope === 'all' || scope === 'verifier') delete input.bundle.verifier;
      await input.persist();
    },
  };
}
export async function getMcpOAuthStatus(projectId: string, serverName: string, url: string): Promise<boolean> {
  const row = await queryOne<ConnectionRow>('SELECT * FROM project_mcp_connections WHERE project_id = $1 AND server_name = $2 AND server_url = $3', [projectId, serverName, url]);
  return !!row?.connected;
}
export async function startMcpOAuth(projectId: string, serverName: string, actorUserId: number): Promise<string> {
  const access = await assertProjectMcpManager(projectId, actorUserId);
  const server = (await readManagedMcpManifest(access.rootPath)).servers.find(s => s.name === serverName && s.enabled !== false);
  if (!server?.url || server.type !== 'streamable-http' || server.authType !== 'oauth') throw new Error('OAuth MCP connection not found');
  await assertMcpPublicUrl(server.url);
  const expired = await query<StateRow>('DELETE FROM project_mcp_oauth_states WHERE expires_at <= now() RETURNING *');
  for (const old of expired) await removeOAuthSecret(old.secret_name, old.actor_user_id).catch(() => {});
  const previousFlow = await queryOne<StateRow>('SELECT * FROM project_mcp_oauth_states WHERE project_id=$1 AND server_name=$2', [projectId, serverName]);
  const state = randomBytes(32).toString('base64url');
  const secretName = `MCP_FLOW_${randomUUID().replaceAll('-', '').toUpperCase()}`;
  const bundle: OAuthBundle = {};
  await saveBundle(secretName, actorUserId, bundle);
  await execute(`INSERT INTO project_mcp_oauth_states (state_hash, project_id, server_name, server_url, actor_user_id, secret_name, expires_at)
    VALUES ($1,$2,$3,$4,$5,$6,now() + interval '10 minutes')
    ON CONFLICT (project_id, server_name) DO UPDATE SET state_hash=EXCLUDED.state_hash, server_url=EXCLUDED.server_url,
      actor_user_id=EXCLUDED.actor_user_id, secret_name=EXCLUDED.secret_name, expires_at=EXCLUDED.expires_at, consumed_at=NULL`,
    [stateHash(state), projectId, serverName, server.url, actorUserId, secretName]);
  if (previousFlow) await removeOAuthSecret(previousFlow.secret_name, previousFlow.actor_user_id).catch(() => {});
  let authorizationUrl: string | undefined;
  try {
    const result = await auth(provider({ projectId, serverName, bundle, state,
      assertAccess: () => assertProjectMcpManager(projectId, actorUserId), persist: () => saveBundle(secretName, actorUserId, bundle),
      redirect: async url => { await assertMcpPublicUrl(url); authorizationUrl = url.toString(); },
    }), { serverUrl: server.url, fetchFn: projectMcpFetch });
    if (result !== 'REDIRECT' || !authorizationUrl) throw new Error('MCP did not provide an OAuth authorization URL');
    return authorizationUrl;
  } catch {
    await execute('DELETE FROM project_mcp_oauth_states WHERE state_hash=$1', [stateHash(state)]);
    await removeOAuthSecret(secretName, actorUserId).catch(() => {});
    throw new Error('OAuth discovery failed. Verify the provider supports MCP OAuth and dynamic registration.');
  }
}
export async function finishMcpOAuth(projectId: string, state: string, code: string): Promise<void> {
  if (!/^[A-Za-z0-9_-]{43}$/.test(state) || !code || code.length > 4096) throw new Error('Invalid OAuth callback');
  // A random 256-bit server-stored intent is the callback authority; no bearer/cookie is available on browser navigation.
  const flow = await queryOne<StateRow>(`UPDATE project_mcp_oauth_states SET consumed_at=now() WHERE state_hash=$1 AND project_id=$2 AND expires_at > now() AND consumed_at IS NULL RETURNING *`, [stateHash(state), projectId]);
  if (!flow) throw new Error('OAuth state expired or already used');
  try {
    const access = await assertProjectMcpManager(projectId, flow.actor_user_id);
    const server = (await readManagedMcpManifest(access.rootPath)).servers.find(s => s.name === flow.server_name && s.url === flow.server_url && s.enabled !== false && s.authType === 'oauth');
    if (!server) throw new Error('MCP connection changed');
    const bundle = await loadBundle(flow.secret_name, flow.actor_user_id);
    const result = await auth(provider({ projectId, serverName: flow.server_name, bundle,
      assertAccess: () => assertProjectMcpManager(projectId, flow.actor_user_id),
      persist: () => saveBundle(flow.secret_name, flow.actor_user_id, bundle),
    }), { serverUrl: flow.server_url, authorizationCode: code, fetchFn: projectMcpFetch });
    if (result !== 'AUTHORIZED' || !bundle.tokens) throw new Error('OAuth authorization failed');
    await assertProjectMcpManager(projectId, flow.actor_user_id);
    const latest = (await readManagedMcpManifest(access.rootPath)).servers.find(s => s.name === flow.server_name && s.url === flow.server_url && s.enabled !== false && s.authType === 'oauth');
    if (!latest) throw new Error('MCP connection changed during OAuth');
    delete bundle.verifier;
    await saveBundle(flow.secret_name, flow.actor_user_id, bundle);
    const previous = await queryOne<ConnectionRow>('SELECT * FROM project_mcp_connections WHERE project_id=$1 AND server_name=$2', [projectId, flow.server_name]);
    const saved = await execute(`INSERT INTO project_mcp_connections (project_id,server_name,server_url,secret_name,secret_owner_user_id,connected)
      SELECT $1,$2,$3,$4,$5,true WHERE EXISTS (SELECT 1 FROM project_mcp_oauth_states WHERE state_hash=$6 AND expires_at > now() AND consumed_at IS NOT NULL) ON CONFLICT (project_id,server_name) DO UPDATE SET server_url=EXCLUDED.server_url,
      secret_name=EXCLUDED.secret_name,secret_owner_user_id=EXCLUDED.secret_owner_user_id,connected=true,updated_at=now()`,
      [projectId, flow.server_name, flow.server_url, flow.secret_name, flow.actor_user_id, stateHash(state)]);
    if (!saved.changes) throw new Error('OAuth intent was cancelled');
    await execute('DELETE FROM project_mcp_oauth_states WHERE state_hash=$1', [stateHash(state)]);
    if (previous && previous.secret_name !== flow.secret_name) await removeOAuthSecret(previous.secret_name, previous.secret_owner_user_id).catch(() => {});
  } catch (e) { await execute('DELETE FROM project_mcp_oauth_states WHERE state_hash=$1', [stateHash(state)]); await removeOAuthSecret(flow.secret_name, flow.actor_user_id).catch(() => {}); throw e; }
}
export async function disconnectMcpOAuth(projectId: string, serverName: string, actorUserId: number): Promise<void> {
  await assertProjectMcpManager(projectId, actorUserId);
  const flows = await queryOne<StateRow>('DELETE FROM project_mcp_oauth_states WHERE project_id=$1 AND server_name=$2 RETURNING *', [projectId, serverName]);
  const row = await queryOne<ConnectionRow>('DELETE FROM project_mcp_connections WHERE project_id=$1 AND server_name=$2 RETURNING *', [projectId, serverName]);
  if (row) await removeOAuthSecret(row.secret_name, row.secret_owner_user_id);
  if (flows) await removeOAuthSecret(flows.secret_name, flows.actor_user_id);
}
export async function createProjectMcpOAuthProvider(projectId: string, serverName: string, serverUrl: string, userId: number): Promise<OAuthClientProvider> {
  await assertProjectMcpExecution(projectId, userId);
  const row = await queryOne<ConnectionRow>('SELECT * FROM project_mcp_connections WHERE project_id=$1 AND server_name=$2 AND server_url=$3 AND connected=true', [projectId, serverName, serverUrl]);
  if (!row) throw new Error('Authenticate this MCP in Agent connection settings');
  const assertAccess = async () => {
    await assertProjectMcpExecution(projectId, userId);
    const access = await assertProjectMcpAccess(projectId, userId);
    const current = await queryOne<ConnectionRow>('SELECT * FROM project_mcp_connections WHERE project_id=$1 AND server_name=$2 AND server_url=$3 AND secret_name=$4 AND connected=true', [projectId, serverName, serverUrl, row.secret_name]);
    const server = (await readManagedMcpManifest(access.rootPath)).servers.find(s => s.name === serverName && s.url === serverUrl && s.enabled !== false && s.authType === 'oauth');
    if (!current || !server) throw new Error('Agent MCP connection is no longer available');
  };
  await assertAccess();
  const bundle: OAuthBundle = {};
  let snapshot: Buffer;
  const refreshBundle = async () => {
    await assertAccess();
    const before = await queryOne<{ value_encrypted: Buffer }>("SELECT value_encrypted FROM secret_store WHERE name=$1 AND scope='user' AND owner_user_id=$2", [row.secret_name, row.secret_owner_user_id]);
    if (!before) throw new Error('MCP credential unavailable');
    const latest = await loadBundle(row.secret_name, row.secret_owner_user_id);
    const after = await queryOne<{ value_encrypted: Buffer }>("SELECT value_encrypted FROM secret_store WHERE name=$1 AND scope='user' AND owner_user_id=$2", [row.secret_name, row.secret_owner_user_id]);
    if (!after || !before.value_encrypted.equals(after.value_encrypted)) throw new Error('MCP credential changed; retry the call');
    snapshot = after.value_encrypted;
    delete bundle.client; delete bundle.tokens; delete bundle.verifier;
    Object.assign(bundle, latest);
  };
  await refreshBundle();
  return provider({ projectId, serverName, bundle, runtime: true, assertAccess, refreshBundle,
    persist: async () => {
      await assertAccess();
      // Reuse Vault encryption into a short-lived staging record, then atomically CAS ciphertext.
      // A stale/concurrent refresh can fail closed but can never overwrite the winning credential.
      const staging = `MCP_CAS_${randomUUID().replaceAll('-', '').toUpperCase()}`;
      await saveBundle(staging, row.secret_owner_user_id, bundle);
      try {
        const changed = await execute(`WITH updated AS (
          UPDATE secret_store target SET value_encrypted=staged.value_encrypted, rotated_at=now()
          FROM secret_store staged WHERE target.name=$1 AND target.scope='user' AND target.owner_user_id=$2
            AND target.value_encrypted=$3 AND staged.name=$4 AND staged.scope='user' AND staged.owner_user_id=$2
            AND EXISTS (SELECT 1 FROM project_mcp_connections WHERE project_id=$5 AND server_name=$6 AND secret_name=$1 AND connected=true)
          RETURNING target.id)
          UPDATE project_mcp_connections SET connected=$7,updated_at=now()
          WHERE project_id=$5 AND server_name=$6 AND secret_name=$1 AND EXISTS (SELECT 1 FROM updated)`,
          [row.secret_name, row.secret_owner_user_id, snapshot, staging, projectId, serverName, !!bundle.tokens]);
        if (!changed.changes) throw new Error('Concurrent MCP credential update; reconnect or retry');
      } finally { await removeOAuthSecret(staging, row.secret_owner_user_id).catch(() => {}); }
    },
  });
}

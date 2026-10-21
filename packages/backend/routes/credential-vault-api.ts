import { Router } from 'express';
import { execute, query } from '../db/pg-repo.js';
import { isAdminOrOperator, isPrivilegedRole } from '../services/pm/project-access.js';
import {
  allowedProjectCredentialWhere,
  deleteCredential,
  copyProjectCredential,
  listWorkspaceCredentials,
  promoteProjectCredentialToWorkspace,
  revealCredentialValue,
  rotateExistingCredential,
  updateCredentialLifecycle,
  upsertApiKeyCredential,
  upsertAgentGwsCredential,
  type CredentialVaultScope,
  type WorkspaceCredentialRow,
} from '../services/credential-vault/credential-vault-service.js';
import { validateAndBundleGoogleCredentialJson } from '../services/credential-vault/google-credential-json.js';
import { verifyGatewayProfile } from '../services/gateway-profile/gateway-profile-verify.js';

const router = Router();

function reqUser(req: any): { userId?: number; role?: string } {
  return { userId: req.user?.userId, role: req.user?.role };
}
function assertAuthenticated(req: any): { ok: true; userId: number; role?: string } | { ok: false; status: number; error: string } {
  const { userId, role } = reqUser(req);
  return userId ? { ok: true, userId, role } : { ok: false, status: 401, error: 'Auth required' };
}
function assertOperator(req: any): { ok: true; userId: number } | { ok: false; status: number; error: string } {
  const auth = assertAuthenticated(req);
  if (!auth.ok) return auth;
  return isAdminOrOperator(auth.role) ? { ok: true, userId: auth.userId } : { ok: false, status: 403, error: 'Admin/operator required' };
}
async function assertProjectConnectionManager(req: any, projectId: string): Promise<{ ok: true; userId: number } | { ok: false; status: number; error: string }> {
  const auth = assertAuthenticated(req);
  if (!auth.ok) return auth;
  if (isPrivilegedRole(auth.role)) return { ok: true, userId: auth.userId };
  if (auth.role !== 'member') return { ok: false, status: 403, error: 'Agent Credential management requires member access' };
  const rows = await query<{ membership_role: string | null }>(
    `SELECT pm.role AS membership_role
       FROM projects p LEFT JOIN project_members pm ON pm.project_id = p.id AND pm.user_id = $2
      WHERE p.id = $1`,
    [projectId, auth.userId],
  );
  if (!rows[0]) return { ok: false, status: 404, error: 'Agent not found' };
  if (['owner', 'admin', 'member'].includes(rows[0].membership_role ?? '')) {
    return { ok: true, userId: auth.userId };
  }
  return { ok: false, status: 403, error: 'Agent Credential management requires owner, admin, or member access' };
}

function bodyString(req: any, key: string, required = true): string | undefined {
  const value = req.body?.[key];
  if (typeof value === 'string' && value.trim()) return value.trim();
  if (required) throw new Error(`${key} required`);
  return undefined;
}
function bodyRawString(req: any, key: string): string {
  const value = req.body?.[key];
  if (typeof value !== 'string' || value.length === 0) throw new Error(`${key} required`);
  return value;
}
function publicCredential(row: WorkspaceCredentialRow) {
  const { secret_name: _secretName, ...safe } = row;
  return safe;
}
function credentialStructure(row: WorkspaceCredentialRow) {
  const materialization = row.metadata?.materialization && typeof row.metadata.materialization === 'object'
    ? row.metadata.materialization as Record<string, unknown> : null;
  return {
    credentialId: row.id,
    provider: row.provider,
    kind: row.kind,
    scope: row.scope,
    enabled: row.enabled,
    materialization: materialization?.type === 'file' ? 'file' : 'env',
    fieldCount: 1,
    hasStoredValue: true,
    rawValueAvailable: false,
    rotatedAt: row.rotated_at,
  };
}

async function createCredential(req: any, res: any, input: { scope: CredentialVaultScope; projectId?: string; actorUserId: number }) {
  try {
    const credential = await upsertApiKeyCredential({
      id: bodyString(req, 'id')!,
      provider: bodyString(req, 'provider')!,
      displayName: bodyString(req, 'displayName')!,
      secretName: bodyString(req, 'secretName')!,
      secretValue: bodyRawString(req, 'secretValue'),
      defaultEnvName: bodyString(req, 'defaultEnvName', false),
      scope: input.scope,
      projectId: input.projectId,
      metadata: typeof req.body?.metadata === 'object' && req.body.metadata !== null ? req.body.metadata : {},
      actorUserId: input.actorUserId,
    });
    res.json({ credential: publicCredential(credential), inputNormalizations: credential.metadata?.input_normalizations ?? [] });
  } catch (error: any) {
    res.status(error.code === 'CREDENTIAL_MANAGEMENT_DENIED' ? 403 : 400).json({ code: error.code, error: error.message || 'Credential create failed' });
  }
}

async function createProjectGoogleCredential(req: any, res: any, projectId: string, actorUserId: number) {
  try {
    const validated = validateAndBundleGoogleCredentialJson(bodyRawString(req, 'credentialJson'));
    const id = bodyString(req, 'id')!;
    const secretName = `GWS_AGENT_${id.toUpperCase().replace(/[^A-Z0-9_]+/g, '_')}_CONFIG_B64`.slice(0, 64);
    const credential = await upsertAgentGwsCredential({
      projectId, credentialId: id,
      displayName: bodyString(req, 'displayName')!, secretName,
      encodedConfig: validated.encodedGwsBundle,
      googleAccount: validated.accountHint,
      credentialTypeId: `google_${validated.type}`,
      actorUserId,
    });
    res.json({ credential: publicCredential(credential), credentialType: validated.type });
  } catch (error: any) {
    res.status(error.code === 'CREDENTIAL_MANAGEMENT_DENIED' ? 403 : 400).json({ code: error.code, error: error.message || 'Google credential create failed' });
  }
}

// VM Vault admin inventory. Secret values are never returned.
router.get('/admin-overview', async (req, res) => {
  const allowed = assertOperator(req);
  if (!allowed.ok) return res.status(allowed.status).json({ error: allowed.error });
  try {
    const credentials = await query<any>(
      `SELECT c.id, c.kind, c.provider, c.display_name, c.default_env_name, c.scope, c.project_id,
              c.metadata, c.enabled, c.rotated_at, c.created_at, c.updated_at,
              COALESCE(NULLIF(pap.display_name, ''), p.name) AS project_name,
              (p.id IS NULL AND c.scope = 'project') AS orphaned
         FROM workspace_credentials c
         LEFT JOIN projects p ON p.id = c.project_id
         LEFT JOIN project_agent_profiles pap ON pap.project_id = p.id
        ORDER BY CASE c.scope WHEN 'workspace' THEN 0 ELSE 1 END, project_name NULLS FIRST, c.provider, c.display_name`,
    );
    const audit = await query<any>(
      `SELECT a.id, a.credential_id, a.project_id, a.event_type, a.actor_user_id,
              a.provider, a.target_type, a.target_ref, a.status, a.error_code, a.message, a.created_at,
              u.username AS actor_name, COALESCE(NULLIF(pap.display_name, ''), p.name) AS project_name
         FROM credential_audit_events a
         LEFT JOIN users u ON u.id = a.actor_user_id
         LEFT JOIN projects p ON p.id = a.project_id
         LEFT JOIN project_agent_profiles pap ON pap.project_id = p.id
        ORDER BY a.created_at DESC LIMIT 100`,
    );
    res.json({
      summary: {
        total: credentials.length,
        workspace: credentials.filter(row => row.scope === 'workspace').length,
        project: credentials.filter(row => row.scope === 'project').length,
        orphaned: credentials.filter(row => row.orphaned === true).length,
      },
      credentials: credentials.map(row => ({
        id: row.id, kind: row.kind, provider: row.provider, displayName: row.display_name,
        envName: row.default_env_name, scope: row.scope, projectId: row.project_id,
        projectName: row.project_name, enabled: row.enabled, orphaned: row.orphaned === true,
        metadata: row.metadata ?? {}, rotatedAt: row.rotated_at, createdAt: row.created_at, updatedAt: row.updated_at,
      })),
      audit: audit.map(row => ({
        id: row.id, credentialId: row.credential_id, projectId: row.project_id, projectName: row.project_name,
        eventType: row.event_type, actorUserId: row.actor_user_id, actorName: row.actor_name,
        provider: row.provider, targetType: row.target_type, targetRef: row.target_ref ?? {},
        status: row.status, errorCode: row.error_code, message: row.message, createdAt: row.created_at,
      })),
    });
  } catch (error: any) { res.status(500).json({ error: error.message || 'VM Vault overview failed' }); }
});

// Secret-free VM Gateway Profile read model. Central gateway mutation remains an operator workflow.
router.get('/admin/gateway-profile', async (req, res) => {
  const allowed = assertOperator(req);
  if (!allowed.ok) return res.status(allowed.status).json({ error: allowed.error });
  try {
    const profiles = await query<any>(
      `SELECT gp.id, gp.version, gp.display_name, gp.gateway_provider, gp.gateway_base_url,
              gp.consumer_ref, gp.desired_state_hash, gp.applied_state_hash, gp.status,
              gp.last_verified_at, gp.last_error_code, gp.metadata, gp.created_at, gp.updated_at,
              (gp.credential_id IS NOT NULL) AS credential_configured,
              COALESCE(wc.enabled, false) AS credential_enabled,
              COALESCE(jsonb_agg(jsonb_build_object(
                'apiId', ce.api_id,
                'displayName', ce.display_name,
                'routePrefix', ce.route_prefix,
                'capability', ce.capability,
                'clientBaseEnv', ce.client_base_env,
                'enabled', ce.enabled,
                'costMeter', ce.cost_meter,
                'quotaMode', ce.quota_mode,
                'readiness', ce.readiness,
                'metadata', ce.metadata
              ) ORDER BY ce.api_id) FILTER (WHERE ce.api_id IS NOT NULL), '[]'::jsonb) AS catalog
         FROM gateway_profiles gp
         LEFT JOIN workspace_credentials wc ON wc.id = gp.credential_id AND wc.scope = 'workspace'
         LEFT JOIN gateway_profile_catalog_entries ce ON ce.profile_id = gp.id
        GROUP BY gp.id, wc.enabled
        ORDER BY gp.id`,
    );
    res.json({
      profiles: profiles.map(row => ({
        id: row.id,
        version: row.version,
        displayName: row.display_name,
        gatewayProvider: row.gateway_provider,
        gatewayBaseUrl: row.gateway_base_url,
        consumerRef: row.consumer_ref,
        desiredStateHash: row.desired_state_hash,
        appliedStateHash: row.applied_state_hash,
        stateMatches: Boolean(row.desired_state_hash && row.desired_state_hash === row.applied_state_hash),
        status: row.status,
        credential: { configured: row.credential_configured === true, enabled: row.credential_enabled === true },
        lastVerifiedAt: row.last_verified_at,
        lastErrorCode: row.last_error_code,
        metadata: row.metadata ?? {},
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        catalog: Array.isArray(row.catalog) ? row.catalog : [],
      })),
    });
  } catch (error: any) { res.status(500).json({ error: error.message || 'Gateway Profile read failed' }); }
});

router.patch('/admin/gateway-profile/catalog/:apiId', async (req, res) => {
  const allowed = assertOperator(req);
  if (!allowed.ok) return res.status(allowed.status).json({ error: allowed.error });
  const profileId = bodyString(req, 'profileId', false) ?? 'tower-shared-api-v1';
  const apiId = String(req.params.apiId || '').trim();
  if (!apiId || typeof req.body?.enabled !== 'boolean') return res.status(400).json({ error: 'API ID and enabled policy are required' });
  if (req.body?.confirmed !== true) return res.status(400).json({ error: 'Explicit confirmation is required to change Gateway API policy' });
  try {
    const result = await execute(
      `UPDATE gateway_profile_catalog_entries
          SET enabled = $3,
              readiness = CASE WHEN $3 THEN CASE WHEN readiness = 'disabled' THEN 'unverified' ELSE readiness END ELSE 'disabled' END,
              metadata = metadata || jsonb_build_object('policyUpdatedAt', NOW()::text, 'policyUpdatedBy', $4::int),
              updated_at = NOW()
        WHERE profile_id = $1 AND api_id = $2`,
      [profileId, apiId, req.body.enabled, allowed.userId],
    );
    if (result.changes !== 1) return res.status(404).json({ error: 'Gateway API catalog entry not found' });
    res.json({ profileId, apiId, enabled: req.body.enabled });
  } catch (error: any) { res.status(400).json({ error: error.message || 'Gateway API policy update failed' }); }
});

router.post('/admin/gateway-profile/verify', async (req, res) => {
  const allowed = assertOperator(req);
  if (!allowed.ok) return res.status(allowed.status).json({ error: allowed.error });
  if (req.body?.confirmed !== true) return res.status(400).json({ error: 'Explicit confirmation is required for gateway verification' });
  try {
    const result = await verifyGatewayProfile({
      actorUserId: allowed.userId,
      profileId: bodyString(req, 'profileId', false),
      apiId: bodyString(req, 'apiId', false),
    });
    res.json(result);
  } catch (error: any) {
    res.status(error.message === 'Gateway Profile not found' ? 404 : 400).json({ error: error.message || 'Gateway verification failed' });
  }
});

router.post('/admin/credentials/:credentialId/promote', async (req, res) => {
  const allowed = assertOperator(req);
  if (!allowed.ok) return res.status(allowed.status).json({ error: allowed.error });
  if (req.body?.confirmed !== true) return res.status(400).json({ error: 'Explicit confirmation is required to make an Agent Credential team-shared' });
  try {
    const credential = await promoteProjectCredentialToWorkspace({
      credentialId: req.params.credentialId,
      projectId: bodyString(req, 'projectId')!,
      actorUserId: allowed.userId,
    });
    res.json({ credential: publicCredential(credential) });
  } catch (error: any) { res.status(error.code === 'CREDENTIAL_MANAGEMENT_DENIED' ? 403 : 400).json({ error: error.message || 'Credential promotion failed' }); }
});

// Secret-free team Google catalog for Agent creation. Any authenticated user may
// inspect enabled workspace GWS metadata because these Credentials are automatic
// for every ordinary Project; secret names and values are never returned.
router.get('/connections/team-google', async (req, res) => {
  const auth = assertAuthenticated(req);
  if (!auth.ok) return res.status(auth.status).json({ error: auth.error });
  try {
    const credentials = (await listWorkspaceCredentials())
      .filter(row => row.enabled === true && row.scope === 'workspace' && !Object.prototype.hasOwnProperty.call(row.metadata ?? {}, 'legacy_personal_owner_user_id') && row.kind === 'gws' && row.provider === 'google')
      .map(row => ({
        id: row.id,
        displayName: row.display_name,
        googleAccount: typeof row.metadata?.google_account === 'string' ? row.metadata.google_account : '',
      }));
    res.json({ credentials });
  } catch (error: any) { res.status(500).json({ error: error.message || 'Team Google Connection list failed' }); }
});

// Team-shared Credentials. Workspace scope is automatically usable by every ordinary Project.
router.get('/credentials', async (req, res) => {
  const allowed = assertOperator(req);
  if (!allowed.ok) return res.status(allowed.status).json({ error: allowed.error });
  try { res.json({ credentials: (await listWorkspaceCredentials()).map(publicCredential) }); }
  catch (error: any) { res.status(500).json({ error: error.message || 'Credential list failed' }); }
});
router.post('/credentials/api-key', async (req, res) => {
  const allowed = assertOperator(req);
  if (!allowed.ok) return res.status(allowed.status).json({ error: allowed.error });
  return createCredential(req, res, { scope: 'workspace', actorUserId: allowed.userId });
});
router.post('/credentials/:credentialId/rotate', async (req, res) => {
  const allowed = assertOperator(req);
  if (!allowed.ok) return res.status(allowed.status).json({ error: allowed.error });
  try {
    const credential = await rotateExistingCredential({ credentialId: req.params.credentialId, secretValue: bodyRawString(req, 'secretValue'), actorUserId: allowed.userId, scope: 'workspace' });
    res.json({ credential: publicCredential(credential) });
  } catch (error: any) { res.status(error.code === 'CREDENTIAL_MANAGEMENT_DENIED' ? 403 : 400).json({ error: error.message || 'Credential rotate failed' }); }
});
router.patch('/credentials/:credentialId', async (req, res) => {
  const allowed = assertOperator(req);
  if (!allowed.ok) return res.status(allowed.status).json({ error: allowed.error });
  try {
    const credential = await updateCredentialLifecycle({ credentialId: req.params.credentialId, enabled: typeof req.body?.enabled === 'boolean' ? req.body.enabled : undefined, displayName: bodyString(req, 'displayName', false), actorUserId: allowed.userId, scope: 'workspace' });
    res.json({ credential: publicCredential(credential) });
  } catch (error: any) { res.status(error.code === 'CREDENTIAL_MANAGEMENT_DENIED' ? 403 : 400).json({ error: error.message || 'Credential update failed' }); }
});
router.delete('/credentials/:credentialId', async (req, res) => {
  const allowed = assertOperator(req);
  if (!allowed.ok) return res.status(allowed.status).json({ error: allowed.error });
  try {
    const deleted = await deleteCredential({ credentialId: req.params.credentialId, scope: 'workspace', actorUserId: allowed.userId });
    if (!deleted) return res.status(404).json({ error: 'Team Credential not found' });
    res.json({ ok: true });
  } catch (error: any) { res.status(error.code === 'CREDENTIAL_MANAGEMENT_DENIED' ? 403 : 400).json({ error: error.message || 'Credential delete failed' }); }
});

router.post('/credentials/:credentialId/reveal', async (req, res) => {
  const allowed = assertOperator(req);
  if (!allowed.ok) return res.status(allowed.status).json({ error: allowed.error });
  res.setHeader('Cache-Control', 'no-store, private');
  try {
    const revealed = await revealCredentialValue({
      credentialId: req.params.credentialId, actorUserId: allowed.userId,
      purpose: bodyString(req, 'purpose', false) ?? 'Company Connection value review',
    });
    res.json({ credentialId: revealed.credential.id, value: revealed.value });
  } catch (error: any) { res.status(error.code === 'CREDENTIAL_MANAGEMENT_DENIED' ? 403 : 400).json({ error: error.message || 'Credential reveal failed' }); }
});

// Agent-dedicated Credentials. workspace_credentials.project_id is the ownership/runtime gate.
router.get('/projects/:projectId/credentials', async (req, res) => {
  const projectId = req.params.projectId;
  const allowed = await assertProjectConnectionManager(req, projectId);
  if (!allowed.ok) return res.status(allowed.status).json({ error: allowed.error });
  try { res.json({ projectId, credentials: (await listWorkspaceCredentials({ scope: 'project', projectId })).map(publicCredential) }); }
  catch (error: any) { res.status(500).json({ error: error.message || 'Agent Credential list failed' }); }
});
router.post('/projects/:projectId/credentials/api-key', async (req, res) => {
  const projectId = req.params.projectId;
  const allowed = await assertProjectConnectionManager(req, projectId);
  if (!allowed.ok) return res.status(allowed.status).json({ error: allowed.error });
  return createCredential(req, res, { scope: 'project', projectId, actorUserId: allowed.userId });
});

router.post('/projects/:projectId/credentials/google-json', async (req, res) => {
  const projectId = req.params.projectId;
  const allowed = await assertProjectConnectionManager(req, projectId);
  if (!allowed.ok) return res.status(allowed.status).json({ error: allowed.error });
  return createProjectGoogleCredential(req, res, projectId, allowed.userId);
});
router.post('/projects/:projectId/credentials/:credentialId/rotate', async (req, res) => {
  const projectId = req.params.projectId;
  const allowed = await assertProjectConnectionManager(req, projectId);
  if (!allowed.ok) return res.status(allowed.status).json({ error: allowed.error });
  try {
    const credential = await rotateExistingCredential({ credentialId: req.params.credentialId, secretValue: bodyRawString(req, 'secretValue'), actorUserId: allowed.userId, scope: 'project', projectId });
    res.json({ credential: publicCredential(credential) });
  } catch (error: any) { res.status(error.code === 'CREDENTIAL_MANAGEMENT_DENIED' ? 403 : 400).json({ error: error.message || 'Agent Credential rotate failed' }); }
});
router.post('/projects/:projectId/credentials/:credentialId/inspect', async (req, res) => {
  const projectId = req.params.projectId;
  const allowed = await assertProjectConnectionManager(req, projectId);
  if (!allowed.ok) return res.status(allowed.status).json({ error: allowed.error });
  res.setHeader('Cache-Control', 'no-store, private');
  try {
    const row = (await listWorkspaceCredentials({ scope: 'project', projectId })).find(item => item.id === req.params.credentialId);
    if (!row) return res.status(404).json({ error: 'Agent Credential not found' });
    res.json(credentialStructure(row));
  } catch (error: any) { res.status(error.code === 'CREDENTIAL_MANAGEMENT_DENIED' ? 403 : 400).json({ error: error.message || 'Credential inspection failed' }); }
});
router.post('/projects/:projectId/credentials/:credentialId/reveal', async (req, res) => {
  const projectId = req.params.projectId;
  const allowed = await assertProjectConnectionManager(req, projectId);
  if (!allowed.ok) return res.status(allowed.status).json({ error: allowed.error });
  res.setHeader('Cache-Control', 'no-store, private');
  try {
    const revealed = await revealCredentialValue({
      projectId,
      credentialId: req.params.credentialId,
      actorUserId: allowed.userId,
      purpose: bodyString(req, 'purpose', false) ?? 'Connection value review',
    });
    res.json({ credentialId: revealed.credential.id, value: revealed.value });
  } catch (error: any) { res.status(error.code === 'CREDENTIAL_MANAGEMENT_DENIED' ? 403 : 400).json({ error: error.message || 'Credential reveal failed' }); }
});
router.get('/projects/:projectId/credentials/import-candidates', async (req, res) => {
  const targetProjectId = req.params.projectId;
  const targetAllowed = await assertProjectConnectionManager(req, targetProjectId);
  if (!targetAllowed.ok) return res.status(targetAllowed.status).json({ error: targetAllowed.error });
  const auth = assertAuthenticated(req);
  if (!auth.ok) return res.status(auth.status).json({ error: auth.error });
  try {
    const rows = await query<any>(
      `SELECT c.id AS credential_id, c.display_name, c.provider, c.kind, c.project_id,
              COALESCE(NULLIF(pap.display_name, ''), p.name, c.project_id::text) AS project_name
         FROM workspace_credentials c
         JOIN projects p ON p.id = c.project_id
         LEFT JOIN project_agent_profiles pap ON pap.project_id = p.id
        WHERE c.scope = 'project' AND c.enabled = true AND c.project_id <> $1
          AND NOT (COALESCE(c.metadata, '{}'::jsonb) ? 'legacy_personal_owner_user_id')
          AND ($3::boolean OR EXISTS (
            SELECT 1 FROM project_members pm WHERE pm.project_id = p.id AND pm.user_id = $2 AND pm.role IN ('owner', 'admin', 'member')
          ))
        ORDER BY project_name, c.provider, c.display_name`,
      [targetProjectId, auth.userId, isPrivilegedRole(auth.role)],
    );
    res.json({ candidates: rows.map(row => ({ credentialId: row.credential_id, displayName: row.display_name, provider: row.provider, kind: row.kind, projectId: row.project_id, projectName: row.project_name })) });
  } catch (error: any) { res.status(500).json({ error: error.message || 'Credential import candidates failed' }); }
});
router.post('/projects/:projectId/credentials/import', async (req, res) => {
  const targetProjectId = req.params.projectId;
  const targetAllowed = await assertProjectConnectionManager(req, targetProjectId);
  if (!targetAllowed.ok) return res.status(targetAllowed.status).json({ error: targetAllowed.error });
  try {
    const sourceProjectId = bodyString(req, 'sourceProjectId')!;
    const sourceAllowed = await assertProjectConnectionManager(req, sourceProjectId);
    if (!sourceAllowed.ok) return res.status(sourceAllowed.status).json({ error: sourceAllowed.error });
    const credential = await copyProjectCredential({ sourceProjectId, sourceCredentialId: bodyString(req, 'sourceCredentialId')!, targetProjectId, actorUserId: targetAllowed.userId });
    res.json({ credential: publicCredential(credential) });
  } catch (error: any) { res.status(error.code === 'CREDENTIAL_MANAGEMENT_DENIED' ? 403 : 400).json({ error: error.message || 'Credential import failed' }); }
});
router.patch('/projects/:projectId/credentials/:credentialId', async (req, res) => {
  const projectId = req.params.projectId;
  const allowed = await assertProjectConnectionManager(req, projectId);
  if (!allowed.ok) return res.status(allowed.status).json({ error: allowed.error });
  try {
    const credential = await updateCredentialLifecycle({ credentialId: req.params.credentialId, enabled: typeof req.body?.enabled === 'boolean' ? req.body.enabled : undefined, displayName: bodyString(req, 'displayName', false), actorUserId: allowed.userId, scope: 'project', projectId });
    res.json({ credential: publicCredential(credential) });
  } catch (error: any) { res.status(error.code === 'CREDENTIAL_MANAGEMENT_DENIED' ? 403 : 400).json({ error: error.message || 'Agent Credential update failed' }); }
});
router.delete('/projects/:projectId/credentials/:credentialId', async (req, res) => {
  const projectId = req.params.projectId;
  const allowed = await assertProjectConnectionManager(req, projectId);
  if (!allowed.ok) return res.status(allowed.status).json({ error: allowed.error });
  try {
    const deleted = await deleteCredential({ credentialId: req.params.credentialId, scope: 'project', projectId, actorUserId: allowed.userId });
    if (!deleted) return res.status(404).json({ error: 'Agent Credential not found' });
    res.json({ ok: true });
  } catch (error: any) { res.status(error.code === 'CREDENTIAL_MANAGEMENT_DENIED' ? 403 : 400).json({ error: error.message || 'Agent Credential delete failed' }); }
});

/** Secret-free catalog. Shared Credentials are automatic; Agent Credentials are already owned by this Agent. */
router.get('/projects/:projectId/connections/catalog', async (req, res) => {
  const projectId = req.params.projectId;
  const allowed = await assertProjectConnectionManager(req, projectId);
  if (!allowed.ok) return res.status(allowed.status).json({ error: allowed.error });
  try {
    const rows = await query<WorkspaceCredentialRow>(
      `SELECT * FROM workspace_credentials c WHERE c.enabled = true
        AND ${allowedProjectCredentialWhere('c', '$1')}
       ORDER BY CASE c.scope WHEN 'workspace' THEN 0 ELSE 1 END, c.provider, c.display_name`,
      [projectId],
    );
    res.json({
      projectId,
      connections: rows.map(row => ({
        id: `credential:${row.id}`,
        credentialId: row.id,
        displayName: row.display_name,
        provider: row.provider,
        kind: row.kind,
        scope: row.scope,
        connectionScope: row.scope === 'workspace' ? 'team_shared' : 'agent_dedicated',
        status: 'connected',
        automatic: row.scope === 'workspace',
        canDisconnect: false,
        canDisable: row.scope === 'project' || isAdminOrOperator(reqUser(req).role),
        canReveal: row.scope === 'project' || isAdminOrOperator(reqUser(req).role),
      })),
    });
  } catch (error: any) { res.status(500).json({ error: error.message || 'Connection catalog failed' }); }
});

export default router;

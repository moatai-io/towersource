/**
 * credential-vault-api.ts — Workspace Credential Vault admin API.
 *
 * Owns: authenticated endpoints for issue #67 MVP credential metadata and
 * GitHub Actions secret target status/sync.
 * Public API: mounted under /api/credential-vault.
 * See services/credential-vault/README.md.
 */

import { createHash } from 'crypto';
import { Router } from 'express';
import { isPrivilegedRole } from '../services/pm/project-access.js';
import { isProjectMember } from '../services/pm/project-membership-manager.js';
import {
  auditCredentialEvent,
  checkGitHubActionsSecretStatus,
  classifyRuntimeBoxFileCredential,
  listCredentialBundleTypes,
  listCredentialTypes,
  listWorkspaceCredentials,
  rotateExistingCredential,
  setProjectCredentialPolicy,
  setProjectCredentialProfilePolicy,
  syncGitHubActionsSecret,
  testCredentialMaterialization,
  upsertApiKeyCredential,
  upsertCredentialBundle,
  upsertGitHubActionsSecretTarget,
  upsertSshPrivateKeyCredential,
  upsertTypedCredential,
  type CredentialVaultScope,
} from '../services/credential-vault/credential-vault-service.js';
import { query } from '../db/pg-repo.js';
import { applyHostSecretImport, previewHostSecretImport } from '../services/credential-vault/host-secret-import/host-secret-import.js';
import { deriveConnectionReadiness } from '../services/credential-vault/connection-read-model.js';
import { connectionManifest, previewConnectionChange, verifyConnectionChange, type ConnectionAssistantAction, type ConnectionSource } from '../services/credential-vault/connection-assistant.js';
import { previewCredentialRotate, verifyCredentialRotate, type CredentialRotateTarget } from '../services/credential-vault/credential-rotate-assistant.js';
import { credentialAllowedActions } from '../services/credential-vault/credential-reveal-policy.js';
import { probeConnection } from '../services/credential-vault/provider-health/connection-probe.js';
import { createRevealChallenge, revealCredentialFieldAsAdmin, compareCredentialField, inspectCredential } from '../services/credential-vault/credential-reveal-service.js';

const router = Router();

function requesterHash(req: any): string {
  const raw = `${req.ip || req.socket?.remoteAddress || 'unknown'}|${req.get?.('user-agent') || 'unknown'}`;
  return createHash('sha256').update(raw).digest('hex');
}

function reqUser(req: any): { userId: number | undefined; username: string | undefined; role: string | undefined } {
  return { userId: req.user?.userId, username: req.user?.username, role: req.user?.role };
}

function assertOperator(req: any): { ok: true; userId: number } | { ok: false; status: number; error: string } {
  const { userId, role } = reqUser(req);
  if (!userId) return { ok: false, status: 401, error: 'Auth required' };
  if (!isPrivilegedRole(role)) return { ok: false, status: 403, error: 'Admin/operator required' };
  return { ok: true, userId };
}

function assertAdmin(req: any): { ok: true; userId: number } | { ok: false; status: number; error: string } {
  const { userId, role } = reqUser(req);
  if (!userId) return { ok: false, status: 401, error: 'Auth required' };
  if (role !== 'admin') return { ok: false, status: 403, error: 'Admin required' };
  return { ok: true, userId };
}

function assertAuthenticated(req: any): { ok: true; userId: number; role: string | undefined } | { ok: false; status: number; error: string } {
  const { userId, role } = reqUser(req);
  if (!userId) return { ok: false, status: 401, error: 'Auth required' };
  return { ok: true, userId, role };
}

async function assertProjectViewer(req: any, projectId: string): Promise<{ ok: true; userId: number } | { ok: false; status: number; error: string }> {
  const { userId, role } = reqUser(req);
  if (!userId) return { ok: false, status: 401, error: 'Auth required' };
  if (isPrivilegedRole(role)) return { ok: true, userId };
  if (await isProjectMember(projectId, userId)) return { ok: true, userId };
  return { ok: false, status: 403, error: 'Access denied: not a project member' };
}

async function assertProjectConnectionManager(req: any, projectId: string): Promise<{ ok: true; userId: number } | { ok: false; status: number; error: string }> {
  const { userId, role } = reqUser(req);
  if (!userId) return { ok: false, status: 401, error: 'Auth required' };
  if (isPrivilegedRole(role)) return { ok: true, userId };
  if (role === 'viewer' || role === 'guest') return { ok: false, status: 403, error: 'Agent Connection management requires member access' };
  const rows = await query<{ membership_role: string | null; creator_user_id: number | null }>(
    `SELECT pm.role AS membership_role, p.user_id AS creator_user_id
       FROM projects p
       LEFT JOIN project_members pm ON pm.project_id = p.id AND pm.user_id = $2
      WHERE p.id = $1`,
    [projectId, userId],
  );
  if (rows.length === 0) return { ok: false, status: 404, error: 'Agent not found' };
  const membershipRole = rows[0].membership_role;
  const isCreator = Number(rows[0].creator_user_id) === userId;
  if (isCreator || ['owner', 'admin', 'member'].includes(membershipRole ?? '')) return { ok: true, userId };
  return { ok: false, status: 403, error: 'Agent Connection management requires owner, admin, or member access' };
}

function bodyString(req: any, key: string, required = true): string | undefined {
  const value = req.body?.[key];
  if (typeof value === 'string' && value.trim()) return value.trim();
  if (required) throw new Error(`${key} required`);
  return undefined;
}

function bodyRawString(req: any, key: string, required = true): string | undefined {
  const value = req.body?.[key];
  if (typeof value === 'string' && value.length > 0) return value;
  if (required) throw new Error(`${key} required`);
  return undefined;
}

function parseTargetId(req: any): number {
  const id = parseInt(req.params.targetId as string, 10);
  if (!Number.isFinite(id) || id <= 0) throw new Error('invalid target id');
  return id;
}

router.get('/credentials', async (req, res) => {
  const allowed = assertOperator(req);
  if (!allowed.ok) return res.status(allowed.status).json({ error: allowed.error });
  try {
    const credentials = await listWorkspaceCredentials({ userId: allowed.userId, includePersonal: false });
    res.json({ credentials });
  } catch (err: any) {
    res.status(500).json({ error: err.message || 'Credential list failed' });
  }
});

router.get('/my/credentials', async (req, res) => {
  const allowed = assertAuthenticated(req);
  if (!allowed.ok) return res.status(allowed.status).json({ error: allowed.error });
  try {
    const credentials = await listWorkspaceCredentials({ userId: allowed.userId, personalOnly: true });
    res.json({ credentials });
  } catch (err: any) {
    res.status(500).json({ error: err.message || 'Personal credential list failed' });
  }
});

router.get('/bundle-types', async (req, res) => {
  const allowed = assertAuthenticated(req);
  if (!allowed.ok) return res.status(allowed.status).json({ error: allowed.error });
  res.json({ types: listCredentialBundleTypes() });
});

router.get('/credential-types', async (req, res) => {
  const allowed = assertAuthenticated(req);
  if (!allowed.ok) return res.status(allowed.status).json({ error: allowed.error });
  res.json({ types: listCredentialTypes() });
});

async function createTypedCredential(req: any, res: any, allowed: { userId: number }, scope: CredentialVaultScope, ownerUserId: number | null) {
  try {
    const result = await upsertTypedCredential({
      typeId: bodyString(req, 'typeId')!,
      id: bodyString(req, 'id')!,
      displayName: bodyString(req, 'displayName')!,
      secretName: bodyString(req, 'secretName')!,
      values: typeof req.body?.values === 'object' && req.body.values !== null ? req.body.values : {},
      defaultEnvName: bodyString(req, 'defaultEnvName', false),
      pathEnvName: bodyString(req, 'pathEnvName', false),
      projectId: bodyString(req, 'projectId', false) ?? null,
      scope,
      ownerUserId,
      filename: bodyString(req, 'filename', false),
      mode: bodyString(req, 'mode', false),
      actorUserId: allowed.userId,
    });
    res.json({
      credential: { ...result.credential, value: undefined },
      grantedProjectId: result.grantedProjectId,
      envName: result.envName,
      pathEnvName: result.pathEnvName,
    });
  } catch (err: any) {
    res.status(400).json({ error: err.message || 'Typed credential upsert failed' });
  }
}

router.post('/credentials/typed', async (req, res) => {
  const allowed = assertAdmin(req);
  if (!allowed.ok) return res.status(allowed.status).json({ error: allowed.error });
  return createTypedCredential(req, res, allowed, (bodyString(req, 'scope', false) as CredentialVaultScope) ?? 'workspace', null);
});

router.post('/my/credentials/typed', async (req, res) => {
  const allowed = assertAuthenticated(req);
  if (!allowed.ok) return res.status(allowed.status).json({ error: allowed.error });
  const projectId = bodyString(req, 'projectId', false);
  if (projectId) {
    const projectAllowed = await assertProjectViewer(req, projectId);
    if (!projectAllowed.ok) return res.status(projectAllowed.status).json({ error: projectAllowed.error });
  }
  return createTypedCredential(req, res, allowed, 'personal', allowed.userId);
});

router.post('/credentials/:credentialId/test', async (req, res) => {
  const allowed = assertAdmin(req);
  if (!allowed.ok) return res.status(allowed.status).json({ error: allowed.error });
  try {
    const result = await testCredentialMaterialization({
      credentialId: req.params.credentialId as string,
      userId: allowed.userId,
    });
    // A completed test with failed checks is still a successful API call. The UI
    // renders result.ok/checks so users see what failed instead of "button broke".
    res.json(result);
  } catch (err: any) {
    res.status(400).json({ error: err.message || 'Credential materialization test failed' });
  }
});

router.get('/project-policies', async (req, res) => {
  const allowed = assertAdmin(req);
  if (!allowed.ok) return res.status(allowed.status).json({ error: allowed.error });
  try {
    const policies = await query(
      `SELECT project_id, credential_id, mode, target_env_name, updated_at
         FROM project_credential_policies
        ORDER BY project_id, credential_id`,
    );
    res.json({ policies });
  } catch (err: any) {
    res.status(500).json({ error: err.message || 'Project credential policy list failed' });
  }
});

router.get('/my/project-policies', async (req, res) => {
  const allowed = assertAuthenticated(req);
  if (!allowed.ok) return res.status(allowed.status).json({ error: allowed.error });
  try {
    const policies = await query(
      `SELECT p.project_id, p.credential_id, p.mode, p.target_env_name, p.updated_at
         FROM project_credential_policies p
         JOIN workspace_credentials c ON c.id = p.credential_id
        WHERE c.scope = 'personal' AND c.owner_user_id = $1
        ORDER BY p.project_id, p.credential_id`,
      [allowed.userId],
    );
    res.json({ policies });
  } catch (err: any) {
    res.status(500).json({ error: err.message || 'Personal project credential policy list failed' });
  }
});

router.get('/projects/:projectId/connections/catalog', async (req, res) => {
  const projectId = req.params.projectId as string;
  const allowed = await assertProjectConnectionManager(req, projectId);
  if (!allowed.ok) return res.status(allowed.status).json({ error: allowed.error });
  try {
    const [project, credentials, profiles] = await Promise.all([
      query(`SELECT id, name FROM projects WHERE id = $1`, [projectId]),
      query(
        `SELECT c.id, c.provider, c.display_name, c.kind, c.metadata, c.enabled,
                p.mode, p.updated_at AS policy_updated_at
           FROM workspace_credentials c
           LEFT JOIN project_credential_policies p ON p.credential_id = c.id AND p.project_id = $1
          WHERE c.enabled = true AND c.scope = 'workspace'
          ORDER BY lower(c.display_name), c.id`,
        [projectId],
      ),
      query(
        `SELECT cp.id, cp.provider, cp.display_name, cp.profile_type, cp.metadata, cp.enabled,
                pp.mode, pp.updated_at AS policy_updated_at
           FROM credential_profiles cp
           LEFT JOIN project_credential_profile_policies pp ON pp.profile_id = cp.id AND pp.project_id = $1
          WHERE cp.enabled = true
            AND NOT EXISTS (
              SELECT 1 FROM jsonb_each_text(COALESCE(cp.secret_refs, '{}'::jsonb)) refs
              JOIN workspace_credentials wc ON wc.id = refs.value
              WHERE wc.scope IN ('personal', 'internal-default')
            )
          ORDER BY lower(cp.display_name), cp.id`,
        [projectId],
      ),
    ]);
    if (!(project as any[])[0]) return res.status(404).json({ error: 'Agent not found' });
    const toItem = (row: any, source: ConnectionSource) => {
      const manifest = connectionManifest(row.provider);
      return {
        id: `${source}:${row.id}`,
        source,
        displayName: row.display_name,
        provider: manifest.provider,
        connectionType: source === 'profile' ? row.profile_type : row.kind,
        capabilities: manifest.capabilities,
        status: row.mode === 'deny' ? 'blocked' : row.mode ? 'connected' : 'available',
        mode: row.mode ?? null,
        updatedAt: row.policy_updated_at ?? null,
      };
    };
    res.json({
      project: (project as any[])[0],
      connections: [
        ...(profiles as any[]).map(row => toItem(row, 'profile')),
        ...(credentials as any[]).map(row => toItem(row, 'credential')),
      ],
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message || 'Organization Connection catalog failed' });
  }
});

router.post('/connections/:connectionId/preview', async (req, res) => {
  try {
    const connectionId = decodeURIComponent(req.params.connectionId as string);
    const action = bodyString(req, 'action') as ConnectionAssistantAction;
    if (!['connect', 'disconnect'].includes(action)) throw new Error('action must be connect or disconnect');
    const projectId = bodyString(req, 'projectId')!;
    const allowed = await assertProjectConnectionManager(req, projectId);
    if (!allowed.ok) return res.status(allowed.status).json({ error: allowed.error });
    const [project, source] = await Promise.all([
      query(`SELECT id, name FROM projects WHERE id = $1`, [projectId]),
      connectionId.startsWith('profile:')
        ? query(
            `SELECT cp.id, cp.provider, cp.display_name
               FROM credential_profiles cp
              WHERE cp.id = $1 AND cp.enabled = true
                AND NOT EXISTS (
                  SELECT 1 FROM jsonb_each_text(COALESCE(cp.secret_refs, '{}'::jsonb)) refs
                  JOIN workspace_credentials wc ON wc.id = refs.value
                  WHERE wc.scope = 'personal'
                )`,
            [connectionId.slice('profile:'.length)],
          )
        : connectionId.startsWith('credential:')
          ? query(`SELECT id, provider, display_name FROM workspace_credentials WHERE id = $1 AND enabled = true AND scope IN ('workspace', 'internal-default')`, [connectionId.slice('credential:'.length)])
          : Promise.resolve([]),
    ]);
    if (!(project as any[])[0]) return res.status(404).json({ error: 'Project not found' });
    if (!(source as any[])[0]) return res.status(404).json({ error: 'Connection not found' });
    const sourceType: ConnectionSource = connectionId.startsWith('profile:') ? 'profile' : 'credential';
    const sourceRow = (source as any[])[0];
    const preview = previewConnectionChange({
      actorUserId: allowed.userId,
      connectionId,
      connectionDisplayName: sourceRow.display_name,
      source: sourceType,
      sourceId: sourceRow.id,
      projectId,
      projectName: (project as any[])[0].name,
      provider: sourceRow.provider,
      riskLevel: (bodyString(req, 'riskLevel', false) as 'low' | 'medium' | 'high') ?? 'medium',
      action,
    });
    await query(
      `INSERT INTO credential_connection_change_intents
       (id, actor_user_id, connection_id, connection_display_name, source, source_id, provider, project_id, project_name, action, risk_level, proposal_hash, expires_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
      [preview.intentId, allowed.userId, connectionId, sourceRow.display_name, sourceType, sourceRow.id, sourceRow.provider ?? null, projectId, (project as any[])[0].name, action, preview.risk, preview.proposalHash, preview.expiresAt],
    );
    res.json(preview);
  } catch (err: any) {
    res.status(400).json({ error: err.message || 'Connection preview failed', code: err.code });
  }
});

router.post('/connections/:connectionId/apply', async (req, res) => {
  const authenticated = assertAuthenticated(req);
  if (!authenticated.ok) return res.status(authenticated.status).json({ error: authenticated.error });
  try {
    if (req.body?.confirmed !== true) return res.status(400).json({ error: 'Explicit confirmation required', code: 'CONFIRMATION_REQUIRED' });
    const connectionId = decodeURIComponent(req.params.connectionId as string);
    const rows = await query(
      `SELECT * FROM credential_connection_change_intents
       WHERE id = $1 AND actor_user_id = $2 AND connection_id = $3 AND proposal_hash = $4
         AND status = 'previewed' AND consumed_at IS NULL AND expires_at > now()`,
      [bodyString(req, 'intentId')!, authenticated.userId, connectionId, bodyString(req, 'proposalHash')!],
    );
    const intent = (rows as any[])[0];
    if (!intent) return res.status(409).json({ error: 'Valid unused Connection preview required', code: 'INTENT_EXPIRED_OR_CONSUMED' });
    const allowed = await assertProjectConnectionManager(req, intent.project_id);
    if (!allowed.ok) return res.status(allowed.status).json({ error: allowed.error });
    const verified = verifyConnectionChange({
      actorUserId: allowed.userId,
      connectionId: intent.connection_id,
      connectionDisplayName: intent.connection_display_name,
      source: intent.source,
      sourceId: intent.source_id,
      projectId: intent.project_id,
      projectName: intent.project_name,
      provider: intent.provider,
      riskLevel: intent.risk_level,
      action: intent.action,
      expiresAt: new Date(intent.expires_at).toISOString(),
      proposalHash: intent.proposal_hash,
      confirmed: true,
    });
    if (intent.source === 'profile') {
      await setProjectCredentialProfilePolicy({ projectId: intent.project_id, profileId: intent.source_id, mode: verified.mode, metadata: verified.metadata, actorUserId: allowed.userId });
    } else {
      await setProjectCredentialPolicy({ projectId: intent.project_id, credentialId: intent.source_id, mode: verified.mode, metadata: verified.metadata, actorUserId: allowed.userId });
    }
    await query(`UPDATE credential_connection_change_intents SET status = 'applied', consumed_at = now() WHERE id = $1 AND status = 'previewed'`, [intent.id]);
    res.json({ ok: true, connectionId, projectId: intent.project_id, action: intent.action, next: 'refresh' });
  } catch (err: any) {
    res.status(400).json({ error: err.message || 'Connection apply failed', code: err.code });
  }
});

router.post('/connections/:connectionId/projects/:projectId/probe', async (req, res) => {
  const projectId = req.params.projectId as string;
  const allowed = await assertProjectConnectionManager(req, projectId);
  if (!allowed.ok) return res.status(allowed.status).json({ error: allowed.error });
  try {
    const connectionId = decodeURIComponent(req.params.connectionId as string);
    const source = connectionId.startsWith('profile:') ? 'profile' : connectionId.startsWith('credential:') ? 'credential' : null;
    if (!source) return res.status(404).json({ error: 'Connection not found' });
    const sourceId = connectionId.slice(`${source}:`.length);
    const rows = source === 'credential'
      ? await query(
          `SELECT c.id, c.provider, c.kind AS connection_type
             FROM workspace_credentials c
             LEFT JOIN project_credential_policies p ON p.credential_id = c.id AND p.project_id = $1
            WHERE c.id = $2 AND c.enabled = true
              AND c.scope IN ('workspace', 'internal-default', 'project')
              AND (
                p.mode IN ('allow', 'override', 'inherit')
                OR (p.mode IS NULL AND c.scope IN ('workspace', 'internal-default'))
              )`,
          [projectId, sourceId],
        )
      : await query(
          `SELECT cp.id, cp.provider, cp.profile_type AS connection_type
             FROM credential_profiles cp
             JOIN project_credential_profile_policies pp ON pp.profile_id = cp.id AND pp.project_id = $1
            WHERE cp.id = $2 AND cp.enabled = true AND pp.mode = 'allow'
              AND NOT EXISTS (
                SELECT 1 FROM jsonb_each_text(COALESCE(cp.secret_refs, '{}'::jsonb)) refs
                JOIN workspace_credentials wc ON wc.id = refs.value
                WHERE wc.scope = 'personal'
              )`,
          [projectId, sourceId],
        );
    const connection = (rows as any[])[0];
    if (!connection) return res.status(409).json({ error: 'Connection must be explicitly allowed for this Agent before testing', code: 'PROJECT_ACCESS_REQUIRED' });
    res.json(await probeConnection({
      connection: { id: connection.id, source, provider: connection.provider, connectionType: connection.connection_type },
      projectId,
      userId: allowed.userId,
    }));
  } catch (err: any) {
    res.status(400).json({ error: err.message || 'Connection health probe failed', code: err.code });
  }
});

router.get('/admin-overview', async (req, res) => {
  const allowed = assertOperator(req);
  if (!allowed.ok) return res.status(allowed.status).json({ error: allowed.error });
  try {
    const [projects, credentials, profiles, credentialPolicies, profilePolicies, connectionDefaults, targets, recentEvents] = await Promise.all([
      query(`SELECT id, name FROM projects ORDER BY lower(name), id`),
      query(
        `SELECT id, kind, provider, display_name, secret_name, default_env_name, scope, owner_user_id, metadata, enabled, rotated_at, updated_at
           FROM workspace_credentials
          WHERE scope <> 'personal'
          ORDER BY provider, id`,
      ),
      query(
        `SELECT id, profile_type, provider, display_name, env, secret_refs, metadata, enabled, updated_at
           FROM credential_profiles
          ORDER BY provider, id`,
      ),
      query(
        `SELECT project_id, credential_id, mode, target_env_name, updated_at
           FROM project_credential_policies`,
      ),
      query(
        `SELECT project_id, profile_id, mode, updated_at
           FROM project_credential_profile_policies`,
      ),
      query(
        `SELECT connection_id, default_mode, project_template, enabled, risk_ack_required, reason, updated_at
           FROM workspace_connection_defaults`,
      ),
      query(
        `SELECT id, credential_id, project_id, target_type, target_ref, enabled, last_status, last_checked_at, last_synced_at, last_error
           FROM credential_target_syncs
          ORDER BY created_at DESC`,
      ),
      query(
        `SELECT DISTINCT ON (credential_id, project_id) credential_id, project_id, event_type, actor_user_id, status, created_at
           FROM credential_audit_events
          WHERE target_type = 'runtime_box_env'
          ORDER BY credential_id, project_id, created_at DESC`,
      ),
    ]);

    const credentialById = new Map((credentials as any[]).map(c => [c.id, c]));
    const defaultByConnectionId = new Map((connectionDefaults as any[]).map(d => [d.connection_id, d]));
    const policyByProjectCredential = new Map((credentialPolicies as any[]).map(p => [`${p.project_id}\u0000${p.credential_id}`, p]));
    const profilePolicyByProjectProfile = new Map((profilePolicies as any[]).map(p => [`${p.project_id}\u0000${p.profile_id}`, p]));
    const targetsByCredential = new Map<string, any[]>();
    for (const target of targets as any[]) {
      const list = targetsByCredential.get(target.credential_id) ?? [];
      list.push(target);
      targetsByCredential.set(target.credential_id, list);
    }
    const recentByProjectCredential = new Map((recentEvents as any[]).map(e => [`${e.project_id}\u0000${e.credential_id}`, e]));

    const credentialType = (credential: any): string => {
      const metadataType = credential.metadata?.credential_type;
      const fileCredential = classifyRuntimeBoxFileCredential({
        credentialId: credential.id,
        provider: credential.provider,
        kind: credential.kind,
        secretName: credential.secret_name,
        defaultEnvName: credential.default_env_name,
        targetEnvName: null,
        metadata: credential.metadata ?? {},
      });
      return fileCredential?.credentialType ?? (typeof metadataType === 'string' ? metadataType : credential.kind);
    };

    const riskLevel = (items: any[]): 'low' | 'medium' | 'high' => {
      if (items.some(c => credentialType(c) === 'ssh_private_key' || c.provider === 'ssh' || c.kind === 'gws' || c.kind === 'oauth' || c.kind === 'service_account')) return 'high';
      if (items.length > 1 || items.some(c => c.scope === 'workspace' || c.scope === 'internal-default')) return 'medium';
      return 'low';
    };

    const projectById = new Map((projects as any[]).map(project => [project.id, project]));
    const connectionDefaultApplies = (connectionId: string, projectId?: string): boolean => {
      const policy = defaultByConnectionId.get(connectionId);
      if (!policy || policy.enabled !== true) return false;
      if (policy.default_mode === 'all_projects' || policy.default_mode === 'new_projects') return true;
      if (policy.default_mode !== 'project_template' || !policy.project_template || !projectId) return false;
      const project = projectById.get(projectId);
      if (!project) return false;
      const template = String(policy.project_template).toLowerCase();
      const rootSlug = String(project.root_path ?? '').split('/').filter(Boolean).pop()?.toLowerCase() ?? '';
      const candidates = [project.name, project.space_slug, rootSlug].filter(Boolean).map((value: any) => String(value).toLowerCase());
      return candidates.includes(template);
    };

    const effectiveCredentialStatus = (projectId: string, credential: any) => {
      const policy = policyByProjectCredential.get(`${projectId}\u0000${credential.id}`);
      const credentialConnectionId = `credential:${credential.id}`;
      const explicitDefault = connectionDefaultApplies(credentialConnectionId, projectId);
      const legacyInherited = !defaultByConnectionId.has(credentialConnectionId) && ['workspace', 'internal-default'].includes(credential.scope);
      const inherited = !policy && (explicitDefault || legacyInherited);
      const allowedMode = policy && ['allow', 'override', 'inherit'].includes(String(policy.mode));
      let status: 'connected' | 'blocked' | 'inherited' | 'off' | 'disabled' = 'off';
      let reason = 'not granted';
      if (!credential.enabled) {
        status = 'disabled';
        reason = policy ? `credential disabled; policy is ${policy.mode}` : 'credential disabled';
      } else if (policy?.mode === 'deny') {
        status = 'blocked';
        reason = 'explicit deny';
      } else if (allowedMode) {
        status = 'connected';
        reason = `explicit ${policy.mode}`;
      } else if (inherited) {
        status = 'inherited';
        reason = explicitDefault ? 'default connection policy' : `${credential.scope} inherited by default`;
      }
      return {
        status,
        reason,
        mode: policy?.mode ?? (inherited ? 'inherit' : null),
        targetEnvName: policy?.target_env_name ?? null,
        updatedAt: policy?.updated_at ?? null,
        lastUsedAt: recentByProjectCredential.get(`${projectId}\u0000${credential.id}`)?.created_at ?? null,
      };
    };

    const referencedCredentialIds = new Set<string>();
    const connections: any[] = [];

    for (const profile of profiles as any[]) {
      const secretRefs = profile.secret_refs ?? {};
      const referenced = Object.entries(secretRefs).map(([envName, credentialId]) => {
        referencedCredentialIds.add(String(credentialId));
        const credential = credentialById.get(String(credentialId));
        return credential ? {
          id: credential.id,
          displayName: credential.display_name,
          provider: credential.provider,
          kind: credential.kind,
          credentialType: credentialType(credential),
          allowedActions: credentialAllowedActions({ kind: credential.kind, secretName: credential.secret_name, metadata: credential.metadata ?? {} }),
          envName,
          scope: credential.scope,
          enabled: credential.enabled,
        } : {
          id: credentialId,
          displayName: String(credentialId),
          provider: null,
          kind: null,
          credentialType: 'missing',
          envName,
          scope: null,
          enabled: false,
        };
      });
      const referencedRows = referenced.map(r => credentialById.get(String(r.id))).filter(Boolean);
      const projectStates = (projects as any[]).map(project => {
        const profilePolicy = profilePolicyByProjectProfile.get(`${project.id}\u0000${profile.id}`);
        const credentialStates = referencedRows.map(credential => ({ credentialId: credential.id, ...effectiveCredentialStatus(project.id, credential) }));
        const broken = credentialStates.find(state => !['connected', 'inherited'].includes(state.status));
        let status: 'connected' | 'blocked' | 'off' | 'disabled' | 'needs_attention' = 'off';
        let reason = 'profile not granted';
        if (!profile.enabled) {
          status = 'disabled';
          reason = 'profile disabled';
        } else if (profilePolicy?.mode === 'deny') {
          status = 'blocked';
          reason = 'profile denied';
        } else if (profilePolicy?.mode === 'allow') {
          status = broken ? 'needs_attention' : 'connected';
          reason = broken ? `secret credential ${broken.credentialId} is ${broken.status}` : 'profile and secrets allowed';
        } else if (!profilePolicy && connectionDefaultApplies(`profile:${profile.id}`, project.id)) {
          status = broken ? 'needs_attention' : 'connected';
          reason = broken ? `default profile secret ${broken.credentialId} is ${broken.status}` : 'default profile connection policy';
        }
        return { projectId: project.id, projectName: project.name, status, reason, mode: profilePolicy?.mode ?? (status === 'connected' ? 'inherit' : null), credentialStates };
      });
      const warnings = projectStates
        .filter(state => state.status === 'needs_attention' || state.status === 'disabled')
        .slice(0, 8)
        .map(state => ({ projectId: state.projectId, projectName: state.projectName, message: state.reason }));
      const profileConnectionId = `profile:${profile.id}`;
      const defaultPolicy = defaultByConnectionId.get(profileConnectionId) ?? null;
      connections.push({
        id: profileConnectionId,
        source: 'profile',
        profileId: profile.id,
        displayName: profile.display_name,
        provider: profile.provider,
        connectionType: profile.profile_type,
        riskLevel: riskLevel(referencedRows),
        enabled: profile.enabled,
        defaultOn: defaultPolicy?.enabled === true,
        defaultScope: defaultPolicy?.default_mode ?? null,
        defaultReason: defaultPolicy?.reason ?? null,
        defaultPolicy,
        publicEnvNames: Object.keys(profile.env ?? {}),
        secretEnvNames: Object.keys(secretRefs),
        credentials: referenced,
        projects: projectStates,
        targets: referencedRows.flatMap(c => targetsByCredential.get(c.id) ?? []),
        warnings,
      });
    }

    for (const credential of credentials as any[]) {
      if (referencedCredentialIds.has(credential.id)) continue;
      const fileCredential = classifyRuntimeBoxFileCredential({
        credentialId: credential.id,
        provider: credential.provider,
        kind: credential.kind,
        secretName: credential.secret_name,
        defaultEnvName: credential.default_env_name,
        targetEnvName: null,
        metadata: credential.metadata ?? {},
      });
      const projectStates = (projects as any[]).map(project => {
        const state = effectiveCredentialStatus(project.id, credential);
        return { projectId: project.id, projectName: project.name, ...state };
      });
      const inheritedCount = projectStates.filter(state => state.status === 'inherited').length;
      const disabledPolicyCount = projectStates.filter(state => state.status === 'disabled' && state.mode).length;
      const syncWarnings = (targetsByCredential.get(credential.id) ?? []).filter(t => t.last_error || ['missing', 'error'].includes(String(t.last_status)));
      const warnings = [
        ...(disabledPolicyCount > 0 ? [{ message: `${disabledPolicyCount} projects have policy rows for a disabled credential` }] : []),
        ...syncWarnings.slice(0, 4).map(t => ({ projectId: t.project_id, message: `sync target ${t.target_type} is ${t.last_status || 'unknown'}` })),
      ];
      const credentialConnectionId = `credential:${credential.id}`;
      const defaultPolicy = defaultByConnectionId.get(credentialConnectionId) ?? null;
      const legacyDefaultOn = ['workspace', 'internal-default'].includes(credential.scope);
      const defaultOn = defaultPolicy ? defaultPolicy.enabled === true : legacyDefaultOn;
      connections.push({
        id: credentialConnectionId,
        source: 'credential',
        credentialId: credential.id,
        displayName: credential.display_name,
        provider: credential.provider,
        connectionType: credentialType(credential),
        riskLevel: riskLevel([credential]),
        enabled: credential.enabled,
        defaultOn,
        defaultScope: defaultPolicy?.default_mode ?? (legacyDefaultOn ? credential.scope : null),
        defaultReason: defaultPolicy?.reason ?? (legacyDefaultOn ? `${credential.scope} credential is inherited unless a project explicitly denies it` : null),
        defaultPolicy,
        publicEnvNames: [],
        secretEnvNames: [fileCredential?.envName ?? credential.default_env_name ?? credential.secret_name].filter(Boolean),
        credentials: [{
          id: credential.id,
          displayName: credential.display_name,
          provider: credential.provider,
          kind: credential.kind,
          credentialType: credentialType(credential),
          allowedActions: credentialAllowedActions({ kind: credential.kind, secretName: credential.secret_name, metadata: credential.metadata ?? {} }),
          envName: fileCredential?.envName ?? credential.default_env_name ?? credential.secret_name,
          scope: credential.scope,
          enabled: credential.enabled,
        }],
        projects: projectStates,
        targets: targetsByCredential.get(credential.id) ?? [],
        warnings,
      });
    }

    const withStats = connections.map(connection => {
      const connectedProjects = connection.projects.filter((project: any) => ['connected', 'inherited'].includes(project.status));
      const blockedProjects = connection.projects.filter((project: any) => project.status === 'blocked');
      const attentionProjects = connection.projects.filter((project: any) => ['needs_attention', 'disabled'].includes(project.status));
      const targetIssues = connection.targets.filter((target: any) => target.last_error || ['missing', 'error'].includes(String(target.last_status))).length;
      const lastUsedAt = connection.projects
        .map((project: any) => project.lastUsedAt)
        .filter(Boolean)
        .sort()
        .pop() ?? null;
      const status = !connection.enabled ? 'disabled'
        : attentionProjects.length > 0 || targetIssues > 0 || connection.warnings.length > 0 ? 'needs_attention'
          : connectedProjects.length > 0 ? 'connected'
            : 'off';
      return {
        ...connection,
        status,
        readiness: deriveConnectionReadiness({
          enabled: connection.enabled,
          existingStatus: status,
          connectedProjectCount: connectedProjects.length,
          blockedProjectCount: blockedProjects.length,
          attentionProjectCount: attentionProjects.length + targetIssues + connection.warnings.length,
          lastMaterializedAt: lastUsedAt,
          providerHealth: null,
        }),
        stats: {
          totalProjects: projects.length,
          connectedProjects: connectedProjects.length,
          blockedProjects: blockedProjects.length,
          attentionProjects: attentionProjects.length,
          targetIssues,
        },
        lastUsedAt,
      };
    });

    res.json({
      generatedAt: new Date().toISOString(),
      summary: {
        connections: withStats.length,
        credentials: (credentials as any[]).length,
        profiles: (profiles as any[]).length,
        projects: (projects as any[]).length,
        defaultConnections: withStats.filter(c => c.defaultOn).length,
        needsAttention: withStats.filter(c => c.status === 'needs_attention').length,
        disabled: withStats.filter(c => c.status === 'disabled').length,
      },
      connections: withStats.sort((a, b) => {
        const rank: Record<string, number> = { needs_attention: 0, connected: 1, disabled: 2, off: 3 };
        return (rank[a.status] ?? 9) - (rank[b.status] ?? 9) || a.displayName.localeCompare(b.displayName);
      }),
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message || 'Credential admin overview failed' });
  }
});

async function createApiKeyCredential(req: any, res: any, allowed: { userId: number }, scope: CredentialVaultScope, ownerUserId: number | null) {
  try {
    const rawSecretValue = bodyRawString(req, 'secretValue')!;
    const credential = await upsertApiKeyCredential({
      id: bodyString(req, 'id')!,
      provider: bodyString(req, 'provider')!,
      displayName: bodyString(req, 'displayName')!,
      secretName: bodyString(req, 'secretName')!,
      secretValue: rawSecretValue,
      defaultEnvName: bodyString(req, 'defaultEnvName', false),
      scope,
      ownerUserId,
      metadata: typeof req.body?.metadata === 'object' && req.body.metadata !== null ? req.body.metadata : {},
      actorUserId: allowed.userId,
    });
    res.json({
      credential: { ...credential, value: undefined },
      inputNormalizations: Array.isArray(credential.metadata?.input_normalizations) ? credential.metadata.input_normalizations : [],
    });
  } catch (err: any) {
    res.status(400).json({ error: err.message || 'API key credential upsert failed', code: err.code });
  }
}

router.post('/credentials/api-key', async (req, res) => {
  const allowed = assertAdmin(req);
  if (!allowed.ok) return res.status(allowed.status).json({ error: allowed.error });
  return createApiKeyCredential(req, res, allowed, (bodyString(req, 'scope', false) as CredentialVaultScope) ?? 'workspace', null);
});

router.post('/my/credentials/api-key', async (req, res) => {
  const allowed = assertAuthenticated(req);
  if (!allowed.ok) return res.status(allowed.status).json({ error: allowed.error });
  return createApiKeyCredential(req, res, allowed, 'personal', allowed.userId);
});

router.get('/projects/:projectId/credentials', async (req, res) => {
  const projectId = req.params.projectId as string;
  const allowed = await assertProjectConnectionManager(req, projectId);
  if (!allowed.ok) return res.status(allowed.status).json({ error: allowed.error });
  try {
    const credentials = await query<any>(
      `SELECT c.id, c.provider, c.display_name, c.kind, c.default_env_name, c.scope,
              c.metadata, c.enabled, c.rotated_at, c.updated_at, p.mode
         FROM workspace_credentials c
         JOIN project_credential_policies p ON p.credential_id = c.id AND p.project_id = $1
        WHERE c.scope = 'project'
          AND c.metadata->>'connection_type' = 'agent'
          AND c.metadata->>'agent_project_id' = $1
        ORDER BY c.provider, c.display_name, c.id`,
      [projectId],
    );
    res.json({
      projectId,
      credentials: credentials.map(credential => ({
        ...credential,
        allowedActions: credentialAllowedActions({
          kind: credential.kind,
          secretName: credential.default_env_name,
          metadata: credential.metadata,
        }),
      })),
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message || 'Agent Credential list failed' });
  }
});

router.post('/projects/:projectId/credentials/api-key', async (req, res) => {
  const projectId = req.params.projectId as string;
  const allowed = await assertProjectConnectionManager(req, projectId);
  if (!allowed.ok) return res.status(allowed.status).json({ error: allowed.error });
  try {
    const credentialId = bodyString(req, 'id')!;
    const targetEnvName = bodyString(req, 'defaultEnvName', false) ?? bodyString(req, 'secretName')!;
    const credential = await upsertApiKeyCredential({
      id: credentialId,
      provider: bodyString(req, 'provider')!,
      displayName: bodyString(req, 'displayName')!,
      secretName: bodyString(req, 'secretName')!,
      secretValue: bodyRawString(req, 'secretValue')!,
      defaultEnvName: targetEnvName,
      scope: 'project',
      ownerUserId: null,
      metadata: {
        ...(typeof req.body?.metadata === 'object' && req.body.metadata !== null ? req.body.metadata : {}),
        connection_type: 'agent',
        agent_project_id: projectId,
      },
      actorUserId: allowed.userId,
    });
    try {
      await setProjectCredentialPolicy({
        projectId,
        credentialId,
        mode: 'allow',
        targetEnvName,
        metadata: { agent_connection: true, created_via: 'secure_input' },
        actorUserId: allowed.userId,
      });
    } catch (bindingError) {
      await auditCredentialEvent({
        credentialId,
        projectId,
        eventType: 'agent_binding_failed',
        actorUserId: allowed.userId,
        provider: credential.provider,
        status: 'error',
        message: 'Credential saved but Agent binding failed; retry binding before Runtime use',
      });
      throw bindingError;
    }
    res.json({
      credential: { ...credential, value: undefined, secret_name: undefined },
      binding: { projectId, credentialId, mode: 'allow', targetEnvName },
      inputNormalizations: Array.isArray(credential.metadata?.input_normalizations) ? credential.metadata.input_normalizations : [],
    });
  } catch (err: any) {
    res.status(400).json({ error: err.message || 'Agent Credential create and bind failed', code: err.code });
  }
});

router.post('/projects/:projectId/credentials/:credentialId/inspect', async (req, res) => {
  const projectId = req.params.projectId as string;
  const allowed = await assertProjectConnectionManager(req, projectId);
  if (!allowed.ok) return res.status(allowed.status).json({ error: allowed.error });
  res.setHeader('Cache-Control', 'no-store, private');
  try {
    const owned = await query<any>(
      `SELECT id FROM workspace_credentials
        WHERE id = $1 AND scope = 'project'
          AND metadata->>'connection_type' = 'agent'
          AND metadata->>'agent_project_id' = $2`,
      [req.params.credentialId, projectId],
    );
    if (!owned[0]) return res.status(404).json({ error: 'Agent Credential not found' });
    res.json(await inspectCredential({ actorUserId: allowed.userId, credentialId: req.params.credentialId }));
  } catch (err: any) {
    res.status(400).json({ code: err.code || 'INSPECT_FAILED', error: 'Credential inspection failed' });
  }
});

router.post('/projects/:projectId/credentials/:credentialId/rotate', async (req, res) => {
  const projectId = req.params.projectId as string;
  const allowed = await assertProjectConnectionManager(req, projectId);
  if (!allowed.ok) return res.status(allowed.status).json({ error: allowed.error });
  res.setHeader('Cache-Control', 'no-store, private');
  try {
    const owned = await query<any>(
      `SELECT id FROM workspace_credentials
        WHERE id = $1 AND enabled = true AND scope = 'project'
          AND metadata->>'connection_type' = 'agent'
          AND metadata->>'agent_project_id' = $2`,
      [req.params.credentialId, projectId],
    );
    if (!owned[0]) return res.status(404).json({ error: 'Agent Credential not found' });
    const credential = await rotateExistingCredential({
      credentialId: req.params.credentialId,
      secretValue: bodyRawString(req, 'secretValue')!,
      actorUserId: allowed.userId,
    });
    res.json({ credential: { ...credential, value: undefined, secret_name: undefined } });
  } catch (err: any) {
    res.status(400).json({ code: err.code || 'ROTATE_FAILED', error: err.message || 'Agent Credential rotate failed' });
  }
});

router.post('/credentials/ssh-private-key', async (req, res) => {
  const allowed = assertAdmin(req);
  if (!allowed.ok) return res.status(allowed.status).json({ error: allowed.error });
  try {
    const result = await upsertSshPrivateKeyCredential({
      id: bodyString(req, 'id')!,
      displayName: bodyString(req, 'displayName')!,
      secretName: bodyString(req, 'secretName')!,
      privateKey: bodyRawString(req, 'privateKey')!,
      defaultEnvName: bodyString(req, 'defaultEnvName', false),
      pathEnvName: bodyString(req, 'pathEnvName', false),
      projectId: bodyString(req, 'projectId', false) ?? null,
      host: bodyString(req, 'host', false),
      username: bodyString(req, 'username', false),
      fingerprint: bodyString(req, 'fingerprint', false),
      filename: bodyString(req, 'filename', false),
      mode: bodyString(req, 'mode', false),
      actorUserId: allowed.userId,
    });
    res.json({
      credential: { ...result.credential, value: undefined },
      grantedProjectId: result.grantedProjectId,
      pathEnvName: result.pathEnvName,
    });
  } catch (err: any) {
    res.status(400).json({ error: err.message || 'SSH private key credential upsert failed' });
  }
});

async function createCredentialBundle(req: any, res: any, allowed: { userId: number }, scope: CredentialVaultScope, ownerUserId: number | null) {
  try {
    const projectId = bodyString(req, 'projectId', false) ?? null;
    const result = await upsertCredentialBundle({
      typeId: bodyString(req, 'typeId')!,
      instanceId: bodyString(req, 'instanceId')!,
      displayName: bodyString(req, 'displayName')!,
      values: typeof req.body?.values === 'object' && req.body.values !== null ? req.body.values : {},
      envNames: typeof req.body?.envNames === 'object' && req.body.envNames !== null ? req.body.envNames : {},
      projectId,
      scope,
      ownerUserId,
      actorUserId: allowed.userId,
    });
    res.json({
      profile: result.profile,
      credentials: result.credentials.map((credential) => ({ ...credential, value: undefined })),
      grantedProjectId: result.grantedProjectId,
    });
  } catch (err: any) {
    res.status(400).json({ error: err.message || 'Credential bundle upsert failed' });
  }
}

router.post('/bundles', async (req, res) => {
  const allowed = assertAdmin(req);
  if (!allowed.ok) return res.status(allowed.status).json({ error: allowed.error });
  return createCredentialBundle(req, res, allowed, (bodyString(req, 'scope', false) as CredentialVaultScope) ?? 'workspace', null);
});

router.post('/my/bundles', async (req, res) => {
  const allowed = assertAuthenticated(req);
  if (!allowed.ok) return res.status(allowed.status).json({ error: allowed.error });
  const projectId = bodyString(req, 'projectId', false);
  if (projectId) {
    const projectAllowed = await assertProjectViewer(req, projectId);
    if (!projectAllowed.ok) return res.status(projectAllowed.status).json({ error: projectAllowed.error });
  }
  return createCredentialBundle(req, res, allowed, 'personal', allowed.userId);
});

router.put('/projects/:projectId/policies/:credentialId', async (req, res) => {
  const allowed = assertAdmin(req);
  if (!allowed.ok) return res.status(allowed.status).json({ error: allowed.error });
  try {
    await setProjectCredentialPolicy({
      projectId: req.params.projectId as string,
      credentialId: req.params.credentialId as string,
      mode: (bodyString(req, 'mode', false) as any) ?? 'allow',
      targetEnvName: bodyString(req, 'targetEnvName', false),
      metadata: typeof req.body?.metadata === 'object' && req.body.metadata !== null ? req.body.metadata : {},
      actorUserId: allowed.userId,
    });
    res.json({ ok: true });
  } catch (err: any) {
    res.status(400).json({ error: err.message || 'Project credential policy update failed' });
  }
});

router.put('/my/projects/:projectId/policies/:credentialId', async (req, res) => {
  const allowed = assertAuthenticated(req);
  if (!allowed.ok) return res.status(allowed.status).json({ error: allowed.error });
  const projectId = req.params.projectId as string;
  const credentialId = req.params.credentialId as string;
  const projectAllowed = await assertProjectViewer(req, projectId);
  if (!projectAllowed.ok) return res.status(projectAllowed.status).json({ error: projectAllowed.error });
  try {
    const rows = await query<any>(
      `SELECT id, default_env_name, secret_name
         FROM workspace_credentials
        WHERE id = $1 AND scope = 'personal' AND owner_user_id = $2 AND enabled = true`,
      [credentialId, allowed.userId],
    );
    if (rows.length === 0) return res.status(404).json({ error: 'Personal credential not found' });
    await setProjectCredentialPolicy({
      projectId,
      credentialId,
      mode: (bodyString(req, 'mode', false) as any) ?? 'allow',
      targetEnvName: bodyString(req, 'targetEnvName', false) ?? rows[0].default_env_name ?? rows[0].secret_name,
      metadata: { ...(typeof req.body?.metadata === 'object' && req.body.metadata !== null ? req.body.metadata : {}), source: 'personal_credential_owner' },
      actorUserId: allowed.userId,
    });
    res.json({ ok: true });
  } catch (err: any) {
    res.status(400).json({ error: err.message || 'Personal project credential policy update failed' });
  }
});

router.put('/connection-defaults/:connectionId', async (req, res) => {
  const allowed = assertAdmin(req);
  if (!allowed.ok) return res.status(allowed.status).json({ error: allowed.error });
  try {
    const connectionId = req.params.connectionId as string;
    if (!/^(profile|credential):[a-z0-9][a-z0-9_-]{1,79}$/.test(connectionId)) {
      throw new Error('connectionId must start with profile: or credential:');
    }
    const enabled = req.body?.enabled !== false;
    const defaultMode = bodyString(req, 'defaultMode', false) ?? 'all_projects';
    if (!['all_projects', 'new_projects', 'project_template'].includes(defaultMode)) {
      throw new Error('defaultMode must be all_projects, new_projects, or project_template');
    }
    const reason = bodyString(req, 'reason', false) ?? null;
    const projectTemplate = bodyString(req, 'projectTemplate', false) ?? null;
    if (defaultMode === 'project_template' && !projectTemplate) throw new Error('projectTemplate required for project_template defaults');
    const riskAckRequired = req.body?.riskAckRequired === true;
    await query(
      `INSERT INTO workspace_connection_defaults
         (connection_id, default_mode, project_template, enabled, risk_ack_required, reason, created_by, updated_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $7)
       ON CONFLICT (connection_id) DO UPDATE SET
         default_mode = EXCLUDED.default_mode,
         project_template = EXCLUDED.project_template,
         enabled = EXCLUDED.enabled,
         risk_ack_required = EXCLUDED.risk_ack_required,
         reason = EXCLUDED.reason,
         updated_at = now(),
         updated_by = EXCLUDED.updated_by`,
      [connectionId, defaultMode, projectTemplate, enabled, riskAckRequired, reason, allowed.userId],
    );
    await auditCredentialEvent({
      credentialId: connectionId.startsWith('credential:') ? connectionId.slice('credential:'.length) : null,
      eventType: enabled ? 'connection_default_enable' : 'connection_default_disable',
      actorUserId: allowed.userId,
      targetType: 'workspace_connection_default',
      targetRef: { connection_id: connectionId, default_mode: defaultMode, project_template: projectTemplate, risk_ack_required: riskAckRequired },
      status: 'ok',
      message: reason ?? `Connection default ${enabled ? 'enabled' : 'disabled'}`,
    });
    res.json({ ok: true, connectionId, enabled, defaultMode, projectTemplate });
  } catch (err: any) {
    res.status(400).json({ error: err.message || 'Connection default update failed' });
  }
});

router.put('/connections/:connectionId/projects/:projectId', async (req, res) => {
  const connectionId = req.params.connectionId as string;
  const projectId = req.params.projectId as string;
  const allowed = await assertProjectConnectionManager(req, projectId);
  if (!allowed.ok) return res.status(allowed.status).json({ error: allowed.error });
  try {
    const mode = (bodyString(req, 'mode', false) as 'allow' | 'deny' | undefined) ?? 'allow';
    if (!['allow', 'deny'].includes(mode)) throw new Error('mode must be allow or deny');

    if (connectionId.startsWith('credential:')) {
      const credentialId = connectionId.slice('credential:'.length);
      const rows = await query<any>(`SELECT default_env_name, secret_name FROM workspace_credentials WHERE id = $1`, [credentialId]);
      if (rows.length === 0) throw new Error(`credential not found: ${credentialId}`);
      await setProjectCredentialPolicy({
        projectId,
        credentialId,
        mode,
        targetEnvName: rows[0].default_env_name ?? rows[0].secret_name,
        actorUserId: allowed.userId,
      });
      return res.json({ ok: true, connectionId, projectId, mode });
    }

    if (connectionId.startsWith('profile:')) {
      const profileId = connectionId.slice('profile:'.length);
      const rows = await query<any>(`SELECT secret_refs FROM credential_profiles WHERE id = $1`, [profileId]);
      if (rows.length === 0) throw new Error(`profile not found: ${profileId}`);
      await setProjectCredentialProfilePolicy({
        projectId,
        profileId,
        mode,
        actorUserId: allowed.userId,
      });
      if (mode === 'allow') {
        const secretRefs = rows[0].secret_refs ?? {};
        for (const [envName, credentialId] of Object.entries(secretRefs)) {
          await setProjectCredentialPolicy({
            projectId,
            credentialId: String(credentialId),
            mode: 'allow',
            targetEnvName: envName,
            metadata: { source: 'connection_policy', profile_id: profileId },
            actorUserId: allowed.userId,
          });
        }
      }
      return res.json({ ok: true, connectionId, projectId, mode });
    }

    throw new Error('connectionId must start with profile: or credential:');
  } catch (err: any) {
    res.status(400).json({ error: err.message || 'Connection project policy update failed' });
  }
});

router.get('/projects/:projectId/preview', async (req, res) => {
  const projectId = req.params.projectId as string;
  const allowed = await assertProjectViewer(req, projectId);
  if (!allowed.ok) return res.status(allowed.status).json({ error: allowed.error });

  try {
    const [profiles, credentials, targets, recentEvents] = await Promise.all([
      query(
        `SELECT cp.id,
                cp.profile_type,
                cp.provider,
                cp.display_name,
                cp.env,
                cp.secret_refs,
                cp.enabled,
                pp.mode,
                pp.updated_at AS policy_updated_at
           FROM project_credential_profile_policies pp
           JOIN credential_profiles cp ON cp.id = pp.profile_id
          WHERE pp.project_id = $1
          ORDER BY cp.provider, cp.id`,
        [projectId],
      ),
      query(
        `SELECT c.id,
                c.kind,
                c.provider,
                c.display_name,
                c.secret_name,
                c.default_env_name,
                c.scope,
                c.owner_user_id,
                c.metadata,
                c.enabled,
                COALESCE(p.mode, 'inherit') AS mode,
                p.target_env_name,
                p.updated_at AS policy_updated_at
           FROM workspace_credentials c
           LEFT JOIN project_credential_policies p
             ON p.credential_id = c.id AND p.project_id = $1
          WHERE c.enabled = true
            AND (
              (c.scope = 'personal' AND c.owner_user_id = $2 AND p.mode IN ('allow', 'override', 'inherit'))
              OR (
                c.scope <> 'personal'
                AND (
                  p.mode IN ('allow', 'override', 'inherit')
                  OR (p.mode IS NULL AND c.scope IN ('workspace', 'internal-default'))
                )
              )
            )
          ORDER BY c.provider, c.id`,
        [projectId, allowed.userId],
      ),
      query(
        `SELECT t.id,
                t.credential_id,
                t.target_type,
                t.target_ref,
                t.desired_state,
                t.enabled,
                t.last_status,
                t.last_checked_at,
                t.last_synced_at,
                t.last_error,
                c.display_name AS credential_display_name,
                c.provider
           FROM credential_target_syncs t
           JOIN workspace_credentials c ON c.id = t.credential_id
          WHERE t.project_id = $1
          ORDER BY t.created_at DESC`,
        [projectId],
      ),
      query(
        `SELECT DISTINCT ON (credential_id) credential_id,
                event_type,
                actor_user_id,
                status,
                target_ref,
                created_at
           FROM credential_audit_events
          WHERE project_id = $1
            AND target_type = 'runtime_box_env'
          ORDER BY credential_id, created_at DESC`,
        [projectId],
      ),
    ]);

    const recentByCredential = new Map<string, any>();
    for (const event of recentEvents as any[]) {
      if (event.credential_id) recentByCredential.set(event.credential_id, event);
    }

    const credentialsJson = (credentials as any[]).map((c) => {
      const recent = recentByCredential.get(c.id) ?? null;
      const fileCredential = classifyRuntimeBoxFileCredential({
        credentialId: c.id,
        provider: c.provider,
        kind: c.kind,
        secretName: c.secret_name,
        defaultEnvName: c.default_env_name,
        targetEnvName: c.target_env_name,
        metadata: c.metadata ?? {},
      });
      return {
        id: c.id,
        kind: c.kind,
        provider: c.provider,
        display_name: c.display_name,
        default_env_name: c.default_env_name,
        target_env_name: c.target_env_name,
        env_name: fileCredential?.envName ?? c.target_env_name ?? c.default_env_name,
        credential_type: fileCredential?.credentialType ?? c.metadata?.credential_type ?? c.kind,
        materialized_file_env_name: fileCredential?.envName ?? null,
        scope: c.scope,
        owner_user_id: c.owner_user_id ?? null,
        enabled: c.enabled,
        mode: c.mode,
        active: c.enabled === true && ['allow', 'override', 'inherit'].includes(String(c.mode)),
        last_runtime_event: recent ? {
          event_type: recent.event_type,
          actor_user_id: recent.actor_user_id,
          status: recent.status,
          env_name: recent.target_ref?.env_name ?? null,
          created_at: recent.created_at,
        } : null,
      };
    });

    const credentialById = new Map(credentialsJson.map((c: any) => [c.id, c]));
    const profilesJson = (profiles as any[]).map((p) => {
      const secretRefs = p.secret_refs ?? {};
      const secretEnvNames = Object.keys(secretRefs);
      const referencedCredentials = Object.entries(secretRefs).map(([envName, credentialId]) => {
        const credential = credentialById.get(String(credentialId));
        return {
          env_name: envName,
          credential_id: credentialId,
          display_name: credential?.display_name ?? String(credentialId),
          provider: credential?.provider ?? null,
          mode: credential?.mode ?? null,
          available: credential?.active === true,
        };
      });
      const active = p.enabled === true && p.mode === 'allow' && referencedCredentials.every((c) => c.available);
      return {
        id: p.id,
        profile_type: p.profile_type,
        provider: p.provider,
        display_name: p.display_name,
        mode: p.mode,
        enabled: p.enabled,
        active,
        public_env_names: Object.keys(p.env ?? {}),
        secret_env_names: secretEnvNames,
        referenced_credentials: referencedCredentials,
      };
    });

    const profileSecretCredentialIds = new Set<string>();
    for (const profile of profilesJson) {
      for (const ref of profile.referenced_credentials) profileSecretCredentialIds.add(String(ref.credential_id));
    }

    const looseAllowedCredentials = credentialsJson.filter((c: any) => c.active && !profileSecretCredentialIds.has(c.id));

    res.json({
      project_id: projectId,
      profiles: profilesJson,
      credentials: credentialsJson,
      loose_allowed_credentials: looseAllowedCredentials,
      targets,
      warnings: looseAllowedCredentials.map((c: any) => ({
        type: 'loose_allowed_credential',
        credential_id: c.id,
        env_name: c.env_name,
        message: c.materialized_file_env_name
          ? 'This file credential is allowed directly for the project and will be materialized as a temp file during Runtime Box commands.'
          : 'This credential is allowed for the project but is not referenced by an active profile.',
      })),
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message || 'Project credential preview failed' });
  }
});

router.get('/targets', async (req, res) => {
  const allowed = assertOperator(req);
  if (!allowed.ok) return res.status(allowed.status).json({ error: allowed.error });
  try {
    const projectId = typeof req.query.projectId === 'string' ? req.query.projectId : undefined;
    const rows = await query(
      `SELECT t.*, c.provider, c.kind, c.display_name, c.default_env_name
         FROM credential_target_syncs t
         JOIN workspace_credentials c ON c.id = t.credential_id
        WHERE ($1::text IS NULL OR t.project_id = $1)
        ORDER BY t.created_at DESC`,
      [projectId ?? null],
    );
    res.json({ targets: rows });
  } catch (err: any) {
    res.status(500).json({ error: err.message || 'Credential target list failed' });
  }
});

router.post('/targets/github-actions-secret', async (req, res) => {
  const allowed = assertAdmin(req);
  if (!allowed.ok) return res.status(allowed.status).json({ error: allowed.error });
  try {
    const target = await upsertGitHubActionsSecretTarget({
      credentialId: bodyString(req, 'credentialId')!,
      projectId: bodyString(req, 'projectId', false) ?? null,
      repo: bodyString(req, 'repo')!,
      secretName: bodyString(req, 'secretName')!,
      actorUserId: allowed.userId,
    });
    res.json({ target });
  } catch (err: any) {
    res.status(400).json({ error: err.message || 'GitHub Actions target create failed' });
  }
});

router.post('/targets/:targetId/status', async (req, res) => {
  const allowed = assertOperator(req);
  if (!allowed.ok) return res.status(allowed.status).json({ error: allowed.error });
  try {
    const status = await checkGitHubActionsSecretStatus({
      targetId: parseTargetId(req),
      actorUserId: allowed.userId,
    });
    res.json(status);
  } catch (err: any) {
    res.status(400).json({ error: err.message || 'GitHub Actions target status failed' });
  }
});

router.post('/targets/:targetId/sync', async (req, res) => {
  const allowed = assertAdmin(req);
  if (!allowed.ok) return res.status(allowed.status).json({ error: allowed.error });
  try {
    const result = await syncGitHubActionsSecret({
      targetId: parseTargetId(req),
      actorUserId: allowed.userId,
    });
    res.status(result.ok ? 200 : 502).json(result);
  } catch (err: any) {
    res.status(400).json({ error: err.message || 'GitHub Actions target sync failed' });
  }
});

router.patch('/credentials/:credentialId/connection', async (req, res) => {
  const allowed = assertAdmin(req);
  if (!allowed.ok) return res.status(allowed.status).json({ error: allowed.error });
  res.setHeader('Cache-Control', 'no-store, private');
  try {
    const credentialId = req.params.credentialId;
    const displayName = bodyString(req, 'displayName', false)?.trim();
    const lifecycle = bodyString(req, 'lifecycle', false) as 'disconnect' | 'restore' | undefined;
    if (!displayName && !lifecycle) return res.status(400).json({ code: 'NO_CHANGE', error: 'Connection name or lifecycle action required' });
    if (displayName && (displayName.length < 2 || displayName.length > 120)) return res.status(400).json({ code: 'INVALID_DISPLAY_NAME', error: 'Connection name must be 2-120 characters' });
    if (lifecycle && !['disconnect', 'restore'].includes(lifecycle)) return res.status(400).json({ code: 'INVALID_LIFECYCLE', error: 'lifecycle must be disconnect or restore' });

    const rows = await query<any>(
      `SELECT id, display_name, enabled, scope FROM workspace_credentials
        WHERE id = $1 AND scope IN ('workspace', 'internal-default')`,
      [credentialId],
    );
    const existing = rows[0];
    if (!existing) return res.status(404).json({ error: 'Organization Connection not found' });
    const nextEnabled = lifecycle === 'disconnect' ? false : lifecycle === 'restore' ? true : existing.enabled;
    const nextDisplayName = displayName || existing.display_name;
    const changed = await query<any>(
      `UPDATE workspace_credentials
          SET display_name = $2, enabled = $3, updated_at = now(), updated_by = $4,
              metadata = CASE
                WHEN $3 = false THEN COALESCE(metadata, '{}'::jsonb) || jsonb_build_object('safely_disconnected_at', now()::text, 'safely_disconnected_by', $4)
                ELSE COALESCE(metadata, '{}'::jsonb) - 'safely_disconnected_at' - 'safely_disconnected_by'
              END
        WHERE id = $1
        RETURNING id, display_name, enabled, updated_at`,
      [credentialId, nextDisplayName, nextEnabled, allowed.userId],
    );
    await query(
      `INSERT INTO credential_audit_events
        (credential_id, event_type, actor_user_id, target_type, status, message, metadata)
       VALUES ($1, $2, $3, 'workspace_connection', 'ok', $4, $5::jsonb)`,
      [credentialId, lifecycle === 'disconnect' ? 'connection_safely_disconnected' : lifecycle === 'restore' ? 'connection_restored' : 'connection_renamed', allowed.userId,
       lifecycle === 'disconnect' ? 'Organization Connection disabled; encrypted value and Agent policies preserved' : lifecycle === 'restore' ? 'Organization Connection restored with existing Agent policies' : 'Organization Connection display name updated',
       JSON.stringify({ previousDisplayName: existing.display_name, displayName: nextDisplayName, enabled: nextEnabled, policiesPreserved: true, secretPreserved: true })],
    );
    res.json({ ok: true, connection: changed[0], policiesPreserved: true, secretPreserved: true });
  } catch (err: any) {
    res.status(400).json({ code: err.code || 'CONNECTION_UPDATE_FAILED', error: err.message || 'Connection update failed' });
  }
});

router.post('/credentials/:credentialId/rotate/preview', async (req, res) => {
  const allowed = assertAdmin(req);
  if (!allowed.ok) return res.status(allowed.status).json({ error: allowed.error });
  res.setHeader('Cache-Control', 'no-store, private');
  try {
    const rows = await query(
      `SELECT id, provider, display_name, secret_name, default_env_name, kind, scope, metadata
         FROM workspace_credentials WHERE id = $1 AND enabled = true AND scope <> 'personal'`,
      [req.params.credentialId],
    );
    const row = (rows as any[])[0];
    if (!row) return res.status(404).json({ error: 'Credential not found' });
    const allowedActions = credentialAllowedActions({ kind: row.kind, secretName: row.secret_name, metadata: row.metadata ?? {} });
    if (allowedActions.replacementAction !== 'rotate') return res.status(400).json({ code: 'REAUTH_REQUIRED', error: 'This Credential must be reconnected instead of rotated' });
    const target: CredentialRotateTarget = {
      credentialId: row.id, provider: row.provider, displayName: row.display_name, secretName: row.secret_name,
      defaultEnvName: row.default_env_name ?? row.secret_name, kind: row.kind, scope: row.scope, metadata: row.metadata ?? {},
    };
    const preview = previewCredentialRotate({ actorUserId: allowed.userId, target, candidate: bodyRawString(req, 'candidate')! });
    await query(
      `INSERT INTO credential_rotate_intents (id, actor_user_id, credential_id, proposal_hash, secret_commitment, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [preview.intentId, allowed.userId, row.id, preview.proposalHash, preview.secretCommitment, preview.expiresAt],
    );
    const { secretCommitment: _secretCommitment, ...safePreview } = preview;
    res.json(safePreview);
  } catch (err: any) {
    res.status(400).json({ code: err.code || 'ROTATE_PREVIEW_FAILED', error: err.message || 'Credential rotate preview failed' });
  }
});

router.post('/credentials/:credentialId/rotate/apply', async (req, res) => {
  const allowed = assertAdmin(req);
  if (!allowed.ok) return res.status(allowed.status).json({ error: allowed.error });
  res.setHeader('Cache-Control', 'no-store, private');
  try {
    if (req.body?.confirmed !== true) return res.status(400).json({ code: 'CONFIRMATION_REQUIRED', error: 'Explicit confirmation required' });
    const intentRows = await query(
      `SELECT i.*, c.provider, c.display_name, c.secret_name, c.default_env_name, c.kind, c.scope, c.metadata
         FROM credential_rotate_intents i JOIN workspace_credentials c ON c.id = i.credential_id
        WHERE i.id = $1 AND i.actor_user_id = $2 AND i.credential_id = $3 AND i.proposal_hash = $4
          AND i.status = 'previewed' AND i.consumed_at IS NULL AND i.expires_at > now()`,
      [bodyString(req, 'intentId')!, allowed.userId, req.params.credentialId, bodyString(req, 'proposalHash')!],
    );
    const intent = (intentRows as any[])[0];
    if (!intent) return res.status(409).json({ code: 'INTENT_EXPIRED_OR_CONSUMED', error: 'Valid unused rotate preview required' });
    const target: CredentialRotateTarget = {
      credentialId: intent.credential_id, provider: intent.provider, displayName: intent.display_name, secretName: intent.secret_name,
      defaultEnvName: intent.default_env_name ?? intent.secret_name, kind: intent.kind, scope: intent.scope, metadata: intent.metadata ?? {},
    };
    const verified = verifyCredentialRotate({
      actorUserId: allowed.userId, credentialId: intent.credential_id, candidate: bodyRawString(req, 'candidate')!, target,
      secretCommitment: intent.secret_commitment, proposalHash: intent.proposal_hash, expiresAt: new Date(intent.expires_at).toISOString(), confirmed: true,
    });
    const claimed = await query(
      `UPDATE credential_rotate_intents SET status = 'applying', consumed_at = now()
        WHERE id = $1 AND status = 'previewed' AND consumed_at IS NULL AND expires_at > now() RETURNING id`,
      [intent.id],
    );
    if (!(claimed as any[])[0]) return res.status(409).json({ code: 'INTENT_EXPIRED_OR_CONSUMED', error: 'Rotate preview already consumed' });
    try {
      await rotateExistingCredential({ credentialId: intent.credential_id, secretValue: verified.normalizedValue, actorUserId: allowed.userId });
      await query(`UPDATE credential_rotate_intents SET status = 'applied' WHERE id = $1 AND status = 'applying'`, [intent.id]);
    } catch (rotateError) {
      await query(`UPDATE credential_rotate_intents SET status = 'failed' WHERE id = $1 AND status = 'applying'`, [intent.id]);
      throw rotateError;
    }
    res.json({ ok: true, credentialId: intent.credential_id, next: 'refresh' });
  } catch (err: any) {
    res.status(400).json({ code: err.code || 'ROTATE_APPLY_FAILED', error: err.message || 'Credential rotate failed' });
  }
});

router.post('/credentials/:credentialId/reveal-challenges', async (req, res) => {
  const allowed = assertAdmin(req);
  if (!allowed.ok) return res.status(allowed.status).json({ error: allowed.error });
  res.setHeader('Cache-Control', 'no-store');
  try {
    const result = await createRevealChallenge({
      actorUserId: allowed.userId,
      requesterHash: requesterHash(req),
      credentialId: req.params.credentialId,
      fieldId: bodyString(req, 'fieldId')!,
      purpose: bodyString(req, 'purpose')!,
      mode: bodyString(req, 'mode') as 'reveal' | 'compare' | 'inspect',
    });
    res.json(result);
  } catch (err: any) {
    res.status(err.code === 'STEP_UP_RATE_LIMITED' ? 429 : 400).json({ code: err.code || 'REVEAL_CHALLENGE_FAILED', error: 'Credential verification request failed' });
  }
});

router.post('/credentials/:credentialId/inspect', async (req, res) => {
  const allowed = assertAdmin(req);
  if (!allowed.ok) return res.status(allowed.status).json({ error: allowed.error });
  res.setHeader('Cache-Control', 'no-store, private');
  try {
    const result = await inspectCredential({
      actorUserId: allowed.userId,
      credentialId: req.params.credentialId,
    });
    res.json(result);
  } catch (err: any) {
    res.status(400).json({ code: err.code || 'INSPECT_FAILED', error: 'Credential inspection failed' });
  }
});

router.post('/credentials/:credentialId/reveal', async (req, res) => {
  const allowed = assertAdmin(req);
  if (!allowed.ok) return res.status(allowed.status).json({ error: allowed.error });
  res.setHeader('Cache-Control', 'no-store, private');
  res.setHeader('Pragma', 'no-cache');
  try {
    const result = await revealCredentialFieldAsAdmin({
      actorUserId: allowed.userId,
      credentialId: req.params.credentialId,
      fieldId: bodyString(req, 'fieldId')!,
      purpose: bodyString(req, 'purpose')!,
    });
    res.json(result);
  } catch (err: any) {
    res.status(400).json({ code: err.code || 'REVEAL_FAILED', error: 'REVEAL_FAILED' });
  }
});

router.post('/credentials/:credentialId/compare', async (req, res) => {
  const allowed = assertAdmin(req);
  if (!allowed.ok) return res.status(allowed.status).json({ error: allowed.error });
  const { username } = reqUser(req);
  res.setHeader('Cache-Control', 'no-store, private');
  res.setHeader('Pragma', 'no-cache');
  try {
    const result = await compareCredentialField({
      actorUserId: allowed.userId,
      username: username || '',
      challengeId: bodyString(req, 'challengeId')!,
      credentialId: req.params.credentialId,
      fieldId: bodyString(req, 'fieldId')!,
      purpose: bodyString(req, 'purpose')!,
      mode: 'compare',
      password: bodyRawString(req, 'password')!,
      candidate: bodyRawString(req, 'candidate')!,
    });
    res.json(result);
  } catch (err: any) {
    res.status(400).json({ code: err.code || 'STEP_UP_FAILED', error: 'STEP_UP_FAILED' });
  }
});

router.post('/host-import/preview', async (req, res) => {
  const allowed = assertAdmin(req);
  if (!allowed.ok) return res.status(allowed.status).json({ error: allowed.error });
  try {
    const preview = await previewHostSecretImport({
      sourcePath: bodyString(req, 'sourcePath')!,
      sourceKey: bodyString(req, 'sourceKey')!,
      projectId: bodyString(req, 'projectId')!,
      credentialId: bodyString(req, 'credentialId')!,
      provider: bodyString(req, 'provider')!,
      displayName: bodyString(req, 'displayName')!,
      secretName: bodyString(req, 'secretName')!,
      envName: bodyString(req, 'envName', false),
    }, allowed.userId);
    res.json(preview);
  } catch (err: any) {
    res.status(400).json({ error: err.message || 'Host secret import preview failed' });
  }
});

router.post('/host-import/apply', async (req, res) => {
  const allowed = assertAdmin(req);
  if (!allowed.ok) return res.status(allowed.status).json({ error: allowed.error });
  if (req.body?.confirmed !== true) return res.status(400).json({ error: 'Explicit confirmation required' });
  try {
    const result = await applyHostSecretImport({
      intentId: bodyString(req, 'intentId')!,
      proposalHash: bodyString(req, 'proposalHash')!,
      actorUserId: allowed.userId,
    });
    res.json(result);
  } catch (err: any) {
    res.status(400).json({ error: err.message || 'Host secret import failed' });
  }
});

export default router;

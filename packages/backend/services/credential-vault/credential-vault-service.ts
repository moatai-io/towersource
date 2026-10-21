import { createHash, randomUUID } from 'crypto';
import { execute, query, queryOne, transaction, withClient } from '../../db/pg-repo.js';
import { getSecretForProjectBinding, getSecretForLegacyGwsBinding, setSecret } from '../secret/secret-store.js';
import { assertCredentialManagementAccess } from './credential-management-access.js';
import { inferSecretPolicy, normalizeSecretInput } from './credential-input-normalizer.js';

const VALID_SECRET_NAME_RE = /^[A-Z][A-Z0-9_]{0,63}$/;
const VALID_CREDENTIAL_ID_RE = /^[a-z0-9][a-z0-9_-]{1,79}$/;

/** The VM Vault has exactly two product scopes: team-shared and Agent-dedicated. */
export type CredentialVaultScope = 'workspace' | 'project';
type AuditStatus = 'ok' | 'error' | 'denied';

export interface WorkspaceCredentialRow {
  id: string;
  kind: string;
  provider: string;
  display_name: string;
  secret_name: string;
  default_env_name: string | null;
  scope: CredentialVaultScope;
  project_id: string | null;
  metadata: Record<string, unknown>;
  enabled: boolean;
  created_at: Date;
  created_by: number | null;
  updated_at: Date;
  updated_by: number | null;
  rotated_at: Date | null;
}

export interface RuntimeBoxCredentialSkippedItem {
  credentialId: string;
  envName?: string;
  reason: string;
}
export interface RuntimeBoxApiKeyEnvResolution {
  env: Record<string, string>;
  injected: Array<{ credentialId: string; envName: string }>;
  skippedExisting: Array<{ credentialId: string; envName: string }>;
  skipped: RuntimeBoxCredentialSkippedItem[];
}
export interface RuntimeBoxCredentialFileSecret {
  credentialId: string;
  envName: string;
  fileName: string;
  mode: string;
  credentialType: string;
  value: string;
}
export interface RuntimeBoxCredentialFileResolution {
  materialize: RuntimeBoxCredentialFileSecret[];
  skipped: RuntimeBoxCredentialSkippedItem[];
}
export interface ProjectApiKeySecretResolution { credentialId: string; envName: string; value: string }
export interface ProjectCredentialSecretResolution { credentialId: string; provider: string; kind: string; secretName: string; value: string }

function assertCredentialId(id: string): void {
  if (!VALID_CREDENTIAL_ID_RE.test(id)) throw new Error(`invalid credential id: ${id}`);
}
function assertSecretName(name: string): void {
  if (!VALID_SECRET_NAME_RE.test(name)) throw new Error(`invalid secret/env name: ${name}`);
}
function stringMetadataValue(metadata: Record<string, unknown>, key: string): string | undefined {
  const value = metadata[key];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}
function objectMetadataValue(metadata: Record<string, unknown>, key: string): Record<string, unknown> | undefined {
  const value = metadata[key];
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
function safeCredentialFileName(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'credential';
}

/** SQL predicate shared by every runtime resolver. No policy/default/profile table participates. */
export function allowedProjectCredentialWhere(alias = 'c', projectParam = '$1'): string {
  return `((${alias}.scope = 'workspace' OR (${alias}.scope = 'project' AND ${alias}.project_id = ${projectParam}))
    AND NOT (COALESCE(${alias}.metadata, '{}'::jsonb) ? 'legacy_personal_owner_user_id'))`;
}

function isLegacyPersonalCredential(row: { metadata: Record<string, unknown> }): boolean {
  return Object.prototype.hasOwnProperty.call(row.metadata ?? {}, 'legacy_personal_owner_user_id');
}

function assertExplicitlyRegisteredCredential(row: { metadata: Record<string, unknown> }): void {
  if (isLegacyPersonalCredential(row)) {
    throw new Error('Legacy personal Credential requires explicit re-registration before Agent sharing or use');
  }
}

function newCredentialStorageName(scope: CredentialVaultScope, projectId: string | null | undefined, id: string): string {
  return `VAULT_${createHash('sha256').update(JSON.stringify([scope, projectId ?? null, id, randomUUID()])).digest('hex').slice(0, 56).toUpperCase()}`;
}

export async function auditCredentialEvent(opts: {
  credentialId?: string | null;
  projectId?: string | null;
  eventType: string;
  actorUserId?: number | null;
  provider?: string | null;
  targetType?: string | null;
  targetRef?: Record<string, unknown>;
  status?: AuditStatus;
  errorCode?: string | null;
  message?: string | null;
}): Promise<void> {
  await execute(
    `INSERT INTO credential_audit_events
       (credential_id, project_id, event_type, actor_user_id, provider, target_type, target_ref, status, error_code, message)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10)`,
    [opts.credentialId ?? null, opts.projectId ?? null, opts.eventType, opts.actorUserId ?? null,
      opts.provider ?? null, opts.targetType ?? null, JSON.stringify(opts.targetRef ?? {}),
      opts.status ?? 'ok', opts.errorCode ?? null, opts.message ?? null],
  );
}

export function mergeRuntimeBoxApiKeyEnv(opts: {
  existingEnv?: Record<string, string>;
  vaultEnv: Array<{ credentialId: string; envName: string; value: string }>;
}): RuntimeBoxApiKeyEnvResolution {
  const env = { ...(opts.existingEnv ?? {}) };
  const injected: Array<{ credentialId: string; envName: string }> = [];
  const skippedExisting: Array<{ credentialId: string; envName: string }> = [];
  for (const item of opts.vaultEnv) {
    assertSecretName(item.envName);
    if (Object.prototype.hasOwnProperty.call(env, item.envName)) {
      skippedExisting.push({ credentialId: item.credentialId, envName: item.envName });
      continue;
    }
    env[item.envName] = item.value;
    injected.push({ credentialId: item.credentialId, envName: item.envName });
  }
  return { env, injected, skippedExisting, skipped: [] };
}

export function credentialFileEnvNameForDefaultEnv(defaultEnvName: string): string {
  const withoutPrivateKey = defaultEnvName.replace(/_PRIVATE_KEY$/, '_KEY');
  const result = withoutPrivateKey.endsWith('_FILE') ? withoutPrivateKey : `${withoutPrivateKey}_FILE`;
  assertSecretName(result);
  return result;
}

export function classifyRuntimeBoxFileCredential(row: {
  credentialId: string;
  provider: string;
  kind: string;
  secretName: string;
  defaultEnvName: string | null;
  targetEnvName: string | null;
  metadata: Record<string, unknown>;
}): { credentialType: string; envName: string; fileName: string; mode: string; reason?: string } | null {
  const metadata = row.metadata ?? {};
  const materialization = objectMetadataValue(metadata, 'materialization');
  const materializationType = stringMetadataValue(materialization ?? {}, 'type') ?? stringMetadataValue(metadata, 'materialization_type');
  const explicitType = stringMetadataValue(metadata, 'credential_type');
  const encodedFallback = /(_B64|_BASE64)$/i.test(row.credentialId) || /(_B64|_BASE64)$/i.test(row.secretName) || /(_B64|_BASE64)$/i.test(row.defaultEnvName ?? '');
  const ssh = !encodedFallback && (row.provider === 'ssh' || /SSH.*PRIVATE.*KEY|PRIVATE.*KEY/i.test(row.secretName) || /SSH.*PRIVATE.*KEY|PRIVATE.*KEY/i.test(row.defaultEnvName ?? ''));
  // Provider identifies the transport, not the secret format. Preserve password bytes.
  const sshPassword = row.provider === 'ssh' && (explicitType
    ? ['password', 'ssh_password'].includes(explicitType)
    : row.kind === 'password' || /PASSWORD/i.test(`${row.secretName} ${row.defaultEnvName ?? ''}`));
  const credentialType = explicitType ?? (sshPassword ? 'ssh_password' : ssh ? 'ssh_private_key' : row.kind);
  if (materializationType !== 'file' && credentialType !== 'ssh_private_key' && !ssh) return null;
  const envName = stringMetadataValue(materialization ?? {}, 'env_name')
    ?? stringMetadataValue(metadata, 'path_env_name')
    ?? credentialFileEnvNameForDefaultEnv(row.targetEnvName ?? row.defaultEnvName ?? row.secretName);
  assertSecretName(envName);
  const fileName = safeCredentialFileName(stringMetadataValue(materialization ?? {}, 'filename') ?? stringMetadataValue(metadata, 'filename') ?? (credentialType === 'ssh_private_key' ? 'id_ssh' : row.credentialId));
  const requestedMode = stringMetadataValue(materialization ?? {}, 'mode') ?? '0600';
  return /^0?[0-7]{3}$/.test(requestedMode)
    ? { credentialType, envName, fileName, mode: requestedMode }
    : { credentialType, envName, fileName, mode: '0600', reason: 'invalid materialization mode; defaulted to 0600' };
}

interface RuntimeCredentialRow {
  credential_id: string;
  provider: string;
  kind: string;
  secret_name: string;
  default_env_name: string | null;
  metadata: Record<string, unknown>;
  scope: CredentialVaultScope;
}

async function listRuntimeCredentials(projectId: string, kind?: string): Promise<RuntimeCredentialRow[]> {
  const rows = await query<RuntimeCredentialRow>(
    `SELECT c.id AS credential_id, c.provider, c.kind, c.secret_name, c.default_env_name, c.metadata, c.scope
       FROM workspace_credentials c
      WHERE c.enabled = true
        AND ($2::text IS NULL OR c.kind = $2)
        AND ${allowedProjectCredentialWhere('c', '$1')}
      ORDER BY CASE c.scope WHEN 'project' THEN 0 ELSE 1 END, c.id`,
    [projectId, kind ?? null],
  );
  return rows.filter(row => !Object.prototype.hasOwnProperty.call(row.metadata ?? {}, 'legacy_personal_owner_user_id'));
}

export type CredentialRequirementReason = 'LegacyPersonalCredentialBlocked' | 'UnsupportedCredentialKind' | 'SelectionOrMaterializationFailed' | 'NoAccessibleMatchingCredential';

/** Metadata only: never inspect secrets or reveal other Agents' records. Does not grant access. */
export async function diagnoseUnresolvedCredentialRequirements(projectId: string, names: string[]): Promise<Array<{ envName: string; reason: CredentialRequirementReason }>> {
  if (names.length === 0) return [];
  const rows = await query<{ default_env_name: string | null; kind: string; metadata: Record<string, unknown> }>(
    `SELECT c.default_env_name, c.kind, c.metadata FROM workspace_credentials c
     WHERE c.enabled = true AND (c.scope = 'workspace' OR (c.scope = 'project' AND c.project_id = $1))
       AND c.default_env_name = ANY($2::text[])`, [projectId, names],
  );
  return names.map(envName => {
    const matching = rows.filter(row => row.default_env_name === envName);
    const allowed = matching.filter(row => !isLegacyPersonalCredential(row));
    const reason: CredentialRequirementReason = allowed.some(row => row.kind === 'api_key')
      ? 'SelectionOrMaterializationFailed'
      : allowed.length > 0 ? 'UnsupportedCredentialKind'
      : matching.length > 0 ? 'LegacyPersonalCredentialBlocked' : 'NoAccessibleMatchingCredential';
    return { envName, reason };
  });
}

export async function listProjectRuntimeCredentialEnvNames(projectId: string): Promise<string[]> {
  const names = new Set<string>();
  for (const row of await listRuntimeCredentials(projectId)) {
    if (row.kind !== 'api_key') continue;
    const sourceEnvName = row.default_env_name ?? row.secret_name;
    assertSecretName(sourceEnvName);
    names.add(sourceEnvName);
    const file = classifyRuntimeBoxFileCredential({
      credentialId: row.credential_id, provider: row.provider, kind: row.kind, secretName: row.secret_name,
      defaultEnvName: row.default_env_name, targetEnvName: null, metadata: row.metadata ?? {},
    });
    if (file) names.add(file.envName);
  }
  return [...names].sort();
}

function envRequested(envName: string, requested?: ReadonlySet<string>): boolean {
  return !requested || requested.has(envName) || [...requested].some(prefix => prefix.endsWith('_') && envName.startsWith(prefix));
}

export function fileCredentialRequested(input: {
  pathEnvName: string;
  sourceEnvName: string;
  requestedEnvNames?: ReadonlySet<string>;
}): boolean {
  return envRequested(input.pathEnvName, input.requestedEnvNames)
    || envRequested(input.sourceEnvName, input.requestedEnvNames);
}

export async function resolveRuntimeBoxApiKeyEnv(opts: {
  projectId: string;
  userId: number;
  existingEnv?: Record<string, string>;
  requestedEnvNames?: ReadonlySet<string>;
}): Promise<RuntimeBoxApiKeyEnvResolution> {
  const rows = await listRuntimeCredentials(opts.projectId, 'api_key');
  const vaultEnv: Array<{ credentialId: string; envName: string; value: string }> = [];
  const skipped: RuntimeBoxCredentialSkippedItem[] = [];
  const claimed = new Set<string>();
  for (const row of rows) {
    const file = classifyRuntimeBoxFileCredential({
      credentialId: row.credential_id, provider: row.provider, kind: row.kind, secretName: row.secret_name,
      defaultEnvName: row.default_env_name, targetEnvName: null, metadata: row.metadata ?? {},
    });
    if (file) {
      skipped.push({ credentialId: row.credential_id, envName: row.default_env_name ?? row.secret_name, reason: 'file credential is materialized as path env; raw env not injected' });
      continue;
    }
    const envName = row.default_env_name ?? row.secret_name;
    assertSecretName(envName);
    if (!envRequested(envName, opts.requestedEnvNames)) {
      skipped.push({ credentialId: row.credential_id, envName, reason: 'not requested by command credential scope' });
      continue;
    }
    if (claimed.has(envName)) {
      skipped.push({ credentialId: row.credential_id, envName, reason: 'duplicate target env; Agent-dedicated credential selected first' });
      continue;
    }
    claimed.add(envName);
    if (Object.prototype.hasOwnProperty.call(opts.existingEnv ?? {}, envName)) continue;
    try {
      const value = await getSecretForProjectBinding(row.secret_name);
      await auditCredentialEvent({ credentialId: row.credential_id, projectId: opts.projectId, eventType: 'materialize', actorUserId: opts.userId, provider: row.provider, targetType: 'runtime_box_env', targetRef: { env_name: envName } });
      vaultEnv.push({ credentialId: row.credential_id, envName, value });
    } catch (error: any) {
      skipped.push({ credentialId: row.credential_id, envName, reason: `credential unavailable; skipped (${error?.name ?? 'SecretResolutionError'})` });
    }
  }
  const merged = mergeRuntimeBoxApiKeyEnv({ existingEnv: opts.existingEnv, vaultEnv });
  return { ...merged, skipped: [...merged.skipped, ...skipped] };
}

export async function resolveRuntimeBoxCredentialFileMaterialization(opts: {
  projectId: string;
  userId: number;
  existingEnv?: Record<string, string>;
  excludeCredentialIds?: string[];
  requestedEnvNames?: ReadonlySet<string>;
}): Promise<RuntimeBoxCredentialFileResolution> {
  const excluded = new Set(opts.excludeCredentialIds ?? []);
  const claimed = new Set<string>();
  const materialize: RuntimeBoxCredentialFileSecret[] = [];
  const skipped: RuntimeBoxCredentialSkippedItem[] = [];
  for (const row of await listRuntimeCredentials(opts.projectId)) {
    if (excluded.has(row.credential_id)) continue;
    const file = classifyRuntimeBoxFileCredential({
      credentialId: row.credential_id, provider: row.provider, kind: row.kind, secretName: row.secret_name,
      defaultEnvName: row.default_env_name, targetEnvName: null, metadata: row.metadata ?? {},
    });
    if (!file) continue;
    const sourceEnvName = row.default_env_name ?? row.secret_name;
    if (!fileCredentialRequested({
      pathEnvName: file.envName,
      sourceEnvName,
      requestedEnvNames: opts.requestedEnvNames,
    })) {
      skipped.push({ credentialId: row.credential_id, envName: file.envName, reason: 'not requested by command credential scope' });
      continue;
    }
    if (Object.prototype.hasOwnProperty.call(opts.existingEnv ?? {}, file.envName)) {
      skipped.push({ credentialId: row.credential_id, envName: file.envName, reason: 'path env already supplied by caller; vault value not read' });
      continue;
    }
    if (claimed.has(file.envName)) {
      skipped.push({ credentialId: row.credential_id, envName: file.envName, reason: 'duplicate target file env; Agent-dedicated credential selected first' });
      continue;
    }
    // Reserve before reading: a failed preferred secret must not fall back to another identity.
    claimed.add(file.envName);
    try {
      const value = await getSecretForProjectBinding(row.secret_name);
      await auditCredentialEvent({ credentialId: row.credential_id, projectId: opts.projectId, eventType: 'materialize', actorUserId: opts.userId, provider: row.provider, targetType: 'runtime_box_file', targetRef: { env_name: file.envName } });
      materialize.push({ credentialId: row.credential_id, envName: file.envName, fileName: file.fileName, mode: file.mode, credentialType: file.credentialType, value });
    } catch (error: any) {
      skipped.push({ credentialId: row.credential_id, envName: file.envName, reason: `credential unavailable; skipped (${error?.name ?? 'SecretResolutionError'})` });
    }
  }
  return { materialize, skipped };
}

export async function hasProjectApiKeyCredential(opts: { projectId: string; envName: string }): Promise<boolean> {
  assertSecretName(opts.envName);
  return Boolean(await queryOne(
    `SELECT c.id FROM workspace_credentials c
      WHERE c.kind = 'api_key' AND c.enabled = true
        AND ${allowedProjectCredentialWhere('c', '$1')}
        AND COALESCE(c.default_env_name, c.secret_name) = $2 LIMIT 1`,
    [opts.projectId, opts.envName],
  ));
}

export async function resolveProjectApiKeySecretValue(opts: {
  projectId: string; userId: number; envName: string; targetType: string;
}): Promise<ProjectApiKeySecretResolution | null> {
  assertSecretName(opts.envName);
  const row = await queryOne<RuntimeCredentialRow & { env_name: string }>(
    `SELECT c.id AS credential_id, c.provider, c.kind, c.secret_name, c.default_env_name, c.metadata, c.scope,
            COALESCE(c.default_env_name, c.secret_name) AS env_name
       FROM workspace_credentials c
      WHERE c.kind = 'api_key' AND c.enabled = true
        AND ${allowedProjectCredentialWhere('c', '$1')}
        AND COALESCE(c.default_env_name, c.secret_name) = $2
      ORDER BY CASE c.scope WHEN 'project' THEN 0 ELSE 1 END, c.id LIMIT 1`,
    [opts.projectId, opts.envName],
  );
  if (!row) return null;
  assertExplicitlyRegisteredCredential(row);
  const value = await getSecretForProjectBinding(row.secret_name);
  await auditCredentialEvent({ credentialId: row.credential_id, projectId: opts.projectId, eventType: 'materialize', actorUserId: opts.userId, provider: row.provider, targetType: opts.targetType, targetRef: { env_name: opts.envName } });
  return { credentialId: row.credential_id, envName: opts.envName, value };
}

export async function resolveProjectCredentialSecretValue(opts: {
  projectId: string; userId: number; credentialId: string; kind?: string; provider?: string; targetType: string;
}): Promise<ProjectCredentialSecretResolution | null> {
  assertCredentialId(opts.credentialId);
  const row = await queryOne<RuntimeCredentialRow>(
    `SELECT c.id AS credential_id, c.provider, c.kind, c.secret_name, c.default_env_name, c.metadata, c.scope
       FROM workspace_credentials c
      WHERE c.id = $2 AND c.enabled = true
        AND ($3::text IS NULL OR c.kind = $3) AND ($4::text IS NULL OR c.provider = $4)
        AND ${allowedProjectCredentialWhere('c', '$1')} LIMIT 1`,
    [opts.projectId, opts.credentialId, opts.kind ?? null, opts.provider ?? null],
  );
  if (!row) return null;
  assertExplicitlyRegisteredCredential(row);
  // An opted-in bridge is authoritative even when denied: never catch and
  // fall back to a shared or requester-owned identity.
  const legacyValue = row.provider === 'google' && row.kind === 'gws'
    ? await getSecretForLegacyGwsBinding(row.credential_id, opts.userId) : null;
  const value = legacyValue ?? await getSecretForProjectBinding(row.secret_name);
  await auditCredentialEvent({ credentialId: row.credential_id, projectId: opts.projectId, eventType: 'materialize', actorUserId: opts.userId, provider: row.provider, targetType: opts.targetType, targetRef: { credential_id: row.credential_id, kind: row.kind, ...(legacyValue !== null ? { legacy_gws_binding: true } : {}) } });
  return { credentialId: row.credential_id, provider: row.provider, kind: row.kind, secretName: row.secret_name, value };
}

export async function revealCredentialValue(opts: {
  projectId?: string;
  credentialId: string;
  actorUserId: number;
  purpose: string;
}): Promise<{ credential: WorkspaceCredentialRow; value: string }> {
  if (opts.projectId) await assertCredentialManagementAccess({ actorUserId: opts.actorUserId, scope: 'project', projectId: opts.projectId, action: 'reveal' });
  const credential = await queryOne<WorkspaceCredentialRow>(
    `SELECT * FROM workspace_credentials c
      WHERE c.id = $1 AND c.enabled = true AND ${allowedProjectCredentialWhere('c', '$2')}`,
    [opts.credentialId, opts.projectId ?? null],
  );
  if (!credential) throw new Error('Credential not found or unavailable to this Agent');
  assertExplicitlyRegisteredCredential(credential);
  await assertCredentialManagementAccess({ actorUserId: opts.actorUserId, scope: credential.scope, projectId: credential.project_id, action: 'reveal' });
  const value = await getSecretForProjectBinding(credential.secret_name);
  await auditCredentialEvent({
    credentialId: credential.id,
    projectId: opts.projectId,
    eventType: 'credential_revealed',
    actorUserId: opts.actorUserId,
    provider: credential.provider,
    targetType: 'credential_management',
    targetRef: { purpose: opts.purpose.slice(0, 240), credential_scope: credential.scope },
    message: 'Credential value explicitly revealed by an authorized connection manager',
  });
  return { credential, value };
}

export async function copyProjectCredential(opts: {
  sourceProjectId: string;
  sourceCredentialId: string;
  targetProjectId: string;
  actorUserId: number;
}): Promise<WorkspaceCredentialRow> {
  if (opts.sourceProjectId === opts.targetProjectId) throw new Error('Source and target Agent must be different');
  const source = await queryOne<WorkspaceCredentialRow>(
    `SELECT * FROM workspace_credentials WHERE id = $1 AND scope = 'project' AND project_id = $2 AND enabled = true`,
    [opts.sourceCredentialId, opts.sourceProjectId],
  );
  if (!source) throw new Error('Source Agent Credential not found');
  assertExplicitlyRegisteredCredential(source);
  await assertCredentialManagementAccess({ actorUserId: opts.actorUserId, scope: 'project', projectId: opts.sourceProjectId });
  await assertCredentialManagementAccess({ actorUserId: opts.actorUserId, scope: 'project', projectId: opts.targetProjectId });
  const value = await getSecretForProjectBinding(source.secret_name);
  const suffix = randomUUID().replace(/-/g, '').slice(0, 10);
  const idBase = source.id.replace(/[^a-z0-9_-]+/g, '-').slice(0, 60);
  const credentialId = `${idBase}-copy-${suffix}`.slice(0, 80);
  const secretName = `AGENT_${opts.targetProjectId.replace(/-/g, '').slice(0, 12).toUpperCase()}_${suffix.toUpperCase()}`;
  await setSecret({ name: secretName, value, scope: 'global', description: `Agent Credential import: ${credentialId}`, createdBy: opts.actorUserId });
  const copied = await queryOne<WorkspaceCredentialRow>(
    `INSERT INTO workspace_credentials
       (id, kind, provider, display_name, secret_name, default_env_name, scope, project_id, metadata, enabled, created_by, updated_by, rotated_at)
     VALUES ($1, $2, $3, $4, $5, $6, 'project', $7, $8::jsonb, true, $9, $9, now())
     RETURNING *`,
    [credentialId, source.kind, source.provider, source.display_name, secretName, source.default_env_name, opts.targetProjectId,
      JSON.stringify({ ...source.metadata, imported_from_project_id: opts.sourceProjectId, imported_from_credential_id: source.id }), opts.actorUserId],
  );
  await auditCredentialEvent({
    credentialId: copied!.id,
    projectId: opts.targetProjectId,
    eventType: 'credential_imported',
    actorUserId: opts.actorUserId,
    provider: source.provider,
    targetType: 'project_credential_copy',
    targetRef: { source_project_id: opts.sourceProjectId, source_credential_id: source.id, target_project_id: opts.targetProjectId },
    message: 'Credential copied inside Secret Store into an independent Agent-owned record',
  });
  return copied!;
}

export async function listWorkspaceCredentials(opts: {
  scope?: CredentialVaultScope;
  projectId?: string;
  /** @deprecated ignored; personal scope no longer exists. */
  userId?: number;
  /** @deprecated ignored; personal scope no longer exists. */
  includePersonal?: boolean;
} = {}): Promise<WorkspaceCredentialRow[]> {
  if (opts.scope === 'project') {
    if (!opts.projectId) throw new Error('projectId required for Agent credential list');
    return query(`SELECT * FROM workspace_credentials WHERE scope = 'project' AND project_id = $1 ORDER BY provider, id`, [opts.projectId]);
  }
  return query(`SELECT * FROM workspace_credentials WHERE scope = 'workspace' ORDER BY provider, id`);
}

function normalizedMetadata(scope: CredentialVaultScope, metadata: Record<string, unknown>, projectId?: string): Record<string, unknown> {
  if (scope === 'workspace') return { ...metadata, agent_project_id: undefined };
  if (!projectId) throw new Error('project credential requires projectId');
  return { ...metadata, connection_type: 'agent', agent_project_id: undefined };
}

export async function upsertApiKeyCredential(opts: {
  id: string; provider: string; displayName: string; secretName: string; secretValue: string;
  defaultEnvName?: string; scope?: CredentialVaultScope; projectId?: string; metadata?: Record<string, unknown>; actorUserId: number;
  /** Removed legacy option; accepted only so old callers receive a clear validation error. */
  ownerUserId?: number | null;
}): Promise<WorkspaceCredentialRow> {
  assertCredentialId(opts.id); assertSecretName(opts.secretName);
  if (opts.defaultEnvName) assertSecretName(opts.defaultEnvName);
  if (!opts.secretValue) throw new Error('secret value is empty');
  if (opts.ownerUserId) throw new Error('personal credentials are no longer supported');
  const scope = opts.scope ?? 'workspace';
  if (!['workspace', 'project'].includes(scope)) throw new Error('scope must be workspace or project');
  await assertCredentialManagementAccess({ actorUserId: opts.actorUserId, scope, projectId: opts.projectId });
  const metadata = normalizedMetadata(scope, opts.metadata ?? {}, opts.projectId);
  const existing = await queryOne<Pick<WorkspaceCredentialRow, 'kind' | 'provider' | 'secret_name' | 'default_env_name' | 'scope' | 'project_id' | 'metadata'>>(
    `SELECT kind, provider, secret_name, default_env_name, scope, project_id, metadata FROM workspace_credentials WHERE id = $1`, [opts.id],
  );
  const legacyReRegistration = existing ? isLegacyPersonalCredential(existing) : false;
  const envName = opts.defaultEnvName ?? opts.secretName;
  if (existing && (existing.provider !== opts.provider || (existing.kind !== 'gws' && existing.default_env_name !== envName) || existing.scope !== scope ||
    (scope === 'project' && existing.project_id !== opts.projectId))) {
    throw new Error(`credential id '${opts.id}' already exists with a different service, env, scope, or Agent owner`);
  }
  if (existing && await queryOne(`SELECT id FROM workspace_credentials WHERE secret_name = $1 AND id <> $2 LIMIT 1`, [existing.secret_name, opts.id])) {
    throw new Error('Legacy shared storage identity requires explicit Credential migration before rotation');
  }
  // New records get a server-owned storage identity: a member-supplied env/name
  // must never rotate another Agent's or the platform's global Secret Store row.
  const storageSecretName = existing && !legacyReRegistration
    ? existing.secret_name
    : newCredentialStorageName(scope, opts.projectId, opts.id);
  const normalized = normalizeSecretInput(opts.secretValue, inferSecretPolicy({ provider: opts.provider, fieldId: String(metadata.field_id ?? 'api_key'), envName, credentialType: String(metadata.credential_type ?? '') }));
  await setSecret({ name: storageSecretName, value: normalized.value, scope: 'global', description: `${scope === 'workspace' ? 'Team' : 'Agent'} Credential Vault: ${opts.id}`, createdBy: opts.actorUserId });
  const row = await queryOne<WorkspaceCredentialRow>(
    `INSERT INTO workspace_credentials
       (id, kind, provider, display_name, secret_name, default_env_name, scope, project_id, metadata, created_by, updated_by, rotated_at)
     VALUES ($1, 'api_key', $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $9, now())
     ON CONFLICT (id) DO UPDATE SET display_name = EXCLUDED.display_name, secret_name = EXCLUDED.secret_name, metadata = EXCLUDED.metadata, enabled = true,
       updated_at = now(), updated_by = EXCLUDED.updated_by, rotated_at = now()
     RETURNING *`,
    [opts.id, opts.provider, opts.displayName, storageSecretName, envName, scope, scope === 'project' ? opts.projectId : null, JSON.stringify({ ...metadata, input_normalizations: normalized.normalizations }), opts.actorUserId],
  );
  await auditCredentialEvent({ credentialId: opts.id, projectId: scope === 'project' ? opts.projectId ?? null : null, eventType: legacyReRegistration ? 'credential_re_registered' : existing ? 'credential_rotated' : 'credential_created', actorUserId: opts.actorUserId, provider: opts.provider, message: legacyReRegistration ? `${scope} legacy Credential re-registered with an independent storage identity` : `${scope} credential stored without raw-secret exposure` });
  return row!;
}

export async function rotateExistingCredential(opts: { credentialId: string; secretValue: string; actorUserId: number; projectId?: string; scope?: CredentialVaultScope }): Promise<WorkspaceCredentialRow> {
  const existing = await queryOne<WorkspaceCredentialRow>(
    `SELECT * FROM workspace_credentials WHERE id = $1
      AND ($2::text IS NULL OR scope = $2)
      AND ($3::text IS NULL OR (scope = 'project' AND project_id = $3))`,
    [opts.credentialId, opts.scope ?? null, opts.projectId ?? null],
  );
  if (!existing) throw new Error('Credential not found');
  await assertCredentialManagementAccess({ actorUserId: opts.actorUserId, scope: existing.scope, projectId: existing.project_id });
  const legacyReRegistration = isLegacyPersonalCredential(existing);
  const aliases = legacyReRegistration ? null : await queryOne(`SELECT id FROM workspace_credentials WHERE secret_name = $1 AND id <> $2 LIMIT 1`, [existing.secret_name, existing.id]);
  if (aliases) throw new Error('Legacy shared storage identity requires explicit Credential migration before rotation');
  const normalized = normalizeSecretInput(opts.secretValue, inferSecretPolicy({ provider: existing.provider, fieldId: String(existing.metadata?.field_id ?? 'api_key'), envName: existing.default_env_name ?? existing.secret_name, credentialType: String(existing.metadata?.credential_type ?? existing.kind) }));
  const storageSecretName = legacyReRegistration ? newCredentialStorageName(existing.scope, existing.project_id, existing.id) : existing.secret_name;
  await setSecret({ name: storageSecretName, value: normalized.value, scope: 'global', description: `Credential Vault: ${existing.id}`, createdBy: opts.actorUserId });
  const row = await queryOne<WorkspaceCredentialRow>(
    `UPDATE workspace_credentials SET secret_name = $2, metadata = CASE WHEN $4 THEN (metadata - 'legacy_personal_owner_user_id' - 'scope_migrated_by') ELSE metadata END || $3::jsonb, enabled = true, rotated_at = now(), updated_at = now(), updated_by = $5 WHERE id = $1 RETURNING *`,
    [opts.credentialId, storageSecretName, JSON.stringify({ input_normalizations: normalized.normalizations, ...(legacyReRegistration ? { connection_type: existing.scope === 'project' ? 'agent' : undefined } : {}) }), legacyReRegistration, opts.actorUserId],
  );
  await auditCredentialEvent({ credentialId: opts.credentialId, projectId: existing.scope === 'project' ? existing.project_id : null, eventType: legacyReRegistration ? 'credential_re_registered' : 'credential_rotated', actorUserId: opts.actorUserId, provider: existing.provider });
  return row!;
}

export async function promoteProjectCredentialToWorkspace(opts: { credentialId: string; projectId: string; actorUserId: number }): Promise<WorkspaceCredentialRow> {
  await assertCredentialManagementAccess({ actorUserId: opts.actorUserId, scope: 'workspace', action: 'admin' });
  const row = await queryOne<WorkspaceCredentialRow>(
    `UPDATE workspace_credentials
        SET scope = 'workspace', project_id = NULL,
            metadata = metadata || jsonb_build_object('promoted_from_project_id', $2),
            updated_at = now(), updated_by = $3
      WHERE id = $1 AND scope = 'project' AND project_id = $2
        AND NOT (COALESCE(metadata, '{}'::jsonb) ? 'legacy_personal_owner_user_id')
      RETURNING *`,
    [opts.credentialId, opts.projectId, opts.actorUserId],
  );
  if (!row) throw new Error('Agent Credential not found');
  await auditCredentialEvent({
    credentialId: row.id,
    projectId: opts.projectId,
    eventType: 'credential_promoted_to_workspace',
    actorUserId: opts.actorUserId,
    provider: row.provider,
    targetType: 'vm_vault',
    targetRef: { source_project_id: opts.projectId, resulting_scope: 'workspace' },
    message: 'Agent-dedicated Credential promoted to team-shared VM Credential',
  });
  return row;
}

export async function updateCredentialLifecycle(opts: { credentialId: string; enabled?: boolean; displayName?: string; actorUserId: number; projectId?: string; scope?: CredentialVaultScope }): Promise<WorkspaceCredentialRow> {
  const existing = await queryOne<WorkspaceCredentialRow>(`SELECT * FROM workspace_credentials WHERE id = $1`, [opts.credentialId]);
  if (!existing) throw new Error('Credential not found');
  await assertCredentialManagementAccess({ actorUserId: opts.actorUserId, scope: existing.scope, projectId: existing.project_id });
  const row = await queryOne<WorkspaceCredentialRow>(
    `UPDATE workspace_credentials SET enabled = COALESCE($2, enabled), display_name = COALESCE($3, display_name), updated_at = now(), updated_by = $4
      WHERE id = $1
        AND ($5::text IS NULL OR scope = $5)
        AND ($6::text IS NULL OR (scope = 'project' AND project_id = $6)) RETURNING *`,
    [opts.credentialId, opts.enabled ?? null, opts.displayName ?? null, opts.actorUserId, opts.scope ?? null, opts.projectId ?? null],
  );
  if (!row) throw new Error('Credential not found');
  await auditCredentialEvent({ credentialId: row.id, projectId: opts.projectId ?? null, eventType: row.enabled ? 'credential_enabled' : 'credential_disabled', actorUserId: opts.actorUserId, provider: row.provider });
  return row;
}

export async function deleteCredential(opts: { credentialId: string; actorUserId: number; projectId?: string; scope?: CredentialVaultScope }): Promise<boolean> {
  return transaction(async client => {
    const db = withClient(client);
    const existing = await db.queryOne<WorkspaceCredentialRow>(`SELECT * FROM workspace_credentials WHERE id = $1 FOR UPDATE`, [opts.credentialId]);
    if (!existing) return false;
    await assertCredentialManagementAccess({ actorUserId: opts.actorUserId, scope: existing.scope, projectId: existing.project_id });
    const row = await db.queryOne<WorkspaceCredentialRow>(
      `DELETE FROM workspace_credentials WHERE id = $1
        AND ($2::text IS NULL OR scope = $2)
        AND ($3::text IS NULL OR (scope = 'project' AND project_id = $3)) RETURNING *`,
      [opts.credentialId, opts.scope ?? null, opts.projectId ?? null],
    );
    if (!row) return false;
    await db.execute(`DELETE FROM secret_store s WHERE s.name = $1 AND s.scope = 'global' AND NOT EXISTS (SELECT 1 FROM workspace_credentials c WHERE c.secret_name = s.name)`, [row.secret_name]);
    return true;
  });
}

export async function upsertOrganizationGwsCredential(opts: { credentialId: string; displayName: string; secretName: string; encodedConfig: string; googleAccount: string; actorUserId: number }): Promise<WorkspaceCredentialRow> {
  const row = await upsertApiKeyCredential({ id: opts.credentialId, provider: 'google', displayName: opts.displayName, secretName: opts.secretName, secretValue: opts.encodedConfig, scope: 'workspace', metadata: { credential_type_id: 'google_oauth', google_account: opts.googleAccount }, actorUserId: opts.actorUserId });
  return (await queryOne<WorkspaceCredentialRow>(`UPDATE workspace_credentials SET kind = 'gws', default_env_name = NULL WHERE id = $1 RETURNING *`, [row.id]))!;
}

export async function upsertAgentGwsCredential(opts: { projectId: string; credentialId: string; displayName: string; secretName: string; encodedConfig: string; googleAccount: string; actorUserId: number; credentialTypeId?: string }): Promise<WorkspaceCredentialRow> {
  const row = await upsertApiKeyCredential({ id: opts.credentialId, provider: 'google', displayName: opts.displayName, secretName: opts.secretName, secretValue: opts.encodedConfig, scope: 'project', projectId: opts.projectId, metadata: { credential_type_id: opts.credentialTypeId ?? 'google_oauth', google_account: opts.googleAccount }, actorUserId: opts.actorUserId });
  return (await queryOne<WorkspaceCredentialRow>(`UPDATE workspace_credentials SET kind = 'gws', default_env_name = NULL WHERE id = $1 RETURNING *`, [row.id]))!;
}

export function newCredentialId(prefix = 'credential'): string { return `${prefix}-${randomUUID()}`; }

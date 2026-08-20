/**
 * credential-vault-service.ts — Workspace Credential Vault MVP.
 *
 * Owns: credential metadata, project policy, GitHub Actions secret target sync.
 * Public API: upsertApiKeyCredential, setProjectCredentialPolicy,
 *             upsertGitHubActionsSecretTarget, checkGitHubActionsSecretStatus,
 *             syncGitHubActionsSecret, listWorkspaceCredentials.
 * See README.md.
 *
 * Secret handling rule: values live only in secret_store and are passed to
 * target CLIs via stdin/env for one operation. Never put secret values in DB
 * metadata, argv, stdout, stderr, or audit messages.
 */

import { spawn } from 'child_process';
import { randomUUID } from 'crypto';
import { query, queryOne, execute } from '../../db/pg-repo.js';
import { getSecret, getSecretForProjectBinding, setSecret } from '../secret/secret-store.js';
import { inferSecretPolicy, normalizeSecretInput } from './credential-input-normalizer.js';

const VALID_SECRET_NAME_RE = /^[A-Z][A-Z0-9_]{0,63}$/;
const VALID_CREDENTIAL_ID_RE = /^[a-z0-9][a-z0-9_-]{1,79}$/;
const VALID_REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

export type CredentialVaultScope = 'workspace' | 'internal-default' | 'project' | 'personal';

type AuditStatus = 'ok' | 'error' | 'denied';

export interface WorkspaceCredentialRow {
  id: string;
  kind: string;
  provider: string;
  display_name: string;
  secret_name: string;
  default_env_name: string | null;
  scope: CredentialVaultScope;
  owner_user_id: number | null;
  metadata: Record<string, unknown>;
  enabled: boolean;
  created_at: Date;
  created_by: number | null;
  updated_at: Date;
  updated_by: number | null;
  rotated_at: Date | null;
}

export interface CredentialTargetSyncRow {
  id: number;
  credential_id: string;
  project_id: string | null;
  target_type: string;
  target_ref: Record<string, unknown>;
  desired_state: string;
  enabled: boolean;
  last_status: string | null;
  last_checked_at: Date | null;
  last_synced_at: Date | null;
  last_error: string | null;
  created_at: Date;
  created_by: number | null;
  updated_at: Date;
  updated_by: number | null;
}

export interface GitHubActionsSecretTargetRef extends Record<string, unknown> {
  repo: string;
  secret_name: string;
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

export interface ProjectApiKeySecretResolution {
  credentialId: string;
  envName: string;
  value: string;
}

export interface ProjectCredentialSecretResolution {
  credentialId: string;
  provider: string;
  kind: string;
  secretName: string;
  value: string;
}

export interface CredentialProfileRow {
  id: string;
  profile_type: string;
  provider: string;
  display_name: string;
  env: Record<string, string>;
  secret_refs: Record<string, string>;
  metadata: Record<string, unknown>;
  enabled: boolean;
  created_at: Date;
  created_by: number | null;
  updated_at: Date;
  updated_by: number | null;
}

export interface CredentialBundleTypeField {
  id: string;
  label: string;
  envName: string;
  required: boolean;
  secret: boolean;
  envNameEditable?: boolean;
  placeholder?: string;
}

export interface CredentialTypeField {
  id: string;
  label: string;
  required: boolean;
  secret: boolean;
  multiline?: boolean;
  placeholder?: string;
}

export interface CredentialType {
  id: string;
  provider: string;
  label: string;
  description: string;
  materialization: 'env' | 'file';
  secretFieldId: string;
  defaultCredentialId: string;
  defaultDisplayName: string;
  defaultSecretName: string;
  defaultEnvName: string;
  defaultPathEnvName?: string;
  defaultFilename?: string;
  defaultMode?: string;
  fields: CredentialTypeField[];
}

export interface CredentialBundleType {
  id: string;
  provider: string;
  profileType: 'custom';
  label: string;
  description: string;
  defaultInstanceId: string;
  defaultDisplayName: string;
  fields: CredentialBundleTypeField[];
}

export interface CredentialBundleUpsertResult {
  profile: CredentialProfileRow;
  credentials: WorkspaceCredentialRow[];
  grantedProjectId: string | null;
}

export interface SshPrivateKeyCredentialUpsertResult {
  credential: WorkspaceCredentialRow;
  grantedProjectId: string | null;
  pathEnvName: string;
}

export interface TypedCredentialUpsertResult {
  credential: WorkspaceCredentialRow;
  grantedProjectId: string | null;
  envName: string;
  pathEnvName: string | null;
}

export interface CredentialMaterializationTestResult {
  ok: boolean;
  credentialId: string;
  credentialType: string;
  materialization: 'env' | 'file';
  envName: string;
  fileName?: string;
  mode?: string;
  checks: Array<{ name: string; ok: boolean; message: string }>;
}

export interface RuntimeBoxCredentialProfileEnvResolution extends RuntimeBoxApiKeyEnvResolution {
  materializeFiles: RuntimeBoxCredentialFileSecret[];
  profiles: Array<{
    profileId: string;
    displayName: string;
    envNames: string[];
    secretEnvNames: string[];
    fileEnvNames: string[];
    skippedExisting: string[];
  }>;
}

export interface ProjectConnectionPreview {
  projectId: string;
  profiles: Array<{
    id: string;
    displayName: string;
    provider: string;
    profileType: string;
    mode: 'allow' | 'deny' | null;
    status: 'connected' | 'denied' | 'not_granted' | 'disabled' | 'needs_attention';
    publicEnvNames: string[];
    secretEnv: Array<{
      envName: string;
      credentialId: string;
      displayName: string | null;
      provider: string | null;
      mode: 'inherit' | 'allow' | 'deny' | 'override' | null;
      status: 'allowed' | 'denied' | 'not_granted' | 'missing_credential' | 'disabled';
    }>;
  }>;
  credentials: Array<{
    id: string;
    displayName: string;
    provider: string;
    kind: string;
    defaultEnvName: string | null;
    targetEnvName: string | null;
    scope: string;
    mode: 'inherit' | 'allow' | 'deny' | 'override' | null;
    status: 'allowed' | 'denied' | 'not_granted' | 'disabled';
    targets: Array<{
      id: number;
      targetType: string;
      targetRef: Record<string, unknown>;
      lastStatus: string | null;
      lastCheckedAt: Date | null;
      lastSyncedAt: Date | null;
      lastError: string | null;
    }>;
  }>;
}

function assertCredentialId(id: string): void {
  if (!VALID_CREDENTIAL_ID_RE.test(id)) {
    throw new Error(`invalid credential id: ${id}`);
  }
}

function credentialIdPart(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || randomUUID().slice(0, 8);
}

function secretNamePrefix(value: string): string {
  const normalized = value.toUpperCase().replace(/[^A-Z0-9_]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40);
  return /^[A-Z]/.test(normalized) ? normalized : `CRED_${normalized || randomUUID().replace(/-/g, '_').slice(0, 8)}`;
}

function assertSecretName(name: string): void {
  if (!VALID_SECRET_NAME_RE.test(name)) {
    throw new Error(`invalid secret/env name: ${name}`);
  }
}

function assertGitHubRepo(repo: string): void {
  if (!VALID_REPO_RE.test(repo)) {
    throw new Error(`invalid GitHub repo: ${repo}`);
  }
}

function targetRefFromRow(row: CredentialTargetSyncRow): GitHubActionsSecretTargetRef {
  const repo = String(row.target_ref?.repo ?? '');
  const secretName = String(row.target_ref?.secret_name ?? '');
  assertGitHubRepo(repo);
  assertSecretName(secretName);
  return { repo, secret_name: secretName };
}

export function allowedProjectCredentialWhere(alias = 'c', policyAlias = 'p', defaultAlias = 'd', projectAlias = 'prj'): string {
  // Visible default-on semantics:
  // 1. explicit project allow/override/inherit wins;
  // 2. explicit project deny blocks;
  // 3. workspace_connection_defaults can make a connection default-on;
  // 4. project_template defaults match project name / root slug / space slug;
  // 5. legacy workspace/internal-default credentials stay inherited until migrated
  //    into explicit default rows;
  // 6. an explicit Agent binding is the Runtime authority for every scope,
  //    including legacy personal credentials. owner_user_id controls who may
  //    manage the legacy record, not which authorized Agent member may execute it.
  //    Personal credentials are still never default-inherited.
  const explicitAgentBinding = `${policyAlias}.mode IN ('allow', 'override', 'inherit')`;
  return `(
    (
      ${explicitAgentBinding}
      OR (
        ${alias}.scope <> 'personal'
        AND (
          ${policyAlias}.mode IN ('allow', 'override', 'inherit')
          OR (
            ${policyAlias}.mode IS NULL
            AND (
              (
                ${defaultAlias}.enabled = true
                AND (
                  ${defaultAlias}.default_mode = 'all_projects'
                  OR (
                    ${defaultAlias}.default_mode = 'project_template'
                    AND ${defaultAlias}.project_template IS NOT NULL
                    AND lower(${defaultAlias}.project_template) IN (
                      lower(${projectAlias}.name),
                      lower(coalesce(${projectAlias}.space_slug, '')),
                      lower(regexp_replace(coalesce(${projectAlias}.root_path, ''), '^.*/', ''))
                    )
                  )
                )
              )
              OR (${defaultAlias}.connection_id IS NULL AND ${alias}.scope IN ('workspace', 'internal-default'))
            )
          )
        )
      )
    )
  )`;
}

export async function auditCredentialEvent(opts: {
  credentialId?: string | null;
  projectId?: string | null;
  targetSyncId?: number | null;
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
       (credential_id, project_id, target_sync_id, event_type, actor_user_id,
        provider, target_type, target_ref, status, error_code, message)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10, $11)`,
    [
      opts.credentialId ?? null,
      opts.projectId ?? null,
      opts.targetSyncId ?? null,
      opts.eventType,
      opts.actorUserId ?? null,
      opts.provider ?? null,
      opts.targetType ?? null,
      JSON.stringify(opts.targetRef ?? {}),
      opts.status ?? 'ok',
      opts.errorCode ?? null,
      opts.message ?? null,
    ],
  );
}

async function spawnGh(args: string[], opts: { stdin?: string; timeoutMs?: number } = {}) {
  return new Promise<{ stdout: string; stderr: string; exitCode: number; timedOut: boolean }>((resolve) => {
    const proc = spawn('gh', args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const maxLen = 128_000;

    const timer = opts.timeoutMs
      ? setTimeout(() => {
        timedOut = true;
        proc.kill('SIGKILL');
      }, opts.timeoutMs)
      : null;

    proc.stdout.on('data', (chunk: Buffer) => { stdout = (stdout + chunk.toString('utf8')).slice(0, maxLen); });
    proc.stderr.on('data', (chunk: Buffer) => { stderr = (stderr + chunk.toString('utf8')).slice(0, maxLen); });
    proc.on('error', (err) => {
      if (timer) clearTimeout(timer);
      resolve({ stdout: '', stderr: err.message, exitCode: -1, timedOut: false });
    });
    proc.on('close', (code) => {
      if (timer) clearTimeout(timer);
      resolve({ stdout, stderr, exitCode: timedOut ? 124 : (code ?? -1), timedOut });
    });

    if (opts.stdin !== undefined) proc.stdin.end(opts.stdin);
    else proc.stdin.end();
  });
}

/**
 * Merge vault-resolved API-key env into a Runtime Box exec env.
 *
 * Precedence decision: caller-provided env wins. A user/session that explicitly
 * sets GEMINI_API_KEY for one command is making a narrower override than the
 * project policy, so the vault must not silently replace it.
 */
export function mergeRuntimeBoxApiKeyEnv(opts: {
  existingEnv?: Record<string, string>;
  vaultEnv: Array<{ credentialId: string; envName: string; value: string }>;
}): RuntimeBoxApiKeyEnvResolution {
  const env: Record<string, string> = { ...(opts.existingEnv ?? {}) };
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

async function resolveProjectBoundSecret(opts: { secretName: string; userId: number; scope: CredentialVaultScope; ownerUserId?: number | null; mode: string }): Promise<string> {
  const projectBound = opts.scope === 'personal' && opts.mode !== 'inherit';
  const resolve = () => projectBound ? getSecretForProjectBinding(opts.secretName, opts.ownerUserId) : getSecret(opts.secretName, opts.userId);
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await resolve();
    } catch (error) {
      lastError = error;
      if (attempt < 2 && (error as { name?: string })?.name === 'SecretAccessDeniedError') {
        await new Promise<void>(resolveDelay => setTimeout(resolveDelay, 10 * (attempt + 1)));
        continue;
      }
      throw error;
    }
  }
  throw lastError;
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
  const sanitized = value.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80);
  return sanitized || 'credential';
}

export function credentialFileEnvNameForDefaultEnv(defaultEnvName: string): string {
  const withoutPrivateKey = defaultEnvName.replace(/_PRIVATE_KEY$/, '_KEY');
  const base = withoutPrivateKey.endsWith('_FILE') ? withoutPrivateKey : `${withoutPrivateKey}_FILE`;
  assertSecretName(base);
  return base;
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
  const explicitCredentialType = stringMetadataValue(metadata, 'credential_type');
  // Base64 fallback credentials are one-line env values by design. Do not
  // reinterpret them as SSH key files unless metadata explicitly asks for file
  // materialization; otherwise the compatibility fallback stops working.
  const looksLikeEncodedFallback =
    /(_B64|_BASE64)$/i.test(row.credentialId) ||
    /(_B64|_BASE64)$/i.test(row.secretName) ||
    /(_B64|_BASE64)$/i.test(row.defaultEnvName ?? '');
  const looksLikeSshPrivateKey = !looksLikeEncodedFallback && (
    row.provider === 'ssh' ||
    /(^|[-_])ssh([-_]|$)/i.test(row.credentialId) ||
    /SSH.*PRIVATE.*KEY|PRIVATE.*KEY/i.test(row.secretName) ||
    /SSH.*PRIVATE.*KEY|PRIVATE.*KEY/i.test(row.defaultEnvName ?? '')
  );
  const credentialType = explicitCredentialType ?? (looksLikeSshPrivateKey ? 'ssh_private_key' : row.kind);
  const shouldMaterializeFile =
    materializationType === 'file' ||
    credentialType === 'ssh_private_key' ||
    looksLikeSshPrivateKey;

  if (!shouldMaterializeFile) return null;

  const explicitPathEnvName = stringMetadataValue(materialization ?? {}, 'env_name') ?? stringMetadataValue(metadata, 'path_env_name');
  const envName = explicitPathEnvName
    ?? credentialFileEnvNameForDefaultEnv(row.targetEnvName ?? row.defaultEnvName ?? row.secretName);
  assertSecretName(envName);

  const fileName = safeCredentialFileName(
    stringMetadataValue(materialization ?? {}, 'filename')
    ?? stringMetadataValue(metadata, 'filename')
    ?? (credentialType === 'ssh_private_key' || row.provider === 'ssh' ? 'id_ssh' : row.credentialId),
  );
  const mode = stringMetadataValue(materialization ?? {}, 'mode') ?? '0600';
  if (!/^0?[0-7]{3}$/.test(mode)) {
    return { credentialType, envName, fileName, mode: '0600', reason: 'invalid materialization mode; defaulted to 0600' };
  }

  return { credentialType, envName, fileName, mode };
}

/**
 * Resolve project-allowed file-style credentials for one Runtime Box command.
 *
 * Secret values are returned only to the Runtime Box manager so it can write
 * temp files inside /tmp/tower-credentials/<exec-id>/ and clean them up after
 * the single exec. They must never be logged or surfaced in Runtime Context.
 */
export async function resolveRuntimeBoxCredentialFileMaterialization(opts: {
  projectId: string;
  userId: number;
  existingEnv?: Record<string, string>;
  excludeCredentialIds?: string[];
}): Promise<RuntimeBoxCredentialFileResolution> {
  const rows = await query<{
    credential_id: string;
    provider: string;
    kind: string;
    secret_name: string;
    default_env_name: string | null;
    target_env_name: string | null;
    metadata: Record<string, unknown>;
    scope: CredentialVaultScope;
    owner_user_id: number | null;
    mode: string;
  }>(
    `SELECT c.id AS credential_id,
            c.provider,
            c.kind,
            c.secret_name,
            c.default_env_name,
            p.target_env_name,
            c.metadata,
            c.scope,
            c.owner_user_id,
            COALESCE(p.mode, 'inherit') AS mode
       FROM workspace_credentials c
       LEFT JOIN project_credential_policies p
         ON p.credential_id = c.id AND p.project_id = $1
       LEFT JOIN workspace_connection_defaults d
         ON d.connection_id = 'credential:' || c.id
       JOIN (
         SELECT p.*, s.slug AS space_slug
           FROM projects p LEFT JOIN spaces s ON s.id = p.space_id
          WHERE p.id = $1
       ) prj ON true
      WHERE c.enabled = true
        AND ${allowedProjectCredentialWhere('c', 'p', 'd', 'prj')}
      ORDER BY c.id`,
    [opts.projectId],
  );

  const materialize: RuntimeBoxCredentialFileSecret[] = [];
  const skipped: RuntimeBoxCredentialSkippedItem[] = [];
  const existingEnv = opts.existingEnv ?? {};
  const excluded = new Set(opts.excludeCredentialIds ?? []);

  for (const row of rows) {
    if (excluded.has(row.credential_id)) continue;
    const classified = classifyRuntimeBoxFileCredential({
      credentialId: row.credential_id,
      provider: row.provider,
      kind: row.kind,
      secretName: row.secret_name,
      defaultEnvName: row.default_env_name,
      targetEnvName: row.target_env_name,
      metadata: row.metadata ?? {},
    });
    if (!classified) continue;

    if (Object.prototype.hasOwnProperty.call(existingEnv, classified.envName)) {
      skipped.push({ credentialId: row.credential_id, envName: classified.envName, reason: 'path env already supplied by caller; vault value not read' });
      await auditCredentialEvent({
        credentialId: row.credential_id,
        projectId: opts.projectId,
        eventType: 'materialize_skip_existing_env',
        actorUserId: opts.userId,
        provider: row.provider,
        targetType: 'runtime_box_file',
        targetRef: { env_name: classified.envName, kind: row.kind },
        status: 'ok',
        message: 'Runtime Box file credential path env already supplied by caller; vault value not read',
      });
      continue;
    }

    try {
      const value = await resolveProjectBoundSecret({ secretName: row.secret_name, userId: opts.userId, scope: row.scope, ownerUserId: row.owner_user_id, mode: row.mode });
      materialize.push({
        credentialId: row.credential_id,
        envName: classified.envName,
        fileName: classified.fileName,
        mode: classified.mode,
        credentialType: classified.credentialType,
        value,
      });
      await auditCredentialEvent({
        credentialId: row.credential_id,
        projectId: opts.projectId,
        eventType: 'materialize',
        actorUserId: opts.userId,
        provider: row.provider,
        targetType: 'runtime_box_file',
        targetRef: { env_name: classified.envName, kind: row.kind, credential_type: classified.credentialType },
        status: 'ok',
        message: 'Runtime Box file credential materialized for one command',
      });
    } catch (err: any) {
      await auditCredentialEvent({
        credentialId: row.credential_id,
        projectId: opts.projectId,
        eventType: 'materialize',
        actorUserId: opts.userId,
        provider: row.provider,
        targetType: 'runtime_box_file',
        targetRef: { env_name: classified.envName, kind: row.kind, credential_type: classified.credentialType },
        status: 'denied',
        errorCode: err?.name ?? 'SecretResolutionError',
        message: `Runtime Box file credential materialization failed: ${err?.name ?? 'SecretResolutionError'}`,
      });
      skipped.push({
        credentialId: row.credential_id,
        envName: classified.envName,
        reason: `credential unavailable to current user; skipped without blocking unrelated Runtime Box credentials (${err?.name ?? 'SecretResolutionError'})`,
      });
    }
  }

  return { materialize, skipped };
}

/**
 * Resolve one project-granted API-key credential as an env-style secret value.
 *
 * This is for first-class Pi tools that run in the backend process, not inside a
 * Runtime Box command. It keeps the same policy gate as Runtime Box env
 * materialization: the project must explicitly allow/override/inherit the
 * credential. For explicit personal-scope Agent bindings, the project binding is
 * the Runtime authority and owner_user_id only locates the legacy secret row.
 */
export async function resolveProjectApiKeySecretValue(opts: {
  projectId: string;
  userId: number;
  envName: string;
  targetType: string;
}): Promise<ProjectApiKeySecretResolution | null> {
  assertSecretName(opts.envName);

  const rows = await query<{
    credential_id: string;
    provider: string;
    secret_name: string;
    env_name: string;
    scope: CredentialVaultScope;
    owner_user_id: number | null;
    mode: string;
  }>(
    `SELECT c.id AS credential_id,
            c.provider,
            c.secret_name,
            COALESCE(p.target_env_name, c.default_env_name, c.secret_name) AS env_name,
            c.scope,
            c.owner_user_id,
            COALESCE(p.mode, 'inherit') AS mode
       FROM workspace_credentials c
       LEFT JOIN project_credential_policies p
         ON p.credential_id = c.id AND p.project_id = $1
       LEFT JOIN workspace_connection_defaults d
         ON d.connection_id = 'credential:' || c.id
       JOIN (
         SELECT p.*, s.slug AS space_slug
           FROM projects p LEFT JOIN spaces s ON s.id = p.space_id
          WHERE p.id = $1
       ) prj ON true
      WHERE c.kind = 'api_key'
        AND c.enabled = true
        AND ${allowedProjectCredentialWhere('c', 'p', 'd', 'prj')}
        AND COALESCE(p.target_env_name, c.default_env_name, c.secret_name) = $2
      ORDER BY c.id
      LIMIT 1`,
    [opts.projectId, opts.envName],
  );

  const row = rows[0];
  if (!row) return null;

  try {
    const value = await resolveProjectBoundSecret({ secretName: row.secret_name, userId: opts.userId, scope: row.scope, ownerUserId: row.owner_user_id, mode: row.mode });
    await auditCredentialEvent({
      credentialId: row.credential_id,
      projectId: opts.projectId,
      eventType: 'materialize',
      actorUserId: opts.userId,
      provider: row.provider,
      targetType: opts.targetType,
      targetRef: { env_name: opts.envName },
      status: 'ok',
      message: 'Project API-key secret materialized for one Pi tool call',
    });
    return { credentialId: row.credential_id, envName: opts.envName, value };
  } catch (err: any) {
    await auditCredentialEvent({
      credentialId: row.credential_id,
      projectId: opts.projectId,
      eventType: 'materialize',
      actorUserId: opts.userId,
      provider: row.provider,
      targetType: opts.targetType,
      targetRef: { env_name: opts.envName },
      status: 'denied',
      errorCode: err?.name ?? 'SecretResolutionError',
      message: `Project API-key secret materialization failed: ${err?.name ?? 'SecretResolutionError'}`,
    });
    throw new Error(`credential '${row.credential_id}' is allowed for project but unavailable to user ${opts.userId}`);
  }
}

/**
 * Resolve one project-granted credential secret value by id/kind/provider.
 *
 * This is for non-env materializers (for example CLI config bundles) that still
 * need the same Credential Vault project policy gate as API-key env injection.
 * Secret values remain command-scoped: callers must materialize into a temp
 * location and clean it up after the single Runtime Box exec.
 */
export async function resolveProjectCredentialSecretValue(opts: {
  projectId: string;
  userId: number;
  credentialId: string;
  kind?: string;
  provider?: string;
  targetType: string;
}): Promise<ProjectCredentialSecretResolution | null> {
  assertCredentialId(opts.credentialId);

  const rows = await query<{
    credential_id: string;
    provider: string;
    kind: string;
    secret_name: string;
    scope: CredentialVaultScope;
    owner_user_id: number | null;
    mode: string;
  }>(
    `SELECT c.id AS credential_id,
            c.provider,
            c.kind,
            c.secret_name,
            c.scope,
            c.owner_user_id,
            COALESCE(p.mode, 'inherit') AS mode
       FROM workspace_credentials c
       LEFT JOIN project_credential_policies p
         ON p.credential_id = c.id AND p.project_id = $1
       LEFT JOIN workspace_connection_defaults d
         ON d.connection_id = 'credential:' || c.id
       JOIN (
         SELECT p.*, s.slug AS space_slug
           FROM projects p LEFT JOIN spaces s ON s.id = p.space_id
          WHERE p.id = $1
       ) prj ON true
      WHERE c.id = $2
        AND c.enabled = true
        AND ($3::text IS NULL OR c.kind = $3)
        AND ($4::text IS NULL OR c.provider = $4)
        AND ${allowedProjectCredentialWhere('c', 'p', 'd', 'prj')}
      LIMIT 1`,
    [opts.projectId, opts.credentialId, opts.kind ?? null, opts.provider ?? null],
  );

  const row = rows[0];
  if (!row) return null;

  try {
    const value = await resolveProjectBoundSecret({ secretName: row.secret_name, userId: opts.userId, scope: row.scope, ownerUserId: row.owner_user_id, mode: row.mode });
    await auditCredentialEvent({
      credentialId: row.credential_id,
      projectId: opts.projectId,
      eventType: 'materialize',
      actorUserId: opts.userId,
      provider: row.provider,
      targetType: opts.targetType,
      targetRef: { credential_id: row.credential_id, kind: row.kind },
      status: 'ok',
      message: 'Project credential secret materialized for one Runtime Box command',
    });
    return {
      credentialId: row.credential_id,
      provider: row.provider,
      kind: row.kind,
      secretName: row.secret_name,
      value,
    };
  } catch (err: any) {
    await auditCredentialEvent({
      credentialId: row.credential_id,
      projectId: opts.projectId,
      eventType: 'materialize',
      actorUserId: opts.userId,
      provider: row.provider,
      targetType: opts.targetType,
      targetRef: { credential_id: row.credential_id, kind: row.kind },
      status: 'denied',
      errorCode: err?.name ?? 'SecretResolutionError',
      message: `Project credential secret materialization failed: ${err?.name ?? 'SecretResolutionError'}`,
    });
    throw new Error(`credential '${row.credential_id}' is allowed for project but unavailable to user ${opts.userId}`);
  }
}

/** List credential metadata without secret values. */
export async function listWorkspaceCredentials(opts?: {
  userId?: number;
  includePersonal?: boolean;
  personalOnly?: boolean;
}): Promise<WorkspaceCredentialRow[]> {
  if (opts?.personalOnly) {
    if (!opts.userId) throw new Error('userId required for personal credential list');
    return query<WorkspaceCredentialRow>(
      `SELECT * FROM workspace_credentials
        WHERE scope = 'personal' AND owner_user_id = $1
        ORDER BY provider, id`,
      [opts.userId],
    );
  }
  if (opts?.includePersonal && opts.userId) {
    return query<WorkspaceCredentialRow>(
      `SELECT * FROM workspace_credentials
        WHERE scope <> 'personal' OR owner_user_id = $1
        ORDER BY provider, id`,
      [opts.userId],
    );
  }
  return query<WorkspaceCredentialRow>(
    `SELECT * FROM workspace_credentials WHERE scope <> 'personal' ORDER BY provider, id`,
  );
}

export const CREDENTIAL_TYPES: CredentialType[] = [
  {
    id: 'api_key',
    provider: 'custom',
    label: 'API key / token',
    description: '단일 API key나 token을 Runtime Box 명령 실행 때 환경변수로 주입합니다.',
    materialization: 'env',
    secretFieldId: 'secret_value',
    defaultCredentialId: 'custom-api-key',
    defaultDisplayName: '사용자 지정 API key',
    defaultSecretName: 'CUSTOM_API_KEY',
    defaultEnvName: 'CUSTOM_API_KEY',
    fields: [
      { id: 'secret_value', label: 'API key / token', required: true, secret: true, placeholder: 'secret value' },
    ],
  },
  {
    id: 'ssh_private_key',
    provider: 'ssh',
    label: 'SSH private key',
    description: 'SSH 개인키를 Vault에 저장하고 Runtime Box 명령 실행 때 0600 임시 key file 경로로 제공합니다.',
    materialization: 'file',
    secretFieldId: 'private_key',
    defaultCredentialId: 'customer-ssh-private-key',
    defaultDisplayName: 'Customer SSH private key',
    defaultSecretName: 'CUSTOMER_SSH_PRIVATE_KEY',
    defaultEnvName: 'CUSTOMER_SSH_PRIVATE_KEY',
    defaultPathEnvName: 'CUSTOMER_SSH_KEY_FILE',
    defaultFilename: 'id_ssh',
    defaultMode: '0600',
    fields: [
      { id: 'private_key', label: 'Private key', required: true, secret: true, multiline: true, placeholder: 'Paste private key here' },
      { id: 'host', label: 'Host optional', required: false, secret: false, placeholder: '203.0.113.10' },
      { id: 'username', label: 'Username optional', required: false, secret: false, placeholder: 'azureuser' },
      { id: 'fingerprint', label: 'Fingerprint optional', required: false, secret: false },
    ],
  },
  {
    id: 'kubeconfig',
    provider: 'kubernetes',
    label: 'Kubernetes kubeconfig',
    description: 'kubeconfig YAML을 Vault에 저장하고 Runtime Box에서는 KUBECONFIG 임시 파일로 제공합니다.',
    materialization: 'file',
    secretFieldId: 'config',
    defaultCredentialId: 'kubeconfig-default',
    defaultDisplayName: 'Kubernetes kubeconfig',
    defaultSecretName: 'KUBECONFIG_SECRET',
    defaultEnvName: 'KUBECONFIG_SECRET',
    defaultPathEnvName: 'KUBECONFIG',
    defaultFilename: 'config',
    defaultMode: '0600',
    fields: [
      { id: 'config', label: 'kubeconfig YAML', required: true, secret: true, multiline: true, placeholder: 'apiVersion: v1' },
      { id: 'cluster', label: 'Cluster name optional', required: false, secret: false },
    ],
  },
  {
    id: 'certificate',
    provider: 'tls',
    label: 'Certificate / PEM file',
    description: '인증서·PEM·service account JSON 같은 파일형 secret을 Runtime Box 임시 파일 경로로 제공합니다.',
    materialization: 'file',
    secretFieldId: 'pem',
    defaultCredentialId: 'certificate-pem',
    defaultDisplayName: 'Certificate / PEM file',
    defaultSecretName: 'CERTIFICATE_PEM',
    defaultEnvName: 'CERTIFICATE_PEM',
    defaultPathEnvName: 'CERTIFICATE_FILE',
    defaultFilename: 'credential.pem',
    defaultMode: '0600',
    fields: [
      { id: 'pem', label: 'PEM / JSON content', required: true, secret: true, multiline: true, placeholder: '-----BEGIN CERTIFICATE----- 또는 JSON' },
      { id: 'purpose', label: 'Purpose optional', required: false, secret: false },
    ],
  },
];

export function listCredentialTypes(): CredentialType[] {
  return CREDENTIAL_TYPES;
}

function credentialTypeById(typeId: string): CredentialType {
  const type = CREDENTIAL_TYPES.find((t) => t.id === typeId);
  if (!type) throw new Error(`unsupported credential type: ${typeId}`);
  return type;
}

export const CREDENTIAL_BUNDLE_TYPES: CredentialBundleType[] = [
  {
    id: 'web-login',
    provider: 'web-login',
    profileType: 'custom',
    label: 'Website login username/password',
    description: '공식 API가 없는 웹사이트 자동화에 필요한 로그인 ID/이메일과 비밀번호를 한 세트로 저장하고 Runtime Box에 별도 환경변수로 주입합니다.',
    defaultInstanceId: 'web-login-main',
    defaultDisplayName: 'Website login account',
    fields: [
      { id: 'username', label: 'Username / email', envName: 'WEB_LOGIN_USERNAME', required: true, secret: true, envNameEditable: true, placeholder: 'user@example.com' },
      { id: 'password', label: 'Password', envName: 'WEB_LOGIN_PASSWORD', required: true, secret: true, envNameEditable: true, placeholder: 'password' },
    ],
  },
  {
    id: 'aligo-sms',
    provider: 'aligo',
    profileType: 'custom',
    label: 'Aligo SMS',
    description: '알리고 SMS 발송에 필요한 API key, 사용자 ID, 발신번호를 하나의 Runtime Box 연결로 저장합니다.',
    defaultInstanceId: 'aligo-main',
    defaultDisplayName: 'Aligo SMS 기본 연결',
    fields: [
      { id: 'api_key', label: 'API key', envName: 'ALIGO_API_KEY', required: true, secret: true, placeholder: '알리고 API key' },
      { id: 'user_id', label: 'User ID', envName: 'ALIGO_USER_ID', required: true, secret: true, placeholder: '알리고 로그인 ID' },
      { id: 'sender', label: '발신번호', envName: 'ALIGO_SENDER', required: true, secret: true, placeholder: '등록된 발신번호' },
    ],
  },
  {
    id: 'custom-env-bundle',
    provider: 'custom',
    profileType: 'custom',
    label: 'Custom env bundle',
    description: '여러 secret/public 환경변수를 하나의 credential profile로 묶어 Runtime Box에 주입합니다.',
    defaultInstanceId: 'custom-env-main',
    defaultDisplayName: 'Custom env bundle',
    fields: [
      { id: 'api_key', label: 'API key / token', envName: 'CUSTOM_API_KEY', required: true, secret: true, placeholder: 'secret value' },
      { id: 'base_url', label: 'Base URL', envName: 'CUSTOM_BASE_URL', required: false, secret: false, placeholder: 'https://api.example.com' },
    ],
  },
];

export function listCredentialBundleTypes(): CredentialBundleType[] {
  return CREDENTIAL_BUNDLE_TYPES;
}

function credentialBundleTypeById(typeId: string): CredentialBundleType {
  const type = CREDENTIAL_BUNDLE_TYPES.find((t) => t.id === typeId);
  if (!type) throw new Error(`unsupported credential bundle type: ${typeId}`);
  return type;
}

/** List connection profiles without secret values. */
export async function listCredentialProfiles(): Promise<CredentialProfileRow[]> {
  return query<CredentialProfileRow>(
    `SELECT * FROM credential_profiles ORDER BY provider, id`,
  );
}

/** Rotate an existing Credential value while preserving its ID, metadata, scope, and project policies. */
export async function rotateExistingCredential(opts: {
  credentialId: string;
  secretValue: string;
  actorUserId: number;
}): Promise<WorkspaceCredentialRow> {
  const existing = await queryOne<WorkspaceCredentialRow>(
    `SELECT * FROM workspace_credentials WHERE id = $1 AND enabled = true`,
    [opts.credentialId],
  );
  if (!existing) throw new Error('Credential not found');
  const normalized = normalizeSecretInput(opts.secretValue, inferSecretPolicy({
    provider: existing.provider,
    fieldId: String(existing.metadata?.field_id ?? 'api_key'),
    envName: existing.default_env_name ?? existing.secret_name,
    credentialType: String(existing.metadata?.credential_type ?? existing.kind),
  }));
  await setSecret({
    name: existing.secret_name,
    value: normalized.value,
    scope: existing.scope === 'personal' ? 'user' : 'global',
    ownerUserId: existing.owner_user_id ?? undefined,
    description: `${existing.scope === 'personal' ? 'Personal' : 'Workspace'} Credential Vault: ${existing.id}`,
    createdBy: opts.actorUserId,
  });
  const updated = await queryOne<WorkspaceCredentialRow>(
    `UPDATE workspace_credentials
        SET metadata = metadata || $2::jsonb, rotated_at = now(), updated_at = now(), updated_by = $3
      WHERE id = $1 RETURNING *`,
    [opts.credentialId, JSON.stringify({ input_normalizations: normalized.normalizations }), opts.actorUserId],
  );
  await auditCredentialEvent({
    credentialId: opts.credentialId,
    eventType: 'credential_rotated',
    actorUserId: opts.actorUserId,
    provider: existing.provider,
    targetType: 'secret_store',
    targetRef: { preserved_credential_id: true, preserved_project_policies: true },
    message: 'Credential value rotated; metadata identity and project policy rows preserved',
  });
  return updated!;
}

/** Create or rotate an API-key credential; stores the secret value in secret_store only. */
export async function upsertApiKeyCredential(opts: {
  id: string;
  provider: string;
  displayName: string;
  secretName: string;
  secretValue: string;
  defaultEnvName?: string;
  scope?: CredentialVaultScope;
  ownerUserId?: number | null;
  metadata?: Record<string, unknown>;
  actorUserId: number;
}): Promise<WorkspaceCredentialRow> {
  assertCredentialId(opts.id);
  assertSecretName(opts.secretName);
  if (opts.defaultEnvName) assertSecretName(opts.defaultEnvName);
  if (!opts.secretValue) throw new Error('secret value is empty');

  const scope = opts.scope ?? 'workspace';
  const ownerUserId = scope === 'personal' ? (opts.ownerUserId ?? opts.actorUserId) : null;
  if (scope === 'personal' && !ownerUserId) throw new Error('personal credential requires ownerUserId');
  if (scope !== 'personal' && opts.ownerUserId) throw new Error('ownerUserId is only allowed for personal credentials');

  const existing = await queryOne<Pick<WorkspaceCredentialRow, 'id' | 'provider' | 'secret_name' | 'default_env_name' | 'scope' | 'owner_user_id'>>(
    `SELECT id, provider, secret_name, default_env_name, scope, owner_user_id FROM workspace_credentials WHERE id = $1`,
    [opts.id],
  );
  if (existing) {
    const nextEnvName = opts.defaultEnvName ?? opts.secretName;
    if (
      existing.provider !== opts.provider ||
      existing.secret_name !== opts.secretName ||
      existing.default_env_name !== nextEnvName ||
      existing.scope !== scope ||
      (existing.owner_user_id ?? null) !== (ownerUserId ?? null)
    ) {
      throw new Error(
        `credential id '${opts.id}' already exists for ${existing.provider}/${existing.secret_name}; use a new Credential ID or rotate with the same service/env names`,
      );
    }
  }

  const normalizedSecret = normalizeSecretInput(opts.secretValue, inferSecretPolicy({
    provider: opts.provider,
    fieldId: String(opts.metadata?.field_id ?? 'api_key'),
    envName: opts.defaultEnvName ?? opts.secretName,
    credentialType: String(opts.metadata?.credential_type ?? ''),
  }));

  await setSecret({
    name: opts.secretName,
    value: normalizedSecret.value,
    scope: scope === 'personal' ? 'user' : 'global',
    ownerUserId: ownerUserId ?? undefined,
    description: `${scope === 'personal' ? 'Personal' : 'Workspace'} Credential Vault: ${opts.id}`,
    createdBy: opts.actorUserId,
  });

  const rows = await query<WorkspaceCredentialRow>(
    `INSERT INTO workspace_credentials
       (id, kind, provider, display_name, secret_name, default_env_name,
        scope, owner_user_id, metadata, created_by, updated_by, rotated_at)
     VALUES ($1, 'api_key', $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $9, now())
     ON CONFLICT (id) DO UPDATE SET
       provider = EXCLUDED.provider,
       display_name = EXCLUDED.display_name,
       secret_name = EXCLUDED.secret_name,
       default_env_name = EXCLUDED.default_env_name,
       scope = EXCLUDED.scope,
       owner_user_id = EXCLUDED.owner_user_id,
       metadata = EXCLUDED.metadata,
       enabled = true,
       updated_at = now(),
       updated_by = EXCLUDED.updated_by,
       rotated_at = now()
     RETURNING *`,
    [
      opts.id,
      opts.provider,
      opts.displayName,
      opts.secretName,
      opts.defaultEnvName ?? opts.secretName,
      scope,
      ownerUserId,
      JSON.stringify({ ...(opts.metadata ?? {}), input_normalizations: normalizedSecret.normalizations }),
      opts.actorUserId,
    ],
  );

  await auditCredentialEvent({
    credentialId: opts.id,
    eventType: 'upsert_api_key',
    actorUserId: opts.actorUserId,
    provider: opts.provider,
    status: 'ok',
    message: `${scope === 'personal' ? 'Personal' : 'Workspace'} API key credential metadata upserted; value stored in secret_store`,
  });

  return rows[0];
}

/** Create or rotate an organization-owned Google Workspace config bundle. */
export async function upsertOrganizationGwsCredential(opts: {
  credentialId: string;
  displayName: string;
  secretName: string;
  encodedConfig: string;
  googleAccount: string;
  actorUserId: number;
}): Promise<WorkspaceCredentialRow> {
  assertCredentialId(opts.credentialId);
  assertSecretName(opts.secretName);
  if (!opts.encodedConfig) throw new Error('Google Workspace config bundle is empty');

  const existing = await queryOne<Pick<WorkspaceCredentialRow, 'id' | 'kind' | 'provider' | 'secret_name' | 'scope' | 'metadata'>>(
    `SELECT id, kind, provider, secret_name, scope, metadata FROM workspace_credentials WHERE id = $1`,
    [opts.credentialId],
  );
  if (existing && (
    existing.kind !== 'gws' ||
    existing.provider !== 'google' ||
    existing.secret_name !== opts.secretName ||
    existing.scope !== 'workspace' ||
    (existing.metadata as any)?.connection_type !== 'organization'
  )) {
    throw new Error(`credential id '${opts.credentialId}' is already used by another Credential type`);
  }

  await setSecret({
    name: opts.secretName,
    value: opts.encodedConfig,
    scope: 'global',
    description: `Organization Google Workspace Credential Vault: ${opts.credentialId}`,
    createdBy: opts.actorUserId,
  });

  const rows = await query<WorkspaceCredentialRow>(
    `INSERT INTO workspace_credentials
       (id, kind, provider, display_name, secret_name, default_env_name,
        scope, owner_user_id, metadata, created_by, updated_by, rotated_at)
     VALUES ($1, 'gws', 'google', $2, $3, NULL, 'workspace', NULL, $4::jsonb, $5, $5, now())
     ON CONFLICT (id) DO UPDATE SET
       kind = 'gws', provider = 'google', display_name = EXCLUDED.display_name,
       secret_name = EXCLUDED.secret_name, default_env_name = NULL,
       scope = 'workspace', owner_user_id = NULL,
       metadata = COALESCE(workspace_credentials.metadata, '{}'::jsonb) || EXCLUDED.metadata,
       enabled = true, updated_at = now(), updated_by = EXCLUDED.updated_by, rotated_at = now()
     RETURNING *`,
    [opts.credentialId, opts.displayName, opts.secretName, JSON.stringify({
      connection_type: 'organization',
      credential_type_id: 'google_oauth',
      google_account: opts.googleAccount,
      created_via: 'organization_google_oauth',
    }), opts.actorUserId],
  );

  await auditCredentialEvent({
    credentialId: opts.credentialId,
    eventType: 'organization_gws_oauth_upsert',
    actorUserId: opts.actorUserId,
    provider: 'google',
    targetType: 'runtime_box_gws_config',
    status: 'ok',
    message: 'Organization Google Workspace Credential updated without changing Agent policies or exposing OAuth material',
  });
  return rows[0];
}

/** Create or rotate an Agent-owned Google Workspace config bundle. */
export async function upsertAgentGwsCredential(opts: {
  projectId: string;
  credentialId: string;
  displayName: string;
  secretName: string;
  encodedConfig: string;
  googleAccount: string;
  actorUserId: number;
}): Promise<WorkspaceCredentialRow> {
  assertCredentialId(opts.credentialId);
  assertSecretName(opts.secretName);
  if (!opts.encodedConfig) throw new Error('Google Workspace config bundle is empty');

  const existing = await queryOne<Pick<WorkspaceCredentialRow, 'id' | 'kind' | 'provider' | 'secret_name' | 'scope'>>(
    `SELECT id, kind, provider, secret_name, scope FROM workspace_credentials WHERE id = $1`,
    [opts.credentialId],
  );
  if (existing && (
    existing.kind !== 'gws' ||
    existing.provider !== 'google' ||
    existing.secret_name !== opts.secretName ||
    existing.scope !== 'project'
  )) {
    throw new Error(`credential id '${opts.credentialId}' is already used by another Credential type`);
  }

  await setSecret({
    name: opts.secretName,
    value: opts.encodedConfig,
    scope: 'global',
    description: `Agent Google Workspace Credential Vault: ${opts.credentialId}`,
    createdBy: opts.actorUserId,
  });

  const rows = await query<WorkspaceCredentialRow>(
    `INSERT INTO workspace_credentials
       (id, kind, provider, display_name, secret_name, default_env_name,
        scope, owner_user_id, metadata, created_by, updated_by, rotated_at)
     VALUES ($1, 'gws', 'google', $2, $3, NULL, 'project', NULL, $4::jsonb, $5, $5, now())
     ON CONFLICT (id) DO UPDATE SET
       kind = 'gws',
       provider = 'google',
       display_name = EXCLUDED.display_name,
       secret_name = EXCLUDED.secret_name,
       default_env_name = NULL,
       scope = 'project',
       owner_user_id = NULL,
       metadata = EXCLUDED.metadata,
       enabled = true,
       updated_at = now(),
       updated_by = EXCLUDED.updated_by,
       rotated_at = now()
     RETURNING *`,
    [
      opts.credentialId,
      opts.displayName,
      opts.secretName,
      JSON.stringify({
        connection_type: 'agent',
        agent_project_id: opts.projectId,
        credential_type_id: 'google_oauth',
        google_account: opts.googleAccount,
        created_via: 'agent_google_oauth',
      }),
      opts.actorUserId,
    ],
  );

  await execute(
    `UPDATE project_credential_policies
        SET metadata = COALESCE(metadata, '{}'::jsonb) - 'runtime_default', updated_at = now(), updated_by = $2
      WHERE project_id = $1 AND credential_id <> $3 AND COALESCE((metadata->>'runtime_default')::boolean, false) = true`,
    [opts.projectId, opts.actorUserId, opts.credentialId],
  );
  await setProjectCredentialPolicy({
    projectId: opts.projectId,
    credentialId: opts.credentialId,
    mode: 'allow',
    metadata: { agent_connection: true, created_via: 'agent_google_oauth', runtime_default: true },
    actorUserId: opts.actorUserId,
  });
  await auditCredentialEvent({
    credentialId: opts.credentialId,
    projectId: opts.projectId,
    eventType: 'agent_gws_oauth_upsert',
    actorUserId: opts.actorUserId,
    provider: 'google',
    targetType: 'runtime_box_gws_config',
    status: 'ok',
    message: 'Agent Google Workspace Credential updated and bound without exposing OAuth material',
  });
  return rows[0];
}

/** Create or rotate an SSH private key credential and optionally grant it to a project. */
export async function upsertSshPrivateKeyCredential(opts: {
  id: string;
  displayName: string;
  secretName: string;
  privateKey: string;
  defaultEnvName?: string;
  pathEnvName?: string;
  projectId?: string | null;
  scope?: CredentialVaultScope;
  ownerUserId?: number | null;
  host?: string;
  username?: string;
  fingerprint?: string;
  filename?: string;
  mode?: string;
  actorUserId: number;
}): Promise<SshPrivateKeyCredentialUpsertResult> {
  const defaultEnvName = opts.defaultEnvName ?? opts.secretName;
  const pathEnvName = opts.pathEnvName ?? credentialFileEnvNameForDefaultEnv(defaultEnvName);
  const mode = opts.mode ?? '0600';
  assertSecretName(pathEnvName);
  if (!/^0?[0-7]{3}$/.test(mode)) throw new Error('invalid file mode');
  if (!opts.privateKey || !opts.privateKey.trim()) throw new Error('private key is empty');

  const normalizedPrivateKey = opts.privateKey.endsWith('\n') ? opts.privateKey : `${opts.privateKey}\n`;
  const materialization = {
    type: 'file',
    env_name: pathEnvName,
    filename: safeCredentialFileName(opts.filename ?? 'id_ssh'),
    mode,
  };
  const metadata: Record<string, unknown> = {
    credential_type: 'ssh_private_key',
    materialization,
    path_env_name: pathEnvName,
  };
  if (opts.host?.trim()) metadata.host = opts.host.trim();
  if (opts.username?.trim()) metadata.username = opts.username.trim();
  if (opts.fingerprint?.trim()) metadata.fingerprint = opts.fingerprint.trim();

  const credential = await upsertApiKeyCredential({
    id: opts.id,
    provider: 'ssh',
    displayName: opts.displayName,
    secretName: opts.secretName,
    secretValue: normalizedPrivateKey,
    defaultEnvName,
    scope: opts.scope ?? (opts.projectId ? 'project' : 'workspace'),
    ownerUserId: opts.ownerUserId,
    metadata,
    actorUserId: opts.actorUserId,
  });

  if (opts.projectId) {
    await setProjectCredentialPolicy({
      projectId: opts.projectId,
      credentialId: opts.id,
      mode: 'allow',
      targetEnvName: defaultEnvName,
      metadata: { credential_type: 'ssh_private_key', materialization_type: 'file', path_env_name: pathEnvName },
      actorUserId: opts.actorUserId,
    });
  }

  await auditCredentialEvent({
    credentialId: opts.id,
    projectId: opts.projectId ?? null,
    eventType: 'ssh_private_key_upsert',
    actorUserId: opts.actorUserId,
    provider: 'ssh',
    targetType: 'runtime_box_env',
    targetRef: { path_env_name: pathEnvName, filename: materialization.filename, mode },
    status: 'ok',
    message: 'SSH private key credential metadata upserted; value stored in secret_store and materialized as a temp file at runtime',
  });

  return { credential, grantedProjectId: opts.projectId ?? null, pathEnvName };
}

/** Create or rotate any registry-backed typed credential. */
export async function upsertTypedCredential(opts: {
  typeId: string;
  id: string;
  displayName: string;
  secretName: string;
  values: Record<string, string>;
  defaultEnvName?: string;
  pathEnvName?: string;
  projectId?: string | null;
  scope?: CredentialVaultScope;
  ownerUserId?: number | null;
  filename?: string;
  mode?: string;
  actorUserId: number;
}): Promise<TypedCredentialUpsertResult> {
  const type = credentialTypeById(opts.typeId);
  const secretValue = String(opts.values?.[type.secretFieldId] ?? '');
  if (!secretValue.trim()) throw new Error(`${type.secretFieldId} required`);

  if (type.id === 'ssh_private_key') {
    const result = await upsertSshPrivateKeyCredential({
      id: opts.id,
      displayName: opts.displayName,
      secretName: opts.secretName,
      privateKey: secretValue,
      defaultEnvName: opts.defaultEnvName,
      pathEnvName: opts.pathEnvName,
      projectId: opts.projectId,
      scope: opts.scope,
      ownerUserId: opts.ownerUserId,
      host: opts.values.host,
      username: opts.values.username,
      fingerprint: opts.values.fingerprint,
      filename: opts.filename,
      mode: opts.mode,
      actorUserId: opts.actorUserId,
    });
    return {
      credential: result.credential,
      grantedProjectId: result.grantedProjectId,
      envName: result.credential.default_env_name ?? opts.defaultEnvName ?? opts.secretName,
      pathEnvName: result.pathEnvName,
    };
  }

  const defaultEnvName = opts.defaultEnvName ?? type.defaultEnvName;
  const materializationType = type.materialization;
  const pathEnvName = materializationType === 'file'
    ? (opts.pathEnvName ?? type.defaultPathEnvName ?? credentialFileEnvNameForDefaultEnv(defaultEnvName))
    : null;
  if (pathEnvName) assertSecretName(pathEnvName);
  const mode = opts.mode ?? type.defaultMode ?? '0600';
  if (materializationType === 'file' && !/^0?[0-7]{3}$/.test(mode)) throw new Error('invalid file mode');

  const metadata: Record<string, unknown> = {
    credential_type: type.id,
    type_label: type.label,
  };
  if (materializationType === 'file') {
    metadata.materialization = {
      type: 'file',
      env_name: pathEnvName,
      filename: safeCredentialFileName(opts.filename ?? type.defaultFilename ?? opts.id),
      mode,
    };
    metadata.path_env_name = pathEnvName;
  }
  for (const field of type.fields) {
    if (field.secret) continue;
    const value = String(opts.values?.[field.id] ?? '').trim();
    if (value) metadata[field.id] = value;
  }

  const credential = await upsertApiKeyCredential({
    id: opts.id,
    provider: type.provider,
    displayName: opts.displayName,
    secretName: opts.secretName,
    secretValue,
    defaultEnvName,
    scope: opts.scope ?? (opts.projectId ? 'project' : 'workspace'),
    ownerUserId: opts.ownerUserId,
    metadata,
    actorUserId: opts.actorUserId,
  });

  if (opts.projectId) {
    await setProjectCredentialPolicy({
      projectId: opts.projectId,
      credentialId: opts.id,
      mode: 'allow',
      targetEnvName: defaultEnvName,
      metadata: pathEnvName
        ? { credential_type: type.id, materialization_type: 'file', path_env_name: pathEnvName }
        : { credential_type: type.id },
      actorUserId: opts.actorUserId,
    });
  }

  await auditCredentialEvent({
    credentialId: opts.id,
    projectId: opts.projectId ?? null,
    eventType: 'typed_credential_upsert',
    actorUserId: opts.actorUserId,
    provider: type.provider,
    targetType: 'runtime_box_env',
    targetRef: { credential_type: type.id, env_name: defaultEnvName, path_env_name: pathEnvName },
    status: 'ok',
    message: 'Typed credential metadata upserted; secret value stored in secret_store',
  });

  return { credential, grantedProjectId: opts.projectId ?? null, envName: defaultEnvName, pathEnvName };
}

function validateCredentialSecretShape(credentialType: string, value: string): CredentialMaterializationTestResult['checks'] {
  const trimmed = value.trim();
  const checks: CredentialMaterializationTestResult['checks'] = [
    { name: 'secret_present', ok: trimmed.length > 0, message: trimmed.length > 0 ? 'secret value is present' : 'secret value is empty' },
  ];
  if (credentialType === 'ssh_private_key') {
    checks.push({
      name: 'ssh_private_key_shape',
      ok: /-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(value) && /-----END [A-Z ]*PRIVATE KEY-----/.test(value),
      message: 'OpenSSH/PEM private key boundary detected',
    });
  } else if (credentialType === 'kubeconfig') {
    checks.push({
      name: 'kubeconfig_shape',
      ok: /apiVersion\s*:\s*v1/.test(value) && /clusters\s*:/.test(value),
      message: 'kubeconfig-like YAML markers detected',
    });
  } else if (credentialType === 'certificate') {
    let isJson = false;
    try { JSON.parse(value); isJson = true; } catch {}
    checks.push({
      name: 'file_content_shape',
      ok: isJson || /-----BEGIN [A-Z ]+-----/.test(value),
      message: isJson ? 'JSON content detected' : 'PEM boundary detected',
    });
  }
  return checks;
}

/** Validate that a credential can be read and would materialize safely, without exposing its value. */
export async function testCredentialMaterialization(opts: {
  credentialId: string;
  userId: number;
}): Promise<CredentialMaterializationTestResult> {
  assertCredentialId(opts.credentialId);
  const credential = await queryOne<WorkspaceCredentialRow>(
    `SELECT * FROM workspace_credentials WHERE id = $1 AND enabled = true`,
    [opts.credentialId],
  );
  if (!credential) throw new Error(`credential '${opts.credentialId}' not found`);

  const fileCredential = classifyRuntimeBoxFileCredential({
    credentialId: credential.id,
    provider: credential.provider,
    kind: credential.kind,
    secretName: credential.secret_name,
    defaultEnvName: credential.default_env_name,
    targetEnvName: null,
    metadata: credential.metadata ?? {},
  });
  const envName = fileCredential?.envName ?? credential.default_env_name ?? credential.secret_name;
  assertSecretName(envName);

  let value = '';
  const checks: CredentialMaterializationTestResult['checks'] = [];
  try {
    value = await getSecret(credential.secret_name, opts.userId);
    checks.push({ name: 'vault_read', ok: true, message: 'secret_store read succeeded' });
  } catch (err: any) {
    checks.push({ name: 'vault_read', ok: false, message: err?.name ?? 'SecretResolutionError' });
  }
  if (value) checks.push(...validateCredentialSecretShape(fileCredential?.credentialType ?? String(credential.metadata?.credential_type ?? credential.kind), value));
  if (fileCredential) {
    checks.push({ name: 'file_env_name', ok: true, message: `${fileCredential.envName} will receive a temp file path` });
    checks.push({ name: 'file_mode', ok: fileCredential.mode === '0600' || fileCredential.mode === '0400', message: `file mode ${fileCredential.mode}` });
  }

  const ok = checks.every((check) => check.ok);
  await auditCredentialEvent({
    credentialId: credential.id,
    eventType: 'credential_materialization_test',
    actorUserId: opts.userId,
    provider: credential.provider,
    targetType: 'runtime_box_env',
    targetRef: { env_name: envName, materialization: fileCredential ? 'file' : 'env' },
    status: ok ? 'ok' : 'error',
    message: 'Credential materialization test completed without exposing secret value',
  });

  return {
    ok,
    credentialId: credential.id,
    credentialType: fileCredential?.credentialType ?? String(credential.metadata?.credential_type ?? credential.kind),
    materialization: fileCredential ? 'file' : 'env',
    envName,
    fileName: fileCredential?.fileName,
    mode: fileCredential?.mode,
    checks,
  };
}

/** Create/update a multi-field credential bundle backed by workspace credentials + a profile. */
export async function upsertCredentialBundle(opts: {
  typeId: string;
  instanceId: string;
  displayName: string;
  values: Record<string, string>;
  envNames?: Record<string, string>;
  projectId?: string | null;
  scope?: CredentialVaultScope;
  ownerUserId?: number | null;
  actorUserId: number;
}): Promise<CredentialBundleUpsertResult> {
  const type = credentialBundleTypeById(opts.typeId);
  const instancePart = credentialIdPart(opts.instanceId);
  const profileId = `${type.id}-${instancePart}`;
  assertCredentialId(profileId);

  const env: Record<string, string> = {};
  const secretRefs: Record<string, string> = {};
  const credentials: WorkspaceCredentialRow[] = [];
  const secretPrefix = secretNamePrefix(`${type.provider}_${instancePart}`);

  for (const field of type.fields) {
    assertSecretName(field.envName);
    const rawValue = String(opts.values?.[field.id] ?? '').trim();
    if (field.required && !rawValue) throw new Error(`${field.label} required`);
    if (!rawValue) continue;

    const envName = String(opts.envNames?.[field.id] || field.envName).trim();
    assertSecretName(envName);

    if (field.secret) {
      const fieldPart = credentialIdPart(field.id);
      const credentialId = `${profileId}-${fieldPart}`;
      const secretName = `${secretPrefix}_${envName}`.slice(0, 64);
      assertCredentialId(credentialId);
      assertSecretName(secretName);
      const credential = await upsertApiKeyCredential({
        id: credentialId,
        provider: type.provider,
        displayName: `${opts.displayName} · ${field.label}`,
        secretName,
        secretValue: rawValue,
        defaultEnvName: envName,
        scope: opts.scope ?? (opts.projectId ? 'project' : 'workspace'),
        ownerUserId: opts.ownerUserId,
        metadata: { bundle_type: type.id, bundle_profile_id: profileId, field_id: field.id, default_env_name: field.envName },
        actorUserId: opts.actorUserId,
      });
      credentials.push(credential);
      secretRefs[envName] = credentialId;
    } else {
      env[envName] = rawValue;
    }
  }

  const profile = await upsertCredentialProfile({
    id: profileId,
    profileType: type.profileType,
    provider: type.provider,
    displayName: opts.displayName,
    env,
    secretRefs,
    metadata: { bundle_type: type.id, instance_id: opts.instanceId },
    actorUserId: opts.actorUserId,
  });

  if (opts.projectId) {
    for (const [envName, credentialId] of Object.entries(secretRefs)) {
      await setProjectCredentialPolicy({
        projectId: opts.projectId,
        credentialId,
        mode: 'allow',
        targetEnvName: envName,
        metadata: { bundle_type: type.id, bundle_profile_id: profileId },
        actorUserId: opts.actorUserId,
      });
    }
    if (opts.scope !== 'personal') {
      await setProjectCredentialProfilePolicy({
        projectId: opts.projectId,
        profileId,
        mode: 'allow',
        metadata: { bundle_type: type.id, instance_id: opts.instanceId },
        actorUserId: opts.actorUserId,
      });
    }
  }

  await auditCredentialEvent({
    credentialId: null,
    projectId: opts.projectId ?? null,
    eventType: 'credential_bundle_upsert',
    actorUserId: opts.actorUserId,
    provider: type.provider,
    targetType: 'runtime_box_env',
    targetRef: { profile_id: profileId, bundle_type: type.id, env_names: Object.keys(env), secret_env_names: Object.keys(secretRefs) },
    status: 'ok',
    message: 'Credential bundle upserted; secret values stored separately and profile granted when projectId is set',
  });

  return { profile, credentials, grantedProjectId: opts.projectId ?? null };
}

function assertEnvBundle(env: Record<string, string>, label: string): void {
  for (const [name, value] of Object.entries(env)) {
    assertSecretName(name);
    if (typeof value !== 'string') throw new Error(`${label}.${name} must be a string`);
    if (/KEY|TOKEN|SECRET|PASSWORD|PRIVATE/i.test(name) && !String(value).startsWith('secretref:')) {
      throw new Error(`${label}.${name} looks secret-like; use secret_refs instead`);
    }
  }
}

/** Create/update a non-secret env + secretref connection profile. */
export async function upsertCredentialProfile(opts: {
  id: string;
  profileType: 'llm_backend' | 'cli_profile' | 'cloud_account' | 'ssh_connection' | 'custom';
  provider: string;
  displayName: string;
  env?: Record<string, string>;
  secretRefs?: Record<string, string>;
  metadata?: Record<string, unknown>;
  actorUserId: number;
}): Promise<CredentialProfileRow> {
  assertCredentialId(opts.id);
  const env = opts.env ?? {};
  const secretRefs = opts.secretRefs ?? {};
  assertEnvBundle(env, 'env');
  for (const [envName, credentialId] of Object.entries(secretRefs)) {
    assertSecretName(envName);
    assertCredentialId(credentialId);
  }

  const rows = await query<CredentialProfileRow>(
    `INSERT INTO credential_profiles
       (id, profile_type, provider, display_name, env, secret_refs, metadata, created_by, updated_by)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7::jsonb, $8, $8)
     ON CONFLICT (id) DO UPDATE SET
       profile_type = EXCLUDED.profile_type,
       provider = EXCLUDED.provider,
       display_name = EXCLUDED.display_name,
       env = EXCLUDED.env,
       secret_refs = EXCLUDED.secret_refs,
       metadata = EXCLUDED.metadata,
       enabled = true,
       updated_at = now(),
       updated_by = EXCLUDED.updated_by
     RETURNING *`,
    [
      opts.id,
      opts.profileType,
      opts.provider,
      opts.displayName,
      JSON.stringify(env),
      JSON.stringify(secretRefs),
      JSON.stringify(opts.metadata ?? {}),
      opts.actorUserId,
    ],
  );

  await auditCredentialEvent({
    credentialId: null,
    eventType: 'profile_upsert',
    actorUserId: opts.actorUserId,
    provider: opts.provider,
    targetType: 'runtime_box_env',
    targetRef: { profile_id: opts.id, env_names: Object.keys(env), secret_env_names: Object.keys(secretRefs) },
    status: 'ok',
    message: 'Credential profile upserted; env contains no secret values',
  });
  return rows[0];
}

/** Set a per-project credential profile policy row. */
export async function setProjectCredentialProfilePolicy(opts: {
  projectId: string;
  profileId: string;
  mode: 'allow' | 'deny';
  metadata?: Record<string, unknown>;
  actorUserId: number;
}): Promise<void> {
  await execute(
    `INSERT INTO project_credential_profile_policies
       (project_id, profile_id, mode, metadata, created_by, updated_by)
     VALUES ($1, $2, $3, $4::jsonb, $5, $5)
     ON CONFLICT (project_id, profile_id) DO UPDATE SET
       mode = EXCLUDED.mode,
       metadata = EXCLUDED.metadata,
       updated_at = now(),
       updated_by = EXCLUDED.updated_by`,
    [opts.projectId, opts.profileId, opts.mode, JSON.stringify(opts.metadata ?? {}), opts.actorUserId],
  );

  await auditCredentialEvent({
    credentialId: null,
    projectId: opts.projectId,
    eventType: `project_profile_policy_${opts.mode}`,
    actorUserId: opts.actorUserId,
    targetType: 'runtime_box_env',
    targetRef: { profile_id: opts.profileId },
    status: opts.mode === 'deny' ? 'denied' : 'ok',
  });
}

/** Set a per-project credential policy row. */
export async function setProjectCredentialPolicy(opts: {
  projectId: string;
  credentialId: string;
  mode: 'inherit' | 'allow' | 'deny' | 'override';
  targetEnvName?: string;
  metadata?: Record<string, unknown>;
  actorUserId: number;
}): Promise<void> {
  if (opts.targetEnvName) assertSecretName(opts.targetEnvName);

  await execute(
    `INSERT INTO project_credential_policies
       (project_id, credential_id, mode, target_env_name, metadata, created_by, updated_by)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6, $6)
     ON CONFLICT (project_id, credential_id) DO UPDATE SET
       mode = EXCLUDED.mode,
       target_env_name = EXCLUDED.target_env_name,
       metadata = EXCLUDED.metadata,
       updated_at = now(),
       updated_by = EXCLUDED.updated_by`,
    [
      opts.projectId,
      opts.credentialId,
      opts.mode,
      opts.targetEnvName ?? null,
      JSON.stringify(opts.metadata ?? {}),
      opts.actorUserId,
    ],
  );

  await auditCredentialEvent({
    credentialId: opts.credentialId,
    projectId: opts.projectId,
    eventType: `project_policy_${opts.mode}`,
    actorUserId: opts.actorUserId,
    status: opts.mode === 'deny' ? 'denied' : 'ok',
  });
}

/**
 * Resolve project-allowed API-key credentials into env vars for one Runtime Box command.
 *
 * MVP policy:
 * - workspace/internal-default credentials are inherited by default;
 * - project-scoped credentials require explicit `allow`, `override`, or `inherit`;
 * - explicit `deny` blocks inherited credentials;
 * - all eligible API keys are injected into the single docker exec, not persisted
 *   in the box filesystem;
 * - caller env wins for duplicate keys.
 */
export async function resolveRuntimeBoxApiKeyEnv(opts: {
  projectId: string;
  userId: number;
  existingEnv?: Record<string, string>;
}): Promise<RuntimeBoxApiKeyEnvResolution> {
  const rows = await query<{
    credential_id: string;
    provider: string;
    kind: string;
    secret_name: string;
    default_env_name: string | null;
    target_env_name: string | null;
    metadata: Record<string, unknown>;
    scope: CredentialVaultScope;
    owner_user_id: number | null;
    mode: string;
  }>(
    `SELECT c.id AS credential_id,
            c.provider,
            c.kind,
            c.secret_name,
            c.default_env_name,
            p.target_env_name,
            c.metadata,
            c.scope,
            c.owner_user_id,
            COALESCE(p.mode, 'inherit') AS mode
       FROM workspace_credentials c
       LEFT JOIN project_credential_policies p
         ON p.credential_id = c.id AND p.project_id = $1
       LEFT JOIN workspace_connection_defaults d
         ON d.connection_id = 'credential:' || c.id
       JOIN (
         SELECT p.*, s.slug AS space_slug
           FROM projects p LEFT JOIN spaces s ON s.id = p.space_id
          WHERE p.id = $1
       ) prj ON true
      WHERE c.kind = 'api_key'
        AND c.enabled = true
        AND ${allowedProjectCredentialWhere('c', 'p', 'd', 'prj')}
      ORDER BY CASE p.mode WHEN 'override' THEN 0 WHEN 'allow' THEN 1 WHEN 'inherit' THEN 2 ELSE 3 END,
               CASE c.scope WHEN 'project' THEN 0 WHEN 'workspace' THEN 1 WHEN 'personal' THEN 2 ELSE 3 END,
               c.id`,
    [opts.projectId],
  );

  if (rows.length === 0) {
    return { env: { ...(opts.existingEnv ?? {}) }, injected: [], skippedExisting: [], skipped: [] };
  }

  const vaultEnv: Array<{ credentialId: string; envName: string; value: string }> = [];
  const preExisting = opts.existingEnv ?? {};
  const skipped: RuntimeBoxCredentialSkippedItem[] = [];
  const claimedEnvNames = new Set<string>();

  for (const row of rows) {
    const fileCredential = classifyRuntimeBoxFileCredential({
      credentialId: row.credential_id,
      provider: row.provider,
      kind: row.kind,
      secretName: row.secret_name,
      defaultEnvName: row.default_env_name,
      targetEnvName: row.target_env_name,
      metadata: row.metadata ?? {},
    });
    if (fileCredential) {
      const rawEnvName = row.default_env_name ?? row.secret_name;
      skipped.push({ credentialId: row.credential_id, envName: rawEnvName, reason: 'file credential is materialized as path env; raw env not injected' });
      await auditCredentialEvent({
        credentialId: row.credential_id,
        projectId: opts.projectId,
        eventType: 'materialize_skip_file_credential_env',
        actorUserId: opts.userId,
        provider: row.provider,
        targetType: 'runtime_box_env',
        targetRef: { env_name: rawEnvName, path_env_name: fileCredential.envName },
        status: 'ok',
        message: 'Runtime Box file credential skipped for raw env injection',
      });
      continue;
    }

    const envName = row.target_env_name ?? row.default_env_name ?? row.secret_name;
    assertSecretName(envName);

    // One Runtime target must have one deterministic Credential source. Prefer
    // explicit override/allow by SQL order and report every later collision.
    if (claimedEnvNames.has(envName)) {
      skipped.push({ credentialId: row.credential_id, envName, reason: 'duplicate target env; higher-priority project credential selected' });
      await auditCredentialEvent({
        credentialId: row.credential_id,
        projectId: opts.projectId,
        eventType: 'materialize_skip_duplicate_target',
        actorUserId: opts.userId,
        provider: row.provider,
        targetType: 'runtime_box_env',
        targetRef: { env_name: envName },
        status: 'denied',
        errorCode: 'DUPLICATE_TARGET_ENV',
        message: 'Credential not read because a higher-priority project Credential already owns this Runtime env target',
      });
      continue;
    }
    claimedEnvNames.add(envName);

    // Respect explicit per-command env without decrypting the vault secret.
    if (Object.prototype.hasOwnProperty.call(preExisting, envName)) {
      await auditCredentialEvent({
        credentialId: row.credential_id,
        projectId: opts.projectId,
        eventType: 'materialize_skip_existing_env',
        actorUserId: opts.userId,
        provider: row.provider,
        targetType: 'runtime_box_env',
        targetRef: { env_name: envName },
        status: 'ok',
        message: 'Runtime Box env already supplied by caller; vault value not read',
      });
      continue;
    }

    try {
      const value = await resolveProjectBoundSecret({
        secretName: row.secret_name,
        userId: opts.userId,
        scope: row.scope,
        ownerUserId: row.owner_user_id,
        mode: row.mode,
      });
      vaultEnv.push({ credentialId: row.credential_id, envName, value });
      await auditCredentialEvent({
        credentialId: row.credential_id,
        projectId: opts.projectId,
        eventType: 'materialize',
        actorUserId: opts.userId,
        provider: row.provider,
        targetType: 'runtime_box_env',
        targetRef: { env_name: envName },
        status: 'ok',
        message: 'Runtime Box API-key env materialized for one command',
      });
    } catch (err: any) {
      await auditCredentialEvent({
        credentialId: row.credential_id,
        projectId: opts.projectId,
        eventType: 'materialize',
        actorUserId: opts.userId,
        provider: row.provider,
        targetType: 'runtime_box_env',
        targetRef: { env_name: envName },
        status: 'denied',
        errorCode: err?.name ?? 'SecretResolutionError',
        message: `Runtime Box API-key env materialization failed: ${err?.name ?? 'SecretResolutionError'}`,
      });
      skipped.push({
        credentialId: row.credential_id,
        envName,
        reason: `credential unavailable to current user; skipped without blocking unrelated Runtime Box credentials (${err?.name ?? 'SecretResolutionError'})`,
      });
    }
  }

  const merged = mergeRuntimeBoxApiKeyEnv({ existingEnv: opts.existingEnv, vaultEnv });
  return { ...merged, skipped: [...merged.skipped, ...skipped] };
}

/**
 * Resolve project-allowed credential profiles into one Runtime Box command env.
 *
 * Profile policy gates the non-secret bundle. Each secret ref must also have a
 * project credential policy allow/override/inherit row so a profile cannot smuggle
 * an otherwise-denied credential into a Runtime Box.
 */
export async function resolveRuntimeBoxCredentialProfileEnv(opts: {
  projectId: string;
  userId: number;
  existingEnv?: Record<string, string>;
}): Promise<RuntimeBoxCredentialProfileEnvResolution> {
  const profiles = await query<CredentialProfileRow>(
    `SELECT cp.*
       FROM credential_profiles cp
       LEFT JOIN project_credential_profile_policies pp
         ON pp.profile_id = cp.id AND pp.project_id = $1
       LEFT JOIN workspace_connection_defaults d
         ON d.connection_id = 'profile:' || cp.id
       JOIN (
         SELECT p.*, s.slug AS space_slug
           FROM projects p LEFT JOIN spaces s ON s.id = p.space_id
          WHERE p.id = $1
       ) prj ON true
      WHERE cp.enabled = true
        AND (
          pp.mode = 'allow'
          OR (
            pp.mode IS NULL
            AND d.enabled = true
            AND (
              d.default_mode = 'all_projects'
              OR (
                d.default_mode = 'project_template'
                AND d.project_template IS NOT NULL
                AND lower(d.project_template) IN (
                  lower(prj.name),
                  lower(coalesce(prj.space_slug, '')),
                  lower(regexp_replace(coalesce(prj.root_path, ''), '^.*/', ''))
                )
              )
            )
          )
        )
      ORDER BY cp.id`,
    [opts.projectId],
  );

  const env: Record<string, string> = { ...(opts.existingEnv ?? {}) };
  const injected: Array<{ credentialId: string; envName: string }> = [];
  const skippedExisting: Array<{ credentialId: string; envName: string }> = [];
  const skipped: RuntimeBoxCredentialSkippedItem[] = [];
  const materializeFiles: RuntimeBoxCredentialFileSecret[] = [];
  const profileSummaries: RuntimeBoxCredentialProfileEnvResolution['profiles'] = [];

  for (const profile of profiles) {
    const profileEnvNames: string[] = [];
    const profileSecretEnvNames: string[] = [];
    const profileFileEnvNames: string[] = [];
    const profileSkipped: string[] = [];
    const publicEnv = profile.env ?? {};
    const secretRefs = profile.secret_refs ?? {};
    assertEnvBundle(publicEnv, `profile.${profile.id}.env`);

    for (const [envName, value] of Object.entries(publicEnv)) {
      assertSecretName(envName);
      if (Object.prototype.hasOwnProperty.call(env, envName)) {
        profileSkipped.push(envName);
        continue;
      }
      env[envName] = String(value);
      profileEnvNames.push(envName);
    }

    for (const [envName, credentialId] of Object.entries(secretRefs)) {
      assertSecretName(envName);
      assertCredentialId(credentialId);
      if (Object.prototype.hasOwnProperty.call(env, envName)) {
        skippedExisting.push({ credentialId, envName });
        profileSkipped.push(envName);
        continue;
      }

      const credential = await queryOne<{
        id: string;
        provider: string;
        kind: string;
        secret_name: string;
        default_env_name: string | null;
        metadata: Record<string, unknown>;
        mode: string | null;
      }>(
        `SELECT c.id, c.provider, c.kind, c.secret_name, c.default_env_name, c.metadata, COALESCE(p.mode, 'inherit') AS mode
           FROM workspace_credentials c
           LEFT JOIN project_credential_policies p
             ON p.credential_id = c.id AND p.project_id = $2
           LEFT JOIN workspace_connection_defaults d
             ON d.connection_id = 'credential:' || c.id
           JOIN (
             SELECT p.*, s.slug AS space_slug
               FROM projects p LEFT JOIN spaces s ON s.id = p.space_id
              WHERE p.id = $2
           ) prj ON true
          WHERE c.id = $1
            AND c.enabled = true
            AND ${allowedProjectCredentialWhere('c', 'p', 'd', 'prj')}`,
        [credentialId, opts.projectId],
      );
      if (!credential) {
        await auditCredentialEvent({
          credentialId,
          projectId: opts.projectId,
          eventType: 'profile_materialize_denied',
          actorUserId: opts.userId,
          targetType: 'runtime_box_env',
          targetRef: { profile_id: profile.id, env_name: envName },
          status: 'denied',
          message: 'Profile references a credential not allowed for this project',
        });
        throw new Error(`profile '${profile.id}' references credential '${credentialId}' not allowed for project`);
      }

      const fileCredential = classifyRuntimeBoxFileCredential({
        credentialId,
        provider: credential.provider,
        kind: credential.kind,
        secretName: credential.secret_name,
        defaultEnvName: credential.default_env_name,
        targetEnvName: envName,
        metadata: credential.metadata ?? {},
      });
      if (fileCredential) {
        if (Object.prototype.hasOwnProperty.call(env, fileCredential.envName)) {
          skipped.push({ credentialId, envName: fileCredential.envName, reason: 'path env already supplied by caller; vault value not read' });
          profileSkipped.push(fileCredential.envName);
          continue;
        }
        const value = await getSecret(credential.secret_name, opts.userId);
        materializeFiles.push({
          credentialId,
          envName: fileCredential.envName,
          fileName: fileCredential.fileName,
          mode: fileCredential.mode,
          credentialType: fileCredential.credentialType,
          value,
        });
        profileFileEnvNames.push(fileCredential.envName);
        continue;
      }

      const value = await getSecret(credential.secret_name, opts.userId);
      env[envName] = value;
      injected.push({ credentialId, envName });
      profileSecretEnvNames.push(envName);
    }

    profileSummaries.push({
      profileId: profile.id,
      displayName: profile.display_name,
      envNames: profileEnvNames,
      secretEnvNames: profileSecretEnvNames,
      fileEnvNames: profileFileEnvNames,
      skippedExisting: profileSkipped,
    });

    await auditCredentialEvent({
      credentialId: null,
      projectId: opts.projectId,
      eventType: 'profile_materialize',
      actorUserId: opts.userId,
      provider: profile.provider,
      targetType: 'runtime_box_env',
      targetRef: {
        profile_id: profile.id,
        env_names: profileEnvNames,
        secret_env_names: profileSecretEnvNames,
        file_env_names: profileFileEnvNames,
        skipped_existing: profileSkipped,
      },
      status: 'ok',
      message: 'Credential profile env materialized for one Runtime Box command',
    });
  }

  return { env, injected, skippedExisting, skipped, materializeFiles, profiles: profileSummaries };
}

/** Create/update a GitHub Actions secret target binding. */
export async function upsertGitHubActionsSecretTarget(opts: {
  id?: number;
  credentialId: string;
  projectId?: string | null;
  repo: string;
  secretName: string;
  actorUserId: number;
}): Promise<CredentialTargetSyncRow> {
  assertGitHubRepo(opts.repo);
  assertSecretName(opts.secretName);

  const targetRef = { repo: opts.repo, secret_name: opts.secretName };
  if (opts.id) {
    const rows = await query<CredentialTargetSyncRow>(
      `UPDATE credential_target_syncs
          SET credential_id = $2,
              project_id = $3,
              target_ref = $4::jsonb,
              updated_at = now(),
              updated_by = $5
        WHERE id = $1 AND target_type = 'github_actions_secret'
        RETURNING *`,
      [opts.id, opts.credentialId, opts.projectId ?? null, JSON.stringify(targetRef), opts.actorUserId],
    );
    if (rows.length === 0) throw new Error(`GitHub Actions target not found: ${opts.id}`);
    return rows[0];
  }

  const rows = await query<CredentialTargetSyncRow>(
    `INSERT INTO credential_target_syncs
       (credential_id, project_id, target_type, target_ref, created_by, updated_by)
     VALUES ($1, $2, 'github_actions_secret', $3::jsonb, $4, $4)
     RETURNING *`,
    [opts.credentialId, opts.projectId ?? null, JSON.stringify(targetRef), opts.actorUserId],
  );

  await auditCredentialEvent({
    credentialId: opts.credentialId,
    projectId: opts.projectId ?? null,
    targetSyncId: rows[0].id,
    eventType: 'target_create',
    actorUserId: opts.actorUserId,
    targetType: 'github_actions_secret',
    targetRef,
  });

  return rows[0];
}

/** Check whether a GitHub Actions secret target exists; does not read secret values. */
export async function checkGitHubActionsSecretStatus(opts: {
  targetId: number;
  actorUserId: number;
}): Promise<{ status: 'present' | 'missing' | 'error'; updatedAt?: string; message?: string }> {
  const target = await queryOne<CredentialTargetSyncRow>(
    `SELECT * FROM credential_target_syncs WHERE id = $1 AND target_type = 'github_actions_secret'`,
    [opts.targetId],
  );
  if (!target) throw new Error(`GitHub Actions target not found: ${opts.targetId}`);
  const ref = targetRefFromRow(target);

  const result = await spawnGh(['secret', 'list', '--repo', ref.repo, '--json', 'name,updatedAt'], { timeoutMs: 30_000 });
  if (result.exitCode !== 0) {
    const message = result.stderr.trim().slice(0, 500) || `gh secret list exited ${result.exitCode}`;
    await execute(
      `UPDATE credential_target_syncs
          SET last_status = 'error', last_checked_at = now(), last_error = $2, updated_at = now()
        WHERE id = $1`,
      [target.id, message],
    );
    await auditCredentialEvent({
      credentialId: target.credential_id,
      projectId: target.project_id,
      targetSyncId: target.id,
      eventType: 'status',
      actorUserId: opts.actorUserId,
      targetType: target.target_type,
      targetRef: ref,
      status: 'error',
      message,
    });
    return { status: 'error', message };
  }

  let parsed: Array<{ name: string; updatedAt?: string }> = [];
  try {
    parsed = JSON.parse(result.stdout || '[]') as Array<{ name: string; updatedAt?: string }>;
  } catch {
    parsed = [];
  }
  const found = parsed.find(s => s.name === ref.secret_name);
  const status = found ? 'present' : 'missing';
  await execute(
    `UPDATE credential_target_syncs
        SET last_status = $2, last_checked_at = now(), last_error = NULL, updated_at = now()
      WHERE id = $1`,
    [target.id, status],
  );
  await auditCredentialEvent({
    credentialId: target.credential_id,
    projectId: target.project_id,
    targetSyncId: target.id,
    eventType: 'status',
    actorUserId: opts.actorUserId,
    targetType: target.target_type,
    targetRef: ref,
    status: 'ok',
    message: `GitHub Actions secret status: ${status}`,
  });
  return { status, updatedAt: found?.updatedAt };
}

/** Sync a vault credential into a GitHub Actions repository secret via `gh secret set`. */
export async function syncGitHubActionsSecret(opts: {
  targetId: number;
  actorUserId: number;
}): Promise<{ ok: boolean; status: string; message?: string }> {
  const target = await queryOne<CredentialTargetSyncRow & WorkspaceCredentialRow>(
    `SELECT t.*, c.kind, c.provider, c.display_name, c.secret_name, c.default_env_name,
            c.scope, c.metadata, c.enabled AS credential_enabled,
            c.created_at AS credential_created_at, c.created_by AS credential_created_by,
            c.updated_at AS credential_updated_at, c.updated_by AS credential_updated_by,
            c.rotated_at AS credential_rotated_at
       FROM credential_target_syncs t
       JOIN workspace_credentials c ON c.id = t.credential_id
      WHERE t.id = $1 AND t.target_type = 'github_actions_secret'`,
    [opts.targetId],
  );
  if (!target) throw new Error(`GitHub Actions target not found: ${opts.targetId}`);
  if (!target.enabled || !(target as any).credential_enabled) throw new Error(`credential target disabled: ${opts.targetId}`);

  const ref = targetRefFromRow(target);
  const secretValue = await getSecret(target.secret_name, opts.actorUserId);
  // gh v2.87 reads the secret value from stdin when --body is omitted.
  // Avoid argv/body flags so the secret value never appears in process args.
  const result = await spawnGh(['secret', 'set', ref.secret_name, '--repo', ref.repo], {
    stdin: secretValue,
    timeoutMs: 30_000,
  });

  if (result.exitCode !== 0) {
    const message = result.stderr.trim().slice(0, 500) || `gh secret set exited ${result.exitCode}`;
    await execute(
      `UPDATE credential_target_syncs
          SET last_status = 'error', last_checked_at = now(), last_error = $2, updated_at = now()
        WHERE id = $1`,
      [target.id, message],
    );
    await auditCredentialEvent({
      credentialId: target.credential_id,
      projectId: target.project_id,
      targetSyncId: target.id,
      eventType: 'sync',
      actorUserId: opts.actorUserId,
      provider: target.provider,
      targetType: target.target_type,
      targetRef: ref,
      status: 'error',
      message,
    });
    return { ok: false, status: 'error', message };
  }

  await execute(
    `UPDATE credential_target_syncs
        SET last_status = 'present', last_checked_at = now(), last_synced_at = now(),
            last_error = NULL, updated_at = now()
      WHERE id = $1`,
    [target.id],
  );
  await auditCredentialEvent({
    credentialId: target.credential_id,
    projectId: target.project_id,
    targetSyncId: target.id,
    eventType: 'sync',
    actorUserId: opts.actorUserId,
    provider: target.provider,
    targetType: target.target_type,
    targetRef: ref,
    status: 'ok',
    message: 'GitHub Actions secret synced',
  });
  return { ok: true, status: 'present' };
}

/** Generate a safe default credential id when UI callers do not provide one. */
export function newCredentialId(prefix = 'credential'): string {
  return `${prefix}-${randomUUID().slice(0, 8)}`;
}

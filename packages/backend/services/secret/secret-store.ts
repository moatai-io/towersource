/**
 * Owns: AES-GCM encrypted secrets in PostgreSQL.
 * Public API: getSecret, setSecret, grantSecret, revokeSecret, listSecrets, deleteSecret.
 * See README.md, _DECISIONS.md.
 *
 * 결정:
 *   workspace/decisions/2026-04-29-execution-sandbox-q12-secrets.md
 *   workspace/decisions/2026-05-02-execution-sandbox-d12-sibling-sandbox-mandatory.md
 *
 * Threat model:
 *   - DB dump 유출 → ciphertext only, master key 없으면 무용
 *   - Tower 본체 침투 → master key 노출 위험. .env 권한 600 + git 제외.
 *   - AI 가 secret 인자로 *값* 보냄 → 영구 X. 인자는 *이름* 만.
 *   - log 평문 노출 → 어떤 함수도 평문 console.log 안 함.
 *
 * 이 파일은 sandbox.ts 와 fleet secret CLI 만 호출. 다른 코드는 호출 X.
 */

import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  timingSafeEqual,
} from 'crypto';
import { config } from '../../config.js';
import { getPgPool } from '../../db/pg.js';
import { normalizeApprovedLegacyGwsBundle } from '../runtime-box/agent-gws-credential-selection.js';

const ALGO = 'aes-256-gcm';
const NONCE_LEN = 12;
const TAG_LEN = 16;

// ── Errors ─────────────────────────────────────────────────────────────

export class SecretAccessDeniedError extends Error {
  constructor(public reason: string) {
    super(`secret denied: ${reason}`);
    this.name = 'SecretAccessDeniedError';
  }
}

export class SecretConfigError extends Error {
  constructor(reason: string) {
    super(`secret store config: ${reason}`);
    this.name = 'SecretConfigError';
  }
}

// ── Master key ─────────────────────────────────────────────────────────

let cachedKey: Buffer | null = null;

function getMasterKey(): Buffer {
  if (cachedKey) return cachedKey;
  const hex = config.sandbox.secretStoreMasterKey;
  if (!hex) {
    throw new SecretConfigError(
      'SECRET_STORE_MASTER_KEY not set. Generate with: openssl rand -hex 32',
    );
  }
  if (!/^[0-9a-f]{64}$/i.test(hex)) {
    throw new SecretConfigError(
      'SECRET_STORE_MASTER_KEY must be 64 hex chars (32 bytes). Generate with: openssl rand -hex 32',
    );
  }
  cachedKey = Buffer.from(hex, 'hex');
  return cachedKey;
}

/** Boot-time check — fail fast if master key invalid yet sandbox enabled. */
export function verifyMasterKey(): { ok: boolean; reason?: string } {
  if (!config.sandbox.enabled) return { ok: true };          // not used
  try {
    const key = getMasterKey();
    if (key.length !== 32) return { ok: false, reason: 'key length != 32 bytes' };
    // round-trip test (also exercises crypto subsystem on this platform)
    const sample = randomBytes(32).toString('hex');
    const enc = encrypt(sample);
    const dec = decrypt(enc);
    if (dec !== sample) return { ok: false, reason: 'round-trip mismatch' };
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: (e as Error).message };
  }
}

// ── Crypto ─────────────────────────────────────────────────────────────

/**
 * Encrypted blob layout: [nonce(12) | ciphertext(N) | authTag(16)].
 * Stored as PostgreSQL BYTEA in secret_store.value_encrypted.
 */
function encrypt(plaintext: string): Buffer {
  const key = getMasterKey();
  const nonce = randomBytes(NONCE_LEN);
  const cipher = createCipheriv(ALGO, key, nonce);
  const ct = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([nonce, ct, tag]);
}

function decrypt(blob: Buffer): string {
  const key = getMasterKey();
  if (blob.length < NONCE_LEN + TAG_LEN) {
    throw new Error('ciphertext too short');
  }
  const nonce = blob.subarray(0, NONCE_LEN);
  const tag = blob.subarray(blob.length - TAG_LEN);
  const ct = blob.subarray(NONCE_LEN, blob.length - TAG_LEN);
  const decipher = createDecipheriv(ALGO, key, nonce);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
}

// Validate name format — prevent injection / weird chars in env var names.
const VALID_NAME_RE = /^[A-Z][A-Z0-9_]{0,63}$/;

function assertValidName(name: string): void {
  if (!VALID_NAME_RE.test(name)) {
    throw new SecretConfigError(
      `invalid secret name "${name}" — must match ${VALID_NAME_RE} (UPPERCASE / digits / underscore)`,
    );
  }
}

// ── Public API ─────────────────────────────────────────────────────────

export type SecretScope = 'global' | 'user' | 'tool';

export interface SecretMeta {
  id: number;
  name: string;
  scope: SecretScope;
  owner_user_id: number | null;
  owner_tool_id: number | null;
  description: string | null;
  created_at: Date;
  rotated_at: Date | null;
  granted_user_count: number;   // for list views
}

/**
 * Resolve and decrypt a secret for the given user.
 * Throws SecretAccessDeniedError if not found or not granted.
 *
 * Resolution order (first match wins):
 *   1. user-scoped owned by userId
 *   2. user-scoped granted to userId
 *   3. global-scoped
 *   (tool-scoped resolution happens through sandbox-tools later, not here)
 */
export async function getSecret(name: string, userId: number): Promise<string> {
  assertValidName(name);
  const pool = getPgPool();

  // Try user-owned, then granted, then global. We coalesce in one query.
  const { rows } = await pool.query<{
    id: number;
    scope: SecretScope;
    value_encrypted: Buffer;
    owner_user_id: number | null;
    is_granted: boolean;
  }>(
    `SELECT s.id, s.scope, s.value_encrypted, s.owner_user_id,
            (g.user_id IS NOT NULL) AS is_granted
       FROM secret_store s
       LEFT JOIN secret_grants g
              ON g.secret_id = s.id AND g.user_id = $2
      WHERE s.name = $1
        AND (
          (s.scope = 'user' AND s.owner_user_id = $2) OR
          (s.scope = 'user' AND g.user_id = $2)        OR
          (s.scope = 'global')
        )
      ORDER BY
        CASE
          WHEN s.scope = 'user' AND s.owner_user_id = $2 THEN 0
          WHEN s.scope = 'user' AND g.user_id = $2 THEN 1
          ELSE 2
        END
      LIMIT 1`,
    [name, userId],
  );

  if (rows.length === 0) {
    throw new SecretAccessDeniedError(`'${name}' not found or not granted to user ${userId}`);
  }

  return decrypt(rows[0].value_encrypted);
}

/**
 * Resolve a secret after the caller has already proved an explicit Project
 * Credential binding. Project binding, rather than the legacy personal owner,
 * is the execution authority in that path. The caller must never expose this
 * as a general user-facing secret lookup.
 */
export async function getSecretForProjectBinding(name: string, ownerUserId?: number | null): Promise<string> {
  assertValidName(name);
  const pool = getPgPool();
  const { rows } = await pool.query<{ value_encrypted: Buffer }>(
    `SELECT value_encrypted
       FROM secret_store
      WHERE name = $1
        AND (scope = 'global' OR (scope = 'user' AND owner_user_id = $2))
      ORDER BY CASE WHEN scope = 'global' THEN 0 ELSE 1 END, id
      LIMIT 1`,
    [name, ownerUserId ?? null],
  );
  if (rows.length === 0) throw new SecretAccessDeniedError(`'${name}' not found for Project binding owner`);
  return decrypt(rows[0].value_encrypted);
}

/** Explicit legacy GWS bridge only. Never choose the requester's personal account.
 * The approved exact secret identity and frozen audience are rechecked together
 * with current grants/account state before decrypting. No global fallback.
 */
export async function getSecretForLegacyGwsBinding(credentialId: string, userId: number): Promise<string | null> {
  const { rows } = await getPgPool().query<{ allowed: boolean; value_encrypted: Buffer | null; bundle_sha256: string; credential_path: string }>(
    `SELECT (s.id IS NOT NULL) AS allowed, s.value_encrypted, b.bundle_sha256, b.credential_path
       FROM legacy_gws_runtime_bindings b
       LEFT JOIN secret_store s ON s.id = b.secret_id
         AND b.enabled = true AND $2 = ANY(b.allowed_user_ids)
         AND EXISTS (SELECT 1 FROM users u WHERE u.id = $2 AND u.disabled = 0
                     AND u.role IN ('admin', 'operator', 'member'))
         AND (s.owner_user_id = $2 OR EXISTS (
           SELECT 1 FROM secret_grants g WHERE g.secret_id = s.id AND g.user_id = $2))
         AND EXISTS (SELECT 1 FROM workspace_credentials c WHERE c.id = b.credential_id
                     AND c.enabled = true AND c.provider = 'google' AND c.kind = 'gws'
                     AND c.secret_name = s.name
                     AND NOT (COALESCE(c.metadata, '{}'::jsonb) ? 'legacy_personal_owner_user_id'))
      WHERE b.credential_id = $1`,
    [credentialId, userId],
  );
  if (rows.length === 0) return null;
  if (!rows[0].allowed || !rows[0].value_encrypted) throw new SecretAccessDeniedError('Legacy GWS binding unavailable for this requester');
  return normalizeApprovedLegacyGwsBundle(decrypt(rows[0].value_encrypted), {
    bundleSha256: rows[0].bundle_sha256, credentialPath: rows[0].credential_path,
  });
}

export interface SetSecretOptions {
  name: string;
  value: string;
  scope: SecretScope;
  ownerUserId?: number;     // required for scope='user'
  ownerToolId?: number;     // required for scope='tool'
  description?: string;
  createdBy: number;
}

/**
 * Insert or rotate a secret. Idempotent on (name, scope, owner_user_id, owner_tool_id).
 * Returns the secret id.
 */
export async function setSecret(opts: SetSecretOptions): Promise<number> {
  assertValidName(opts.name);
  if (opts.scope === 'user' && !opts.ownerUserId) {
    throw new SecretConfigError(`scope='user' requires ownerUserId`);
  }
  if (opts.scope === 'tool' && !opts.ownerToolId) {
    throw new SecretConfigError(`scope='tool' requires ownerToolId`);
  }

  const pool = getPgPool();
  const enc = encrypt(opts.value);
  const ownerUserId = opts.ownerUserId ?? null;
  const ownerToolId = opts.ownerToolId ?? null;
  const lockKey = JSON.stringify([opts.name, opts.scope, ownerUserId, ownerToolId]);
  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    // PostgreSQL UNIQUE treats NULL owner columns as distinct by default. Serialize
    // one logical secret identity explicitly so global/user/tool rotations cannot
    // append a second row when either owner column is NULL.
    await client.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [lockKey]);
    const updated = await client.query<{ id: number }>(
      `UPDATE secret_store
          SET value_encrypted = $5,
              description = COALESCE($6, description),
              rotated_at = now()
        WHERE name = $1
          AND scope = $2
          AND owner_user_id IS NOT DISTINCT FROM $3
          AND owner_tool_id IS NOT DISTINCT FROM $4
        RETURNING id`,
      [opts.name, opts.scope, ownerUserId, ownerToolId, enc, opts.description ?? null],
    );

    let id: number;
    if (updated.rows.length > 0) {
      // Historical duplicates created by the nullable UNIQUE bug are all rotated
      // to the same value; keep the oldest identity as the stable return value.
      id = Math.min(...updated.rows.map(row => row.id));
    } else {
      const inserted = await client.query<{ id: number }>(
        `INSERT INTO secret_store
           (name, value_encrypted, scope, owner_user_id, owner_tool_id, description, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING id`,
        [opts.name, enc, opts.scope, ownerUserId, ownerToolId, opts.description ?? null, opts.createdBy],
      );
      id = inserted.rows[0].id;
    }
    await client.query('COMMIT');
    return id;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function grantSecret(opts: {
  secretId: number;
  userId: number;
  grantedBy: number;
}): Promise<void> {
  const pool = getPgPool();
  await pool.query(
    `INSERT INTO secret_grants (secret_id, user_id, granted_by)
     VALUES ($1, $2, $3)
     ON CONFLICT (secret_id, user_id) DO NOTHING`,
    [opts.secretId, opts.userId, opts.grantedBy],
  );
}

export async function revokeSecret(opts: {
  secretId: number;
  userId: number;
}): Promise<boolean> {
  const pool = getPgPool();
  const result = await pool.query(
    `DELETE FROM secret_grants WHERE secret_id = $1 AND user_id = $2`,
    [opts.secretId, opts.userId],
  );
  return (result.rowCount ?? 0) > 0;
}

export async function deleteSecret(secretId: number): Promise<boolean> {
  const pool = getPgPool();
  const result = await pool.query(
    `DELETE FROM secret_store WHERE id = $1`,
    [secretId],
  );
  return (result.rowCount ?? 0) > 0;
}

/**
 * List secrets — values never returned. For admin views and CLI.
 */
export async function listSecrets(opts: {
  scope?: SecretScope;
  ownerUserId?: number;
} = {}): Promise<SecretMeta[]> {
  const pool = getPgPool();
  const conds: string[] = ['1=1'];
  const params: unknown[] = [];
  if (opts.scope) {
    conds.push(`s.scope = $${params.length + 1}`);
    params.push(opts.scope);
  }
  if (opts.ownerUserId !== undefined) {
    conds.push(`s.owner_user_id = $${params.length + 1}`);
    params.push(opts.ownerUserId);
  }

  const { rows } = await pool.query(
    `SELECT s.id, s.name, s.scope, s.owner_user_id, s.owner_tool_id,
            s.description, s.created_at, s.rotated_at,
            COALESCE((SELECT COUNT(*) FROM secret_grants g WHERE g.secret_id = s.id), 0)::int AS granted_user_count
       FROM secret_store s
      WHERE ${conds.join(' AND ')}
      ORDER BY s.scope, s.name`,
    params,
  );

  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    scope: r.scope,
    owner_user_id: r.owner_user_id,
    owner_tool_id: r.owner_tool_id,
    description: r.description,
    created_at: r.created_at,
    rotated_at: r.rotated_at,
    granted_user_count: r.granted_user_count,
  }));
}

/**
 * For runtime sanity check by sandbox.ts before injection.
 * Used by CLI list to show which users have access.
 */
export async function listGrants(secretId: number): Promise<Array<{ user_id: number; username: string; granted_at: Date }>> {
  const pool = getPgPool();
  const { rows } = await pool.query(
    `SELECT g.user_id, u.username, g.granted_at
       FROM secret_grants g
       JOIN users u ON u.id = g.user_id
      WHERE g.secret_id = $1
      ORDER BY u.username`,
    [secretId],
  );
  return rows;
}

/** Helper for use within timing-sensitive code paths (currently unused, future).  */
export function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

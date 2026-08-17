import { createHash, randomUUID, timingSafeEqual } from 'crypto';
import { execute, queryOne } from '../../db/pg-repo.js';
import { getSecret } from '../secret/secret-store.js';
import { authenticateUser } from '../auth/auth.js';
import { auditCredentialEvent } from './credential-vault-service.js';
import { assertRevealAllowed, type CredentialRevealMode } from './credential-reveal-policy.js';
import { assertInspectorResultSecretFree, inspectCredentialValue, type CredentialInspectionResult } from './credential-inspector.js';

const CHALLENGE_TTL_MS = 2 * 60 * 1000;
const REVEAL_TTL_SECONDS = 30;

interface CredentialTarget {
  id: string;
  kind: string;
  secret_name: string;
  metadata: Record<string, unknown>;
  enabled: boolean;
}

interface RevealChallengeRow {
  id: string;
  actor_user_id: number;
  credential_id: string;
  field_id: string;
  purpose: string;
  mode: CredentialRevealMode;
  status: string;
  failed_attempts: number;
  expires_at: Date;
  consumed_at: Date | null;
}

function safeError(code: string): Error & { code: string } {
  return Object.assign(new Error(code), { code });
}

async function credentialTarget(credentialId: string): Promise<CredentialTarget> {
  const row = await queryOne<CredentialTarget>(
    `SELECT id, kind, secret_name, metadata, enabled FROM workspace_credentials WHERE id = $1`,
    [credentialId],
  );
  if (!row || !row.enabled) throw safeError('CREDENTIAL_NOT_FOUND');
  return row;
}

export async function createRevealChallenge(input: {
  actorUserId: number;
  requesterHash: string;
  credentialId: string;
  fieldId: string;
  purpose: string;
  mode: CredentialRevealMode;
}): Promise<{ challengeId: string; expiresAt: string }> {
  const target = await credentialTarget(input.credentialId);
  assertRevealAllowed({ kind: target.kind, secretName: target.secret_name, metadata: target.metadata }, input.mode);

  const recent = await queryOne<{ count: string }>(
    `SELECT coalesce(sum(failed_attempts), 0)::text AS count FROM credential_reveal_challenges
      WHERE actor_user_id = $1 AND requester_hash = $2 AND created_at > now() - interval '15 minutes'`,
    [input.actorUserId, input.requesterHash],
  );
  if (Number(recent?.count || 0) >= 5) throw safeError('STEP_UP_RATE_LIMITED');

  const created = await queryOne<{ count: string }>(
    `SELECT count(*)::text AS count FROM credential_reveal_challenges
      WHERE actor_user_id = $1 AND created_at > now() - interval '1 minute'`,
    [input.actorUserId],
  );
  if (Number(created?.count || 0) >= 5) throw safeError('STEP_UP_RATE_LIMITED');

  const challengeId = randomUUID();
  const expiresAt = new Date(Date.now() + CHALLENGE_TTL_MS);
  await execute(
    `INSERT INTO credential_reveal_challenges
      (id, actor_user_id, requester_hash, credential_id, field_id, purpose, mode, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [challengeId, input.actorUserId, input.requesterHash, input.credentialId, input.fieldId, input.purpose, input.mode, expiresAt],
  );
  await auditCredentialEvent({
    credentialId: input.credentialId,
    actorUserId: input.actorUserId,
    eventType: 'credential_reveal_challenge_created',
    targetType: 'credential_field',
    targetRef: { fieldId: input.fieldId, purpose: input.purpose, mode: input.mode },
  });
  return { challengeId, expiresAt: expiresAt.toISOString() };
}

async function consumeChallenge(input: {
  actorUserId: number;
  username: string;
  challengeId: string;
  credentialId: string;
  fieldId: string;
  purpose: string;
  mode: CredentialRevealMode;
  password: string;
}): Promise<CredentialTarget> {
  const challenge = await queryOne<RevealChallengeRow>(
    `SELECT * FROM credential_reveal_challenges WHERE id = $1 FOR UPDATE`,
    [input.challengeId],
  );
  const valid = challenge
    && challenge.actor_user_id === input.actorUserId
    && challenge.credential_id === input.credentialId
    && challenge.field_id === input.fieldId
    && challenge.purpose === input.purpose
    && challenge.mode === input.mode
    && challenge.status === 'pending'
    && !challenge.consumed_at
    && new Date(challenge.expires_at).getTime() > Date.now()
    && challenge.failed_attempts < 3;
  if (!valid) throw safeError('STEP_UP_FAILED');

  const auth = await authenticateUser(input.username, input.password);
  if (!auth.ok || auth.payload?.userId !== input.actorUserId || auth.payload?.role !== 'admin') {
    await execute(
      `UPDATE credential_reveal_challenges
          SET failed_attempts = failed_attempts + 1,
              status = CASE WHEN failed_attempts + 1 >= 3 THEN 'failed' ELSE status END
        WHERE id = $1`,
      [input.challengeId],
    );
    throw safeError('STEP_UP_FAILED');
  }

  const consumed = await queryOne<{ id: string }>(
    `UPDATE credential_reveal_challenges SET status = 'consumed', consumed_at = now()
      WHERE id = $1 AND status = 'pending' AND consumed_at IS NULL AND expires_at > now()
      RETURNING id`,
    [input.challengeId],
  );
  if (!consumed) throw safeError('STEP_UP_FAILED');
  return credentialTarget(input.credentialId);
}

export async function inspectCredential(input: { actorUserId: number; credentialId: string }): Promise<CredentialInspectionResult> {
  const target = await credentialTarget(input.credentialId);
  assertRevealAllowed({ kind: target.kind, secretName: target.secret_name, metadata: target.metadata }, 'inspect');
  const value = await getSecret(target.secret_name, input.actorUserId);
  const result = inspectCredentialValue(value);
  assertInspectorResultSecretFree(result);
  await auditCredentialEvent({
    credentialId: input.credentialId,
    actorUserId: input.actorUserId,
    eventType: 'credential_field_inspected',
    targetType: 'credential_field',
    targetRef: { format: result.format, valid: result.valid, lengthBucket: result.lengthBucket, whitespace: result.whitespace },
  });
  return result;
}

export async function revealCredentialFieldAsAdmin(input: {
  actorUserId: number;
  credentialId: string;
  fieldId: string;
  purpose: string;
}): Promise<{
  value: string;
  expiresInSeconds: number;
}> {
  const target = await credentialTarget(input.credentialId);
  assertRevealAllowed({ kind: target.kind, secretName: target.secret_name, metadata: target.metadata }, 'reveal');
  const value = await getSecret(target.secret_name, input.actorUserId);
  await auditCredentialEvent({
    credentialId: input.credentialId,
    actorUserId: input.actorUserId,
    eventType: 'credential_field_revealed',
    targetType: 'credential_field',
    targetRef: { fieldId: input.fieldId, purpose: input.purpose, authorization: 'active_admin_session' },
  });
  return { value, expiresInSeconds: REVEAL_TTL_SECONDS };
}

export async function compareCredentialField(input: Parameters<typeof consumeChallenge>[0] & { candidate: string }): Promise<{ matches: boolean }> {
  const target = await consumeChallenge(input);
  assertRevealAllowed({ kind: target.kind, secretName: target.secret_name, metadata: target.metadata }, 'compare');
  const stored = await getSecret(target.secret_name, input.actorUserId);
  const a = createHash('sha256').update(stored).digest();
  const b = createHash('sha256').update(input.candidate).digest();
  const matches = timingSafeEqual(a, b);
  await auditCredentialEvent({
    credentialId: input.credentialId,
    actorUserId: input.actorUserId,
    eventType: 'credential_field_compared',
    targetType: 'credential_field',
    targetRef: { fieldId: input.fieldId, purpose: input.purpose, matches },
  });
  return { matches };
}

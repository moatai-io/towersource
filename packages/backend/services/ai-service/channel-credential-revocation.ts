/**
 * Owns AI Service Channel credential revocation checks.
 * Public API: revokeChannelCredential, assertChannelCredentialNotRevoked.
 */
import { execute, queryOne } from '../../db/pg-repo.js';
import { ChannelCredentialError, channelCredentialTokenHash, type ChannelCredentialClaims } from './channel-credential.js';

export async function revokeChannelCredential(input: {
  token: string;
  claims: ChannelCredentialClaims;
  revokedByUserId?: number | null;
  reason?: string;
}): Promise<{ tokenHash: string }> {
  const tokenHash = channelCredentialTokenHash(input.token);
  await execute(
    `INSERT INTO ai_service_channel_credential_revocations
       (token_hash, service_id, channel_id, nonce, reason, revoked_by_user_id, expires_at)
     VALUES ($1,$2,$3,$4,$5,$6,to_timestamp($7))
     ON CONFLICT(token_hash) DO NOTHING`,
    [tokenHash, input.claims.serviceId, input.claims.channelId, input.claims.nonce, input.reason || 'revoked', input.revokedByUserId || null, input.claims.exp],
  );
  return { tokenHash };
}

export async function assertChannelCredentialNotRevoked(token: string): Promise<void> {
  const tokenHash = channelCredentialTokenHash(token);
  const row = await queryOne<{ token_hash: string }>(
    'SELECT token_hash FROM ai_service_channel_credential_revocations WHERE token_hash=$1 LIMIT 1',
    [tokenHash],
  );
  if (row) throw new ChannelCredentialError('AI Service Channel credential revoked', 401);
}

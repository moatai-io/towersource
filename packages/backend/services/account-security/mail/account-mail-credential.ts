import { queryOne } from '../../../db/pg-repo.js';
import { getSecretForProjectBinding } from '../../secret/secret-store.js';
import { auditCredentialEvent } from '../../credential-vault/credential-vault-service.js';

/** Server-configured binding only: never accept the id from an HTTP request or tool payload. */
export async function resolveAccountMailCredential(credentialId: string): Promise<string> {
  if (!/^[a-z0-9][a-z0-9_-]{1,79}$/.test(credentialId)) throw new Error('Account mail Credential is not configured');
  const row = await queryOne<{ id: string; secret_name: string }>(
    `SELECT id, secret_name FROM workspace_credentials
     WHERE id=$1 AND enabled=true AND scope='workspace' AND provider='zuplo' AND kind='api_key'
       AND NOT (COALESCE(metadata, '{}'::jsonb) ? 'legacy_personal_owner_user_id')`, [credentialId],
  );
  if (!row) throw new Error('Account mail Credential is unavailable');
  const value = await getSecretForProjectBinding(row.secret_name);
  await auditCredentialEvent({ credentialId: row.id, eventType: 'materialize', provider: 'zuplo', targetType: 'system-account-mail' });
  return value;
}

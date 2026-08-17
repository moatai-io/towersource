/**
 * Owns: exact Worker-to-Secret-Store binding for Tower→Worker execution transport auth.
 * Public API: configure, remove, inspect metadata, and resolve token for one selected Worker.
 * Token values are encrypted by Secret Store and never persisted in Worker registry metadata.
 */

import { execute, queryOne } from '../../db/pg-repo.js';
import { getSecret, setSecret } from '../secret/secret-store.js';

const WORKER_ID = /^[a-zA-Z0-9._-]{1,120}$/;

export interface WorkbenchWorkerTransportCredentialBinding {
  worker_id: string;
  secret_name: string;
  configured_by_user_id: number | null;
  configured_at: Date;
  updated_at: Date;
}

/** Derive a stable Secret Store key without embedding the Worker id in SQL identifiers. */
export function workbenchWorkerTransportSecretName(workerId: string): string {
  if (!WORKER_ID.test(workerId)) throw new Error('WORKER_ID_INVALID');
  const normalized = workerId.toUpperCase().replace(/[^A-Z0-9]/g, '_').slice(0, 40);
  const suffix = Buffer.from(workerId).toString('hex').slice(0, 16).toUpperCase();
  return `WORKBENCH_WORKER_${normalized}_${suffix}`.slice(0, 64);
}

/** Encrypt/rotate a Worker transport token, then persist only its Secret Store name mapping. */
export async function configureWorkbenchWorkerTransportCredential(input: {
  workerId: string;
  token: string;
  actorUserId: number;
}): Promise<WorkbenchWorkerTransportCredentialBinding> {
  if (!input.token.trim()) throw new Error('WORKER_TRANSPORT_TOKEN_EMPTY');
  const secretName = workbenchWorkerTransportSecretName(input.workerId);
  await setSecret({
    name: secretName,
    value: input.token,
    scope: 'global',
    description: `Workbench Worker execution transport token for ${input.workerId}`,
    createdBy: input.actorUserId,
  });
  const row = await queryOne<WorkbenchWorkerTransportCredentialBinding>(
    `INSERT INTO runtime_box_workbench_worker_transport_credentials(worker_id,secret_name,configured_by_user_id)
     VALUES($1,$2,$3)
     ON CONFLICT(worker_id) DO UPDATE SET secret_name=EXCLUDED.secret_name,
       configured_by_user_id=EXCLUDED.configured_by_user_id,updated_at=NOW()
     RETURNING *`,
    [input.workerId, secretName, input.actorUserId],
  );
  if (!row) throw new Error('WORKER_TRANSPORT_CREDENTIAL_CONFIG_FAILED');
  return row;
}

/** Return non-secret transport credential metadata for operator diagnostics. */
export async function getWorkbenchWorkerTransportCredentialBinding(workerId: string): Promise<WorkbenchWorkerTransportCredentialBinding | undefined> {
  return queryOne<WorkbenchWorkerTransportCredentialBinding>(
    'SELECT * FROM runtime_box_workbench_worker_transport_credentials WHERE worker_id=$1', [workerId],
  );
}

/** Resolve only the token mapped to the exact scheduler-selected Worker. */
export async function resolveWorkbenchWorkerTransportToken(workerId: string, actorUserId: number): Promise<string | null> {
  const binding = await getWorkbenchWorkerTransportCredentialBinding(workerId);
  if (!binding) return null;
  return getSecret(binding.secret_name, actorUserId);
}

/** Remove the active binding. Secret deletion/retention remains an explicit Vault lifecycle decision. */
export async function removeWorkbenchWorkerTransportCredentialBinding(workerId: string): Promise<boolean> {
  return (await execute(
    'DELETE FROM runtime_box_workbench_worker_transport_credentials WHERE worker_id=$1', [workerId],
  )).changes === 1;
}

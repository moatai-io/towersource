/**
 * Owns: Worker identity audit, active lookup, revocation, and rotation linkage.
 * Public API: record/list/revoke/assert active Worker identities.
 * Raw JWT values never enter this module.
 */

import { execute, query, queryOne, transaction, withClient } from '../../db/pg-repo.js';
import type { WorkbenchWorkerIdentity } from './workbench-worker-identity.js';

export interface WorkbenchWorkerIdentityRow {
  jti: string;
  worker_id: string;
  project_ids: string[];
  capabilities: string[];
  issued_by_user_id: number | null;
  issued_at: string;
  expires_at: string;
  revoked_at: string | null;
  replaced_by_jti: string | null;
  reason: string | null;
}

/** Persist only identity metadata and the jti revocation handle. */
export async function recordWorkbenchWorkerIdentity(input: {
  identity: WorkbenchWorkerIdentity;
  issuedByUserId: number;
  reason?: string;
}): Promise<WorkbenchWorkerIdentityRow> {
  const row = await queryOne<WorkbenchWorkerIdentityRow>(
    `INSERT INTO runtime_box_workbench_worker_identities(
       jti,worker_id,project_ids,capabilities,issued_by_user_id,expires_at,reason
     ) VALUES($1,$2,$3::text[],$4::text[],$5,$6,$7) RETURNING *`,
    [input.identity.jti, input.identity.workerId, input.identity.projectIds, input.identity.capabilities,
      input.issuedByUserId, input.identity.expiresAt, input.reason?.trim() || null],
  );
  if (!row) throw new Error('WORKER_IDENTITY_RECORD_FAILED');
  return row;
}

/** Read one identity metadata row by revocation handle. */
export async function getWorkbenchWorkerIdentity(jti: string): Promise<WorkbenchWorkerIdentityRow | undefined> {
  return queryOne<WorkbenchWorkerIdentityRow>(
    'SELECT * FROM runtime_box_workbench_worker_identities WHERE jti=$1', [jti],
  );
}

/** List newest identity metadata for one Worker; no token material exists to return. */
export async function listWorkbenchWorkerIdentities(workerId: string, limit = 20): Promise<WorkbenchWorkerIdentityRow[]> {
  const bounded = Math.min(Math.max(Math.trunc(limit), 1), 100);
  return query<WorkbenchWorkerIdentityRow>(
    'SELECT * FROM runtime_box_workbench_worker_identities WHERE worker_id=$1 ORDER BY issued_at DESC LIMIT $2',
    [workerId, bounded],
  );
}

/** Fail closed unless the exact jti exists, matches the Worker, is unrevoked, and unexpired. */
export async function assertWorkbenchWorkerIdentityActive(identity: WorkbenchWorkerIdentity): Promise<void> {
  const row = await queryOne<{ active: boolean }>(
    `SELECT (revoked_at IS NULL AND expires_at>NOW() AND worker_id=$2) AS active
     FROM runtime_box_workbench_worker_identities WHERE jti=$1`,
    [identity.jti, identity.workerId],
  );
  if (!row?.active) throw new Error('WORKER_IDENTITY_INACTIVE');
}

/** Revoke one identity idempotently; false means the jti was never issued here. */
export async function revokeWorkbenchWorkerIdentity(input: { jti: string; reason?: string }): Promise<boolean> {
  const result = await execute(
    `UPDATE runtime_box_workbench_worker_identities
     SET revoked_at=COALESCE(revoked_at,NOW()),reason=COALESCE($2,reason) WHERE jti=$1`,
    [input.jti, input.reason?.trim() || null],
  );
  return result.changes === 1;
}

/** Atomically record a replacement and revoke the previous identity with linkage. */
export async function rotateWorkbenchWorkerIdentity(input: {
  previousJti: string;
  replacement: WorkbenchWorkerIdentity;
  issuedByUserId: number;
  reason?: string;
}): Promise<WorkbenchWorkerIdentityRow> {
  return transaction(async client => {
    const db = withClient(client);
    const previous = await db.queryOne<WorkbenchWorkerIdentityRow>(
      'SELECT * FROM runtime_box_workbench_worker_identities WHERE jti=$1 FOR UPDATE', [input.previousJti],
    );
    if (!previous) throw new Error('WORKER_IDENTITY_NOT_FOUND');
    if (previous.worker_id !== input.replacement.workerId) throw new Error('WORKER_IDENTITY_ROTATION_MISMATCH');
    const replacement = await db.queryOne<WorkbenchWorkerIdentityRow>(
      `INSERT INTO runtime_box_workbench_worker_identities(
         jti,worker_id,project_ids,capabilities,issued_by_user_id,expires_at,reason
       ) VALUES($1,$2,$3::text[],$4::text[],$5,$6,$7) RETURNING *`,
      [input.replacement.jti, input.replacement.workerId, input.replacement.projectIds,
        input.replacement.capabilities, input.issuedByUserId, input.replacement.expiresAt, input.reason?.trim() || null],
    );
    if (!replacement) throw new Error('WORKER_IDENTITY_RECORD_FAILED');
    await db.execute(
      `UPDATE runtime_box_workbench_worker_identities
       SET revoked_at=COALESCE(revoked_at,NOW()),replaced_by_jti=$2,reason=COALESCE($3,reason) WHERE jti=$1`,
      [input.previousJti, replacement.jti, input.reason?.trim() || 'rotated'],
    );
    return replacement;
  });
}

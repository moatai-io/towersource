import fs from 'node:fs';
import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';
import { config } from '../../config.js';
import { transaction, withClient } from '../../db/pg-repo.js';
import { verifyWorkbenchWorkerIdentity } from './workbench-worker-identity.js';
import type { WorkbenchWorkerIdentityRow } from './workbench-worker-identity-repository.js';

export const WORKER_RENEW_BEFORE_MS = 7 * 86400_000;
export const WORKER_RENEW_LIFETIME_MS = 30 * 86400_000;

/** Trusted same-host maintenance only, not a Worker self-service API. Keep the
 * revocation handle: revoking this identity invalidates every renewed token.
 * File and DB expiry are checked together so either side of a partial update
 * is retried. No expired or revoked identity is restored. */
export async function renewLocalWorkerIdentity(workerId: string, file: string, now = Date.now()) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o022)) throw new Error('WORKER_RENEW_FILE_UNSAFE');
  const original = fs.readFileSync(file, 'utf8');
  const identity = verifyWorkbenchWorkerIdentity(original.trim());
  if (!identity || identity.workerId !== workerId) throw new Error('WORKER_RENEW_IDENTITY_INVALID');
  return transaction(async client => {
    const db = withClient(client);
    const row = await db.queryOne<WorkbenchWorkerIdentityRow>(
      'SELECT * FROM runtime_box_workbench_worker_identities WHERE jti=$1 FOR UPDATE', [identity.jti]);
    const sameSet = (a: string[], b: string[]) => JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());
    if (!row || row.revoked_at || row.replaced_by_jti || row.worker_id !== workerId
      || !Number.isFinite(Date.parse(row.expires_at)) || Date.parse(row.expires_at) <= now || !sameSet(row.project_ids, identity.projectIds)
      || !sameSet(row.capabilities, identity.capabilities)) throw new Error('WORKER_RENEW_IDENTITY_INACTIVE');
    if (Math.min(Date.parse(identity.expiresAt), Date.parse(row.expires_at)) - now > WORKER_RENEW_BEFORE_MS) return { status: 'not-due' };
    const expiresAt = new Date(now + WORKER_RENEW_LIFETIME_MS).toISOString();
    const claims = jwt.decode(original.trim()) as jwt.JwtPayload;
    const token = jwt.sign({ ...claims, iat: Math.floor(now / 1000), exp: Math.floor(Date.parse(expiresAt) / 1000) }, config.jwtSecret);
    if (fs.readFileSync(file, 'utf8') !== original) throw new Error('WORKER_RENEW_FILE_CHANGED');
    const tmp = `${file}.renew-${crypto.randomUUID()}`;
    try {
      fs.writeFileSync(tmp, `${token}\n`, { flag: 'wx', mode: stat.mode & 0o777 });
      fs.chownSync(tmp, stat.uid, stat.gid);
      await db.execute('UPDATE runtime_box_workbench_worker_identities SET expires_at=$2 WHERE jti=$1', [identity.jti, expiresAt]);
      // A failed commit leaves the old DB expiry (still within the seven-day
      // overlap); the next tick must reconcile, rather than trusting file expiry.
      fs.renameSync(tmp, file);
    } finally { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); }
    return { status: 'renewed', workerId, expiresAt };
  });
}

/** Explicit operator apply API. No automatic startup, CLI env discovery, SSH or DB connection. */
import * as fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import type { PoolClient } from 'pg';
import { prepareProvisionPlan, type ProvisionEvidence } from './provision-plan.js';
import { tokenDigest } from './contract.js';
import type { CustomerTransport } from './provision-customer.js';
import { atomicReplace, exclusiveWrite, privateDirectory, readPrivate, refuse, sha, trustedAncestors, withFileLock } from './provision-files.js';

export interface CentralAdapter {
  inspect(tenantId: string): Promise<{ host: string; database: string; role: string; schemaFingerprint: string;
    tenant: null | { tokenHash: string; titlePrefix: string; label: string; active: boolean } }>;
  insert(tenant: { id: string; titlePrefix: string; label: string }, tokenHash: string): Promise<void>;
}
// Snapshot full table columns, constraints and indexes, not a caller-supplied boolean.
export async function schemaFingerprint(db: Pick<PoolClient, 'query'>): Promise<string> {
  const columns = await db.query(`SELECT table_name,column_name,data_type,is_nullable,column_default
    FROM information_schema.columns WHERE table_schema='public' AND table_name IN ('feedback_tenants','feedback_receipts') ORDER BY table_name,ordinal_position`);
  if (columns.rows.filter(r => r.table_name === 'feedback_tenants').length !== 7
    || columns.rows.filter(r => r.table_name === 'feedback_receipts').length !== 16) refuse();
  const constraints = await db.query(`SELECT c.relname,t.conname,pg_get_constraintdef(t.oid) AS definition
    FROM pg_constraint t JOIN pg_class c ON c.oid=t.conrelid JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public' AND c.relname IN ('feedback_tenants','feedback_receipts') ORDER BY c.relname,t.conname`);
  const indexes = await db.query(`SELECT tablename,indexname,indexdef FROM pg_indexes
    WHERE schemaname='public' AND tablename IN ('feedback_tenants','feedback_receipts') ORDER BY tablename,indexname`);
  return sha(JSON.stringify([columns.rows, constraints.rows, indexes.rows]));
}
export function pgCentralAdapter(db: Pick<PoolClient, 'query'>, observeHost: () => string): CentralAdapter {
  return {
    async inspect(id) {
      const who = await db.query('SELECT current_database() AS database, current_user AS role');
      const fingerprint = await schemaFingerprint(db);
      const row = (await db.query('SELECT token_hash,title_prefix,label,active FROM public.feedback_tenants WHERE id=$1', [id])).rows[0];
      return { host: observeHost(), ...who.rows[0], schemaFingerprint: fingerprint,
        tenant: row ? { tokenHash: row.token_hash, titlePrefix: row.title_prefix, label: row.label, active: row.active } : null };
    },
    async insert(t, tokenHash) {
      // No upsert; a concurrent conflicting row fails and is reconciled on resume.
      await db.query('INSERT INTO public.feedback_tenants(id,token_hash,title_prefix,label,active) VALUES($1,$2,$3,$4,true)',
        [t.id, tokenHash, t.titlePrefix, t.label]);
    },
  };
}
const receiptSchema = z.object({ version: z.literal(1), planHash: z.string().regex(/^[a-f0-9]{64}$/),
  evidenceHash: z.string().regex(/^[a-f0-9]{64}$/), approvalHash: z.string().regex(/^[a-f0-9]{64}$/),
  phase: z.enum(['prepared','central-enrolled','customer-configured']),
}).strict();
export interface ApplyDependencies {
  central: CentralAdapter; customer: CustomerTransport;
  secretDirectory: string;
  // Must read and hash the reviewed protected backup + schema source, not trust booleans.
  verifyBackupAndSource: () => Promise<{ backupSha256: string; sourceSha256: string }>;
  checkAncestors?: (dir: string) => void;
}
/** Bind only explicit reviewed paths. Large backup files are streamed, never printed.
 * This verifies bytes, not pg_restore success; restore/list verification remains a gate.
 */
export function fileBackupAndSourceVerifier(backupFile: string, sourceFile: string) {
  return async () => {
    const hashFile = async (file: string, backup: boolean) => {
      if (!path.isAbsolute(file) || path.normalize(file) !== file || fs.realpathSync(file) !== file) refuse();
      const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
      try {
        const before = fs.fstatSync(fd);
        if (!before.isFile() || before.nlink !== 1 || before.size === 0
          || (backup && (before.uid !== process.geteuid!() || (before.mode & 0o7777) !== 0o600))) refuse();
        const { createHash } = await import('node:crypto'); const hash = createHash('sha256');
        const buffer = Buffer.alloc(65536); let count: number;
        while ((count = fs.readSync(fd, buffer, 0, buffer.length, null)) > 0) hash.update(buffer.subarray(0,count));
        const after = fs.fstatSync(fd);
        if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) refuse();
        return hash.digest('hex');
      } finally { fs.closeSync(fd); }
    };
    return { backupSha256: await hashFile(backupFile,true), sourceSha256: await hashFile(sourceFile,false) };
  };
}
export interface ApplyApproval { planHash: string; evidenceHash: string; schemaFingerprint: string; backupSha256: string }
const hashPattern = /^[a-f0-9]{64}$/;

/** `args` is a CLI-style explicit contract: []/['--dry-run'] never mutate;
 * ['--apply','--approve-plan',H,'--approve-evidence',H] is required for writes.
 * Caller supplies separately reviewed schema fingerprint and backup hash.
 */
export async function provisionFeedback(evidence: ProvisionEvidence, approval: ApplyApproval,
  deps: ApplyDependencies, args: string[] = []) {
  try {
    const p = prepareProvisionPlan(evidence);
    if (Object.values(approval).some(v => !hashPattern.test(v)) || approval.planHash !== p.planHash || approval.evidenceHash !== p.evidenceHash) refuse();
    const dry = args.length === 0 || (args.length === 1 && args[0] === '--dry-run');
    if (!dry && JSON.stringify(args) !== JSON.stringify(['--apply','--approve-plan',p.planHash,'--approve-evidence',p.evidenceHash])) refuse();
    // Initial reviewed evidence only. Resume uses durable original approval, not forged refreshed booleans.
    if (evidence.enrollment.receiptPhase !== 'none' || evidence.enrollment.tenantExists || evidence.enrollment.customerConfigured) refuse();
    privateDirectory(deps.secretDirectory); (deps.checkAncestors ?? trustedAncestors)(deps.secretDirectory);
    const receiptPath = path.join(deps.secretDirectory, `${p.planHash}.receipt.json`);
    const tokenPath = path.join(deps.secretDirectory, `${p.planHash}.token`);
    const approvalHash = sha(JSON.stringify(approval));
    const run = async () => {
      let receipt = fs.existsSync(receiptPath) ? receiptSchema.parse(JSON.parse(readPrivate(receiptPath).toString())) : undefined;
      if (receipt && (receipt.planHash !== p.planHash || receipt.evidenceHash !== p.evidenceHash || receipt.approvalHash !== approvalHash)) refuse();
      let token = fs.existsSync(tokenPath) ? readPrivate(tokenPath).toString('utf8') : undefined;
      if ((token && (!receipt || !/^[A-Za-z0-9_-]{43}$/.test(token))) || (receipt && !token)) refuse();
      const verify = async () => {
        const backup = await deps.verifyBackupAndSource();
        if (backup.backupSha256 !== approval.backupSha256 || backup.sourceSha256 !== p.target.schemaSha256) refuse();
        const c = await deps.central.inspect(p.target.tenant.id);
        if (c.host !== p.target.central.host || c.database !== p.target.central.database || c.role !== p.target.central.role
          || c.schemaFingerprint !== approval.schemaFingerprint) refuse();
        const customer = await deps.customer.inspect(token, p.target.central.origin);
        if (customer.host !== p.target.customer.host || customer.uid !== p.target.customer.uid || customer.envPath !== p.target.customer.envPath) refuse();
        if (c.tenant && (!receipt || !token || c.tenant.tokenHash !== tokenDigest(token)
          || c.tenant.titlePrefix !== p.target.tenant.titlePrefix || c.tenant.label !== p.target.tenant.label || !c.tenant.active)) refuse();
        if (!c.tenant && (receipt?.phase === 'central-enrolled' || receipt?.phase === 'customer-configured')) refuse();
        if (!customer.empty && (!receipt || !c.tenant || !customer.matches)) refuse();
        if (customer.empty && (customer.hash !== p.envPreimageSha256 || receipt?.phase === 'customer-configured')) refuse();
        return { c, customer };
      };
      let observed = await verify();
      if (dry) return { mode: 'dry-run', planHash: p.planHash, evidenceHash: p.evidenceHash,
        next: observed.customer.matches ? 'complete' : observed.c.tenant ? 'append-customer' : 'insert-central' };
      const save = (phase: 'prepared' | 'central-enrolled' | 'customer-configured') => {
        const next = { version: 1 as const, planHash: p.planHash, evidenceHash: p.evidenceHash, approvalHash, phase };
        if (!receipt) exclusiveWrite(receiptPath, JSON.stringify(next));
        else {
          const previous = sha(readPrivate(receiptPath));
          atomicReplace(receiptPath, JSON.stringify(next), () => { if (sha(readPrivate(receiptPath)) !== previous) refuse(); });
        }
        receipt = next;
      };
      if (!receipt) {
        save('prepared');
        // Only real apply reaches randomness. Persist before any remote/DB effect.
        token = randomBytes(32).toString('base64url'); exclusiveWrite(tokenPath, token);
      }
      observed = await verify();
      if (!observed.c.tenant) {
        await deps.central.insert(p.target.tenant, tokenDigest(token!));
        observed = await verify(); if (!observed.c.tenant) refuse();
      }
      if (receipt?.phase !== 'customer-configured') save('central-enrolled');
      // Full direct evidence recheck just before the cross-machine step.
      observed = await verify();
      if (!observed.customer.matches) {
        const input = Buffer.from(JSON.stringify({ version: 1, planHash: p.planHash,
          host: p.target.customer.host, uid: p.target.customer.uid, envPath: p.target.customer.envPath,
          preimage: p.envPreimageSha256, origin: p.target.central.origin, token }));
        try { await deps.customer.appendStdin(input); } finally { input.fill(0); }
      }
      observed = await verify(); if (!observed.customer.matches) refuse();
      if (receipt?.phase !== 'customer-configured') save('customer-configured');
      return { mode: 'applied', planHash: p.planHash, evidenceHash: p.evidenceHash, phase: 'customer-configured', restartPerformed: false };
    };
    return await (dry ? run() : withFileLock(path.join(deps.secretDirectory, 'enrollment.lock'), run));
  } catch { refuse(); }
}

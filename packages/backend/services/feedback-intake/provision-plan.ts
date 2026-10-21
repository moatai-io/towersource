/** Operator-only, secret-free enrollment planner. No DB, SSH, env-file or token IO.
 * This is deliberately NOT an apply executor. Evidence must be gathered by an
 * approved operator and rechecked immediately before separately approved writes.
 */
import { createHash } from 'node:crypto';
import { z } from 'zod';

export const FEEDBACK_SCHEMA_SHA256 = '59eb14cc7db190d86506ab13fc6ce904af6217ec1a9ceb9e3fede50b8802b8a3';
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const identity = z.string().regex(/^[a-z0-9][a-z0-9.-]{0,120}$/);
const databaseIdentity = z.string().regex(/^[A-Za-z_][A-Za-z0-9_-]{0,62}$/);
const absolute = z.string().regex(/^\/[A-Za-z0-9_./-]+$/).refine(p => !p.split('/').some(x => x === '..' || x === '.') && !p.includes('//'));
const envKeys = ['TOWER_FEEDBACK_CLIENT_TOKEN', 'TOWER_FEEDBACK_CLIENT_ENABLED', 'TOWER_FEEDBACK_INTAKE_ORIGIN'] as const;
const schema = z.object({
  version: z.literal(1), revision: z.string().regex(/^[a-f0-9]{40}$/),
  central: z.object({ expectedHost: identity, observedHost: identity, expectedDatabase: databaseIdentity, observedDatabase: databaseIdentity,
    expectedRole: databaseIdentity, observedRole: databaseIdentity, origin: z.string().url() }).strict(),
  customer: z.object({ expectedHost: identity, observedHost: identity, expectedBackendUid: z.number().int().nonnegative(),
    observedBackendUid: z.number().int().nonnegative(), envPath: absolute }).strict(),
  tenant: z.object({ id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/),
    titlePrefix: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9 _.-]{0,59}$/),
    label: z.string().regex(/^customer:[a-z0-9][a-z0-9-]{0,62}$/) }).strict(),
  schema: z.object({ sourceSha256: hash, liveDefinitionMatches: z.boolean(), tables: z.array(z.enum(['feedback_tenants','feedback_receipts'])).length(2), backupVerified: z.boolean() }).strict(),
  env: z.object({ contentSha256: hash, regularSingleLink: z.boolean(), canonicalNoSymlinks: z.boolean(),
    mode: z.literal('0600'), ownerUid: z.number().int().nonnegative(), parentTrusted: z.boolean(),
    // Presence and equality only. Never include existing values, token or token hash.
    keys: z.array(z.object({ name: z.enum(envKeys), count: z.number().int().min(0).max(100),
      matchesIntended: z.boolean() }).strict()).length(3) }).strict(),
  enrollment: z.object({ tenantExists: z.boolean(), tenantMatchesIntended: z.boolean(),
    sameTokenConfirmedInMemory: z.boolean(), customerConfigured: z.boolean(),
    // Cross-system reconciliation, not permission to mint a replacement token.
    receiptPhase: z.enum(['none','prepared','central-enrolled','customer-configured','verified']),
    receiptPlanHash: hash.optional() }).strict(),
}).strict();
export type ProvisionEvidence = z.infer<typeof schema>;
const digest = (s: string) => createHash('sha256').update(s).digest('hex');
export class ProvisionPlanError extends Error {
  constructor() { super('feedback_provision_plan_invalid'); }
}
export function prepareProvisionPlan(input: unknown) {
  try {
    const e = schema.parse(input);
    const u = new URL(e.central.origin);
    if (u.protocol !== 'https:' || u.username || u.password || u.pathname !== '/' || u.search || u.hash) throw new Error();
    if (e.central.expectedHost !== e.central.observedHost || e.central.expectedDatabase !== e.central.observedDatabase
      || e.central.expectedRole !== e.central.observedRole || e.customer.expectedHost !== e.customer.observedHost
      || e.customer.expectedBackendUid !== e.customer.observedBackendUid
      || e.central.expectedHost === e.customer.expectedHost || e.tenant.label !== `customer:${e.tenant.id}`) throw new Error();
    if (e.schema.sourceSha256 !== FEEDBACK_SCHEMA_SHA256 || !e.schema.liveDefinitionMatches || !e.schema.backupVerified
      || new Set(e.schema.tables).size !== 2) throw new Error();
    if (!e.env.regularSingleLink || !e.env.canonicalNoSymlinks || !e.env.parentTrusted
      || e.env.ownerUid !== e.customer.expectedBackendUid || new Set(e.env.keys.map(k => k.name)).size !== 3) throw new Error();
    if (e.env.keys.some(k => k.count > 1 || (k.count === 1 && !k.matchesIntended))) throw new Error();
    // Plan identity is stable across resume; env preimage is separately rechecked per step.
    const target = { version: e.version, revision: e.revision, central: { host: e.central.expectedHost,
      database: e.central.expectedDatabase, role: e.central.expectedRole, origin: u.origin },
      customer: { host: e.customer.expectedHost, uid: e.customer.expectedBackendUid, envPath: e.customer.envPath },
      tenant: e.tenant, schemaSha256: e.schema.sourceSha256 };
    const planHash = digest(JSON.stringify(target));
    const state = e.enrollment;
    if (state.receiptPhase === 'none' && (state.tenantExists || state.customerConfigured || e.env.keys.some(k => k.count))) throw new Error();
    if (state.receiptPhase !== 'none' && state.receiptPlanHash !== planHash) throw new Error();
    if (state.tenantExists && (!state.tenantMatchesIntended || !state.sameTokenConfirmedInMemory)) throw new Error();
    if (!state.tenantExists && ['central-enrolled','customer-configured','verified'].includes(state.receiptPhase)) throw new Error();
    if (state.customerConfigured && (!state.tenantExists || e.env.keys.some(k => k.count !== 1 || !k.matchesIntended))) throw new Error();
    if (['customer-configured','verified'].includes(state.receiptPhase) && !state.customerConfigured) throw new Error();
    if (!state.customerConfigured && e.env.keys.some(k => k.count !== 0)) throw new Error();
    const next = state.receiptPhase === 'verified' ? 'complete'
      : state.customerConfigured ? 'verify-receipt-and-backend'
      : state.tenantExists ? 'install-customer-env-with-same-token' : 'insert-central-tenant';
    return { mode: 'plan-only' as const, applySupported: false, planHash,
      // Approval/review binds this observation too. A stable target hash alone
      // must never authorize a changed env preimage or newly observed state.
      evidenceHash: digest(JSON.stringify(e)), evidenceVerifiedByPlanner: false,
      target, next,
      envPreimageSha256: e.env.contentSha256,
      appendOnlyEnvKeys: [...envKeys],
      requirements: ['recheck-live-identities-schema-and-env-preimage', 'explicit-exact-plan-approval',
        'token-stdin-only-no-argv-no-output', 'hash-namespace:tower-feedback-token:v1:',
        'insert-only-no-conflict-upsert-no-rotation', 'exclusive-operation-lock',
        'private-backup-before-env-write', 'preserve-unrelated-env-bytes',
        'same-directory-exclusive-temp-0600-fsync-atomic-rename-directory-fsync',
        'durable-secret-free-receipt-before-and-after-each-step',
        'on-ambiguous-write-reconcile-before-retry-no-new-token'] };
  } catch { throw new ProvisionPlanError(); }
}

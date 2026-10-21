/** Operator-only aggregate diagnostics. No application startup, secret-file reads,
 * GitHub requests, enrollment, retries, schema application or automatic cleanup.
 */
import { clientConfig, clientEnabled, deliveryEnabled, intakeEnabled } from './config.js';

export type FlagState = 'default_off' | 'off' | 'on' | 'invalid';
export type ConfigState = 'not_configured' | 'valid' | 'invalid';
const flag = (value: string | undefined): FlagState => value === undefined ? 'default_off'
  : value === 'true' ? 'on' : value === 'false' ? 'off' : 'invalid';

export function feedbackConfigurationSnapshot(env: NodeJS.ProcessEnv) {
  let client: ConfigState = 'not_configured';
  if (env.TOWER_FEEDBACK_INTAKE_ORIGIN !== undefined || env.TOWER_FEEDBACK_CLIENT_TOKEN !== undefined) {
    try { clientConfig(env); client = 'valid'; } catch { client = 'invalid'; }
  }
  // Do not call githubConfig: it opens the backend-only private key file.
  // Mirror its non-secret identity checks; signing material remains UNVERIFIED.
  const fields = [env.TOWER_FEEDBACK_GITHUB_APP_ID, env.TOWER_FEEDBACK_GITHUB_INSTALLATION_ID,
    env.TOWER_FEEDBACK_GITHUB_REPOSITORY_ID, env.TOWER_FEEDBACK_GITHUB_REPOSITORY];
  const repositoryId = Number(fields[2]);
  const metadata: ConfigState = fields.every(value => value === undefined) ? 'not_configured'
    : /^[1-9][0-9]*$/.test(fields[0] ?? '') && /^[1-9][0-9]*$/.test(fields[1] ?? '')
      && Number.isSafeInteger(repositoryId) && repositoryId > 0
      && /^[A-Za-z0-9_-][A-Za-z0-9_.-]*\/[A-Za-z0-9_-][A-Za-z0-9_.-]*$/.test(fields[3] ?? '') ? 'valid' : 'invalid';
  // File setting takes precedence, including an empty setting; never inspect the file.
  const signingSetting = env.TOWER_FEEDBACK_GITHUB_KEY_FILE ?? env.TOWER_FEEDBACK_GITHUB_PRIVATE_KEY;
  return {
    flags: {
      client: flag(env.TOWER_FEEDBACK_CLIENT_ENABLED), intake: flag(env.TOWER_FEEDBACK_INTAKE_ENABLED),
      delivery: flag(env.TOWER_FEEDBACK_DELIVERY_ENABLED), candidatePassive: flag(env.TOWER_CANDIDATE_PASSIVE_MODE),
    },
    effective: {
      clientRouting: clientEnabled(env) ? 'central' as const : 'legacy' as const,
      intake: intakeEnabled(env) && env.TOWER_CANDIDATE_PASSIVE_MODE !== 'true' ? 'enabled' as const : 'off' as const,
      // A flag gate is not proof that a pump started, its key loaded or delivery succeeded.
      deliveryGate: deliveryEnabled(env) ? 'enabled' as const : 'off' as const,
    },
    configuration: {
      client, githubMetadata: metadata,
      signingMaterial: signingSetting === undefined ? 'not_configured' as const
        : signingSetting.length === 0 ? 'invalid' as const : 'configured_unverified' as const,
      providerAuthentication: 'not_checked' as const,
    },
  };
}

export interface DiagnosticConnection {
  query(sql: string, values?: string[]): Promise<{ rows: Record<string, unknown>[] }>;
  end(): Promise<unknown>;
}
export type DiagnosticConnector = (env: NodeJS.ProcessEnv) => Promise<DiagnosticConnection>;
export type TableState = 'not_checked' | 'missing' | 'access_denied' | 'unsupported_relation'
  | 'row_security_limited' | 'schema_mismatch' | 'query_failed' | 'available';
export interface TableObservation {
  state: TableState;
  permissions?: { schemaUsage: boolean; select: boolean; insert: boolean; update: boolean; delete: boolean };
  rowSecurityActive?: boolean;
}
export interface TenantObservation extends TableObservation { counts?: { total: number; active: number; inactive: number } }
export interface ReceiptObservation extends TableObservation {
  counts?: { total: number; accepted: number; delivering: number; delivered: number; needs_review: number; failed: number; other: number };
  latestCreatedAt?: string | null;
  latestUpdatedAt?: string | null;
  oldestPendingAt?: string | null;
}
export interface DatabaseObservation {
  state: 'not_configured' | 'not_requested' | 'invalid_configuration' | 'unavailable' | 'available';
  tenants: TenantObservation;
  receipts: ReceiptObservation;
}
export class DiagnosticConfigurationError extends Error {
  constructor() { super('feedback_diagnostics_invalid_database_configuration'); }
}

const tableError = (error: unknown): TableState => {
  const code = (error as { code?: unknown } | null)?.code;
  return code === '42501' ? 'access_denied' : code === '42P01' ? 'missing'
    : code === '42703' ? 'schema_mismatch' : 'query_failed';
};
function count(value: unknown): number {
  if (!(typeof value === 'string' && /^\d+$/.test(value)) && typeof value !== 'number') throw new Error();
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) throw new Error();
  return number;
}
function timestamp(value: unknown): string | null {
  if (value === null) return null;
  if (!(value instanceof Date) && !(typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(value))) throw new Error();
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error();
  return date.toISOString();
}
function boolean(value: unknown): boolean { if (typeof value !== 'boolean') throw new Error(); return value; }

async function tableSnapshot(db: DiagnosticConnection, name: 'feedback_tenants' | 'feedback_receipts'): Promise<TenantObservation | ReceiptObservation> {
  await db.query('SAVEPOINT feedback_diagnostics_table');
  try {
    const { rows } = await db.query(`SELECT c.relkind,
      has_schema_privilege(c.relnamespace, 'USAGE') AS schema_usage,
      has_table_privilege(c.oid, 'SELECT') AS can_select,
      has_table_privilege(c.oid, 'INSERT') AS can_insert,
      has_table_privilege(c.oid, 'UPDATE') AS can_update,
      has_table_privilege(c.oid, 'DELETE') AS can_delete,
      row_security_active(c.oid) AS rls_active
      FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relname = $1`, [name]);
    const row = rows[0];
    if (!row) return { state: 'missing' };
    const common = {
      permissions: { schemaUsage: boolean(row.schema_usage), select: boolean(row.can_select),
        insert: boolean(row.can_insert), update: boolean(row.can_update), delete: boolean(row.can_delete) },
      rowSecurityActive: boolean(row.rls_active),
    };
    // Views/foreign tables could execute arbitrary remote or user-defined logic.
    if (row.relkind !== 'r' && row.relkind !== 'p') return { ...common, state: 'unsupported_relation' };
    if (!common.permissions.schemaUsage || !common.permissions.select) return { ...common, state: 'access_denied' };
    // RLS-filtered zero is not evidence that the shared inbox is empty.
    if (common.rowSecurityActive) return { ...common, state: 'row_security_limited' };
    if (name === 'feedback_tenants') {
      const aggregate = (await db.query(`SELECT count(*) AS total,
        count(*) FILTER (WHERE active) AS active, count(*) FILTER (WHERE NOT active) AS inactive
        FROM public.feedback_tenants`)).rows[0];
      return { ...common, state: 'available', counts: { total: count(aggregate.total),
        active: count(aggregate.active), inactive: count(aggregate.inactive) } };
    }
    const aggregate = (await db.query(`SELECT count(*) AS total,
      count(*) FILTER (WHERE status = 'accepted') AS accepted,
      count(*) FILTER (WHERE status = 'delivering') AS delivering,
      count(*) FILTER (WHERE status = 'delivered') AS delivered,
      count(*) FILTER (WHERE status = 'needs_review') AS needs_review,
      count(*) FILTER (WHERE status = 'failed') AS failed,
      count(*) FILTER (WHERE status IS NULL OR status NOT IN ('accepted','delivering','delivered','needs_review','failed')) AS other,
      max(created_at) AS latest_created_at, max(updated_at) AS latest_updated_at,
      min(created_at) FILTER (WHERE status IN ('accepted','delivering')) AS oldest_pending_at
      FROM public.feedback_receipts`)).rows[0];
    return { ...common, state: 'available', counts: {
      total: count(aggregate.total), accepted: count(aggregate.accepted), delivering: count(aggregate.delivering),
      delivered: count(aggregate.delivered), needs_review: count(aggregate.needs_review), failed: count(aggregate.failed), other: count(aggregate.other),
    }, latestCreatedAt: timestamp(aggregate.latest_created_at), latestUpdatedAt: timestamp(aggregate.latest_updated_at),
    oldestPendingAt: timestamp(aggregate.oldest_pending_at) };
  } catch (error) {
    await db.query('ROLLBACK TO SAVEPOINT feedback_diagnostics_table');
    return { state: tableError(error) };
  } finally { await db.query('RELEASE SAVEPOINT feedback_diagnostics_table'); }
}

/** Caller supplies the exact execution environment. Never loads dotenv or a
 * process/service environment file. DB query results are projected, never spread.
 */
export async function diagnoseFeedback(env: NodeJS.ProcessEnv, connect: DiagnosticConnector, options: { database?: boolean } = {}) {
  const snapshot = feedbackConfigurationSnapshot(env);
  let database: DatabaseObservation = { state: options.database === false ? 'not_requested' : 'not_configured',
    tenants: { state: 'not_checked' }, receipts: { state: 'not_checked' } };
  if (options.database !== false && env.DATABASE_URL !== undefined) {
    let db: DiagnosticConnection | undefined;
    try {
      db = await connect(env);
      await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      await db.query("SET LOCAL search_path = pg_catalog");
      await db.query("SET LOCAL statement_timeout = '3s'");
      await db.query("SET LOCAL lock_timeout = '1s'");
      // This role sees either the complete table or an error, never filtered counts.
      await db.query('SET LOCAL row_security = off');
      const tenants = await tableSnapshot(db, 'feedback_tenants') as TenantObservation;
      const receipts = await tableSnapshot(db, 'feedback_receipts') as ReceiptObservation;
      database = { state: 'available', tenants, receipts };
    } catch (error) {
      database = { state: error instanceof DiagnosticConfigurationError ? 'invalid_configuration' : 'unavailable',
        tenants: { state: 'not_checked' }, receipts: { state: 'not_checked' } };
    } finally {
      if (db) { await db.query('ROLLBACK').catch(() => {}); await db.end().catch(() => {}); }
    }
  }
  const counts = database.receipts.counts;
  const pending = counts ? counts.accepted + counts.delivering : null;
  const attention = counts ? counts.needs_review + counts.failed + counts.other : null;
  return { version: 1, scope: 'current_command_environment_only', ...snapshot, database,
    activity: { evidence: !counts ? 'unknown' : counts.total > 0 ? 'receipts_observed' : 'no_receipts_observed',
      pending, attention, deliveryOffWithPending: pending === null ? null : pending > 0 && snapshot.effective.deliveryGate === 'off' },
    // Never infer "unused", "active service", "safe to delete" or successful GitHub auth.
    liveServiceVerified: false,
  };
}

/** Isolated read-only PG connection; deliberately does not import db/pg.ts. */
import { Client, type ClientConfig } from 'pg';
import { DiagnosticConfigurationError, type DiagnosticConnection } from './diagnostics.js';

// Private to the connector: never return parsed connection settings as diagnostics.
function connectionOptions(env: NodeJS.ProcessEnv): ClientConfig {
  try {
    const url = new URL(env.DATABASE_URL ?? '');
    if (!['postgres:', 'postgresql:'].includes(url.protocol) || !url.hostname || !url.username
      || url.hash || !/^\/[^/]+$/.test(url.pathname)) throw new Error();
    const host = url.hostname.replace(/^\[|\]$/g, '');
    const port = url.port ? Number(url.port) : 5432;
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error();
    // Reject sslcert/sslkey/sslrootcert (implicit file reads), service files,
    // arbitrary startup options, host overrides and ambiguous repeated options.
    const entries = [...url.searchParams.entries()];
    if (entries.length > 1 || entries.some(([name]) => name !== 'sslmode')) throw new Error();
    const mode = url.searchParams.get('sslmode');
    if (mode !== null && !['disable', 'require', 'verify-full'].includes(mode)) throw new Error();
    const local = ['localhost', '127.0.0.1', '::1'].includes(host);
    if (mode === 'disable' && !local) throw new Error();
    const password = decodeURIComponent(url.password);
    return { host, port, database: decodeURIComponent(url.pathname.slice(1)), user: decodeURIComponent(url.username),
      // An explicit callback avoids .pgpass/PGPASSWORD fallback, even for empty passwords.
      password: async () => password,
      ssl: mode === 'disable' || (local && mode === null) ? false : { rejectUnauthorized: true },
      application_name: 'tower-feedback-diagnostics',
      connectionTimeoutMillis: 5000, statement_timeout: 3000, query_timeout: 4000,
      options: '-c default_transaction_read_only=on -c search_path=pg_catalog -c idle_in_transaction_session_timeout=5000',
    };
  } catch { throw new DiagnosticConfigurationError(); }
}

export async function connectDiagnosticPg(env: NodeJS.ProcessEnv): Promise<DiagnosticConnection> {
  const client = new Client(connectionOptions(env));
  // Never print pg errors; provider errors can contain connection identities.
  client.on('error', () => {});
  try { await client.connect(); return client; }
  catch { await client.end().catch(() => {}); throw new Error('feedback_diagnostics_database_unavailable'); }
}

import { afterEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ construct: vi.fn(), connect: vi.fn(), end: vi.fn(), on: vi.fn() }));
vi.mock('pg', () => ({ Client: class {
  constructor(options: unknown) { mocks.construct(options); }
  connect = mocks.connect;
  end = mocks.end;
  on = mocks.on;
} }));
import { connectDiagnosticPg } from './diagnostics-pg.js';
import { diagnoseFeedback } from './diagnostics.js';
afterEach(() => { vi.resetAllMocks(); });
describe('isolated diagnostics PG connector', () => {
  it('uses only the provided URL and bounds read-only sessions without implicit password-file fallback', async () => {
    await connectDiagnosticPg({ DATABASE_URL: 'postgresql://diagnostic:synthetic-password@localhost:55442/fixture',
      PGHOST: 'must-not-use', PGUSER: 'must-not-use', PGSSLMODE: 'no-verify' });
    const config = mocks.construct.mock.calls[0][0];
    expect(config).toMatchObject({ host: 'localhost', port: 55442, user: 'diagnostic', database: 'fixture', ssl: false,
      connectionTimeoutMillis: 5000, statement_timeout: 3000, query_timeout: 4000 });
    expect(config.options).toContain('default_transaction_read_only=on');
    expect(config.options).toContain('idle_in_transaction_session_timeout=5000');
    expect(typeof config.password).toBe('function'); expect(await config.password()).toBe('synthetic-password');
    expect(config.connectionString).toBeUndefined();
  });
  it('uses a password callback even when empty to prevent .pgpass fallback', async () => {
    await connectDiagnosticPg({ DATABASE_URL: 'postgresql://diagnostic@localhost/fixture' });
    expect(await mocks.construct.mock.calls[0][0].password()).toBe('');
  });
  it.each(['', '?sslmode=require', '?sslmode=verify-full'])('requires verified TLS for remote connections %s', async suffix => {
    await connectDiagnosticPg({ DATABASE_URL: `postgresql://diagnostic@db.example.com/fixture${suffix}` });
    expect(mocks.construct.mock.calls[0][0].ssl).toEqual({ rejectUnauthorized: true });
  });
  it.each(['', 'https://db.example.com', 'postgresql://localhost/fixture', 'postgresql://diagnostic@localhost/',
    'postgresql://diagnostic@db.example.com/fixture?sslmode=disable',
    'postgresql://diagnostic@localhost/fixture?sslkey=/synthetic-private-key',
    'postgresql://diagnostic@localhost/fixture?sslrootcert=/synthetic-private-file',
    'postgresql://diagnostic@localhost/fixture?sslmode=require&sslmode=disable',
    'postgresql://diagnostic@localhost/fixture?options=-c%20default_transaction_read_only=off',
    'postgresql://diagnostic@localhost/fixture?host=/private/socket',
    'postgresql://diagnostic@localhost/fixture?sslmode=no-verify'])('rejects unsupported input before PG construction', async value => {
    const result = await diagnoseFeedback({ DATABASE_URL: value }, connectDiagnosticPg);
    expect(result.database.state).toBe('invalid_configuration'); expect(mocks.construct).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain('synthetic-private');
  });
  it('discards database connection errors and closes failed connections', async () => {
    mocks.connect.mockRejectedValue(new Error('synthetic-private-connection-string'));
    mocks.end.mockResolvedValue(undefined);
    const result = await diagnoseFeedback({ DATABASE_URL: 'postgresql://diagnostic@localhost/fixture' }, connectDiagnosticPg);
    expect(result.database.state).toBe('unavailable'); expect(mocks.end).toHaveBeenCalledOnce();
    expect(JSON.stringify(result)).not.toContain('synthetic-private');
  });
});

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { Pool, type PoolClient } from 'pg';

const name = `tower-user-lock-it-${process.pid}-${Date.now()}`;
const docker = (...args: string[]) => execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
let started = false;
let pool: Pool;
let closePgPool: () => Promise<void>;
let sut: typeof import('./user-management.js');
let actorId: number;
async function target(role = 'member') {
  return (await pool.query<{ id: number }>(
    "INSERT INTO users(username,password_hash,role,disabled,approval_status) VALUES($1,'synthetic-hash',$2,1,'active') RETURNING id",
    [`target-${Date.now()}-${Math.random().toString(36).slice(2)}`, role],
  )).rows[0].id;
}
async function lockAndPromote(id: number, role: 'operator' | 'admin'): Promise<PoolClient> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('UPDATE users SET role=$2 WHERE id=$1', [id, role]);
    return client;
  } catch (error) { await client.query('ROLLBACK'); client.release(); throw error; }
}
async function releasePromotion(client: PoolClient) {
  try { await client.query('COMMIT'); } finally { client.release(); }
}
async function waitUntilBlocked(blocker: PoolClient): Promise<void> {
  const pid = blocker.processID;
  for (let attempt = 0; attempt < 80; attempt++) {
    const { rows } = await pool.query<{ blocked: boolean }>(
      'SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid))) AS blocked', [pid],
    );
    if (rows[0].blocked) return;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error('The second real PostgreSQL connection did not block on the first connection');
}

beforeAll(async () => {
  // The container owns a disposable loopback DB; never reuse a host/shared DB.
  docker('run', '-d', '--rm', '--pull=never', '--name', name, '-e', 'POSTGRES_HOST_AUTH_METHOD=trust',
    '-e', 'POSTGRES_DB=user_lock_test', '-p', '127.0.0.1::5432', 'postgres:16-alpine');
  started = true;
  const port = Number(docker('port', name, '5432/tcp').match(/:(\d+)$/)?.[1]);
  if (!Number.isSafeInteger(port) || port <= 0) throw new Error('Isolated PostgreSQL port missing');
  const url = `postgresql://postgres@127.0.0.1:${port}/user_lock_test`;
  if (new URL(url).pathname === new URL(process.env.DATABASE_URL || 'postgresql://localhost/tower_chat').pathname) throw new Error('Refusing shared database');
  process.env.DATABASE_URL = url;
  process.env.JWT_SECRET = 'isolated-user-lock-test-secret';
  const pg = await import('../../db/pg.js');
  closePgPool = pg.closePgPool;
  let ready = false;
  for (let i = 0; i < 40; i++) {
    try { await pg.getPgPool().query('SELECT 1'); ready = true; break; }
    catch { await new Promise(resolve => setTimeout(resolve, 300)); }
  }
  if (!ready) throw new Error('Isolated PostgreSQL did not start');
  await pg.initPg();
  pool = pg.getPgPool();
  const identity = await pool.query('SELECT current_database() AS name, inet_server_port() AS port');
  if (identity.rows[0].name !== 'user_lock_test' || Number(identity.rows[0].port) !== 5432) throw new Error('DB identity mismatch');
  actorId = (await pool.query<{ id: number }>(
    "INSERT INTO users(username,password_hash,role,disabled,approval_status) VALUES('synthetic-operator','synthetic-hash','operator',0,'active') RETURNING id",
  )).rows[0].id;
  sut = await import('./user-management.js');
}, 120_000);
afterAll(async () => {
  if (closePgPool) await closePgPool();
  if (started) docker('rm', '-f', '-v', name);
}, 30_000);

describe('isolated real PostgreSQL user-management locks', () => {
  it('waits for a concurrent promotion and blocks operator reactivation with an audited outcome', async () => {
    const id = await target();
    const blocker = await lockAndPromote(id, 'operator');
    let result: ReturnType<typeof sut.reactivateUser>;
    try {
      result = sut.reactivateUser({ userId: id, actorUserId: actorId, actorRole: 'operator' });
      await waitUntilBlocked(blocker);
    } finally { await releasePromotion(blocker); }
    expect(await result!).toBe('forbidden');
    expect((await pool.query('SELECT role,disabled,auth_epoch FROM users WHERE id=$1', [id])).rows[0])
      .toMatchObject({ role: 'operator', disabled: 1, auth_epoch: 0 });
    const event = (await pool.query("SELECT actor_user_id,target_user_id,result,metadata FROM account_security_events WHERE target_user_id=$1 AND event_type='user_reactivation'", [id])).rows[0];
    expect(event).toMatchObject({ actor_user_id: actorId, target_user_id: id, result: 'blocked', metadata: { outcome: 'forbidden' } });
  });
  it('waits for a concurrent promotion and never exposes privileged login events', async () => {
    const id = await target();
    await pool.query("INSERT INTO auth_login_events(user_id,username,event_type,ip_address) VALUES($1,'synthetic','login_success','198.51.100.20')", [id]);
    const blocker = await lockAndPromote(id, 'admin');
    let result: ReturnType<typeof sut.listUserAuthEvents>;
    try {
      result = sut.listUserAuthEvents({ userId: id, actorRole: 'operator' });
      await waitUntilBlocked(blocker);
    } finally { await releasePromotion(blocker); }
    expect(await result!).toBe('forbidden');
  });
  it('waits for a promotion and refuses an operator rename under the target lock', async () => {
    const { updateUserUsername, UserManagementForbiddenError } = await import('./auth.js');
    const id = await target();
    const prior = (await pool.query('SELECT username FROM users WHERE id=$1', [id])).rows[0].username as string;
    const blocker = await lockAndPromote(id, 'operator');
    let assertion: Promise<void> | undefined;
    try {
      // Attach the rejection handler before releasing the database lock.
      assertion = expect(updateUserUsername(id, `renamed-${id}`, actorId, { actorRole: 'operator' }))
        .rejects.toBeInstanceOf(UserManagementForbiddenError);
      await waitUntilBlocked(blocker);
    } finally { await releasePromotion(blocker); }
    await assertion;
    expect((await pool.query('SELECT username,role FROM users WHERE id=$1', [id])).rows[0])
      .toMatchObject({ username: prior, role: 'operator' });
    expect((await pool.query('SELECT count(*)::int AS count FROM user_username_history WHERE user_id=$1', [id])).rows[0].count).toBe(0);
  });
  it('waits for a promotion and refuses an operator profile update', async () => {
    const { updateUserProfile } = await import('./auth.js');
    const id = await target();
    const blocker = await lockAndPromote(id, 'operator');
    let result: ReturnType<typeof updateUserProfile>;
    try {
      result = updateUserProfile(id, { displayName: 'should-not-write' }, 'operator');
      await waitUntilBlocked(blocker);
    } finally { await releasePromotion(blocker); }
    expect(await result!).toBe(false);
    expect((await pool.query('SELECT display_name,role FROM users WHERE id=$1', [id])).rows[0])
      .toMatchObject({ display_name: null, role: 'operator' });
  });
  it('waits for a promotion and refuses an operator role downgrade', async () => {
    const { updateUserRole } = await import('./auth.js');
    const id = await target();
    const blocker = await lockAndPromote(id, 'admin');
    let result: ReturnType<typeof updateUserRole>;
    try {
      result = updateUserRole(id, 'viewer', 'operator');
      await waitUntilBlocked(blocker);
    } finally { await releasePromotion(blocker); }
    expect(await result!).toBe(false);
    expect((await pool.query('SELECT role FROM users WHERE id=$1', [id])).rows[0].role).toBe('admin');
  });
  it('waits for a promotion and refuses an operator disable instead of disconnecting a privileged account', async () => {
    const { disableUser } = await import('./auth.js');
    const id = await target();
    await pool.query('UPDATE users SET disabled=0 WHERE id=$1', [id]);
    const blocker = await lockAndPromote(id, 'operator');
    let result: ReturnType<typeof disableUser>;
    try {
      result = disableUser(id, 'operator', actorId);
      await waitUntilBlocked(blocker);
    } finally { await releasePromotion(blocker); }
    expect(await result!).toBe('forbidden');
    expect((await pool.query('SELECT role,disabled FROM users WHERE id=$1', [id])).rows[0])
      .toMatchObject({ role: 'operator', disabled: 0 });
  });
  it('commits a successful restore and audit together', async () => {
    const id = await target();
    expect(await sut.reactivateUser({ userId: id, actorUserId: actorId, actorRole: 'operator' })).toBe('reactivated');
    expect((await pool.query('SELECT disabled,auth_epoch FROM users WHERE id=$1', [id])).rows[0]).toMatchObject({ disabled: 0, auth_epoch: 1 });
    expect((await pool.query("SELECT result FROM account_security_events WHERE target_user_id=$1 AND event_type='user_reactivation'", [id])).rows[0].result).toBe('success');
  });
  it('rolls back restoration and epoch when audit insert fails', async () => {
    const id = await target();
    // Fixture-local trigger forces audit write failure; never installed outside this disposable DB.
    await pool.query(`CREATE FUNCTION synthetic_reject_reactivation_audit() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.event_type='user_reactivation' AND NEW.target_user_id=${id} THEN RAISE EXCEPTION 'synthetic audit unavailable'; END IF;
      RETURN NEW; END $$`);
    await pool.query('CREATE TRIGGER synthetic_audit_failure BEFORE INSERT ON account_security_events FOR EACH ROW EXECUTE FUNCTION synthetic_reject_reactivation_audit()');
    await expect(sut.reactivateUser({ userId: id, actorUserId: actorId, actorRole: 'operator' })).rejects.toThrow('synthetic audit unavailable');
    expect((await pool.query('SELECT disabled,auth_epoch FROM users WHERE id=$1', [id])).rows[0]).toMatchObject({ disabled: 1, auth_epoch: 0 });
    expect((await pool.query("SELECT count(*)::int AS count FROM account_security_events WHERE target_user_id=$1 AND event_type='user_reactivation'", [id])).rows[0].count).toBe(0);
  });
});

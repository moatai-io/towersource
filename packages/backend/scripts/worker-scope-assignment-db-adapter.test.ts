import { verifyPersistedScopeProbe } from '../services/runtime-box/worker-scope-execution-probe.js';
import { executionBindingDigest } from './worker-scope-assignment-lifecycle.js';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('../db/pg-repo.js', () => ({ query: vi.fn(), queryOne: vi.fn(), transaction: vi.fn(), withClient: vi.fn() }));
vi.mock('../config.js', () => ({ config: { jwtSecret: 'synthetic-test-only-worker-signing-key' } }));
import { query, queryOne, transaction, withClient } from '../db/pg-repo.js';
import { issueWorkbenchWorkerIdentity, verifyWorkbenchWorkerIdentity } from '../services/runtime-box/workbench-worker-identity.js';
import { createWorkerScopeAssignmentDbAdapter, withUnwiredScopeRuntime } from './worker-scope-assignment-db-adapter.js';
import { createWorkerScopeHeartbeatAdapter } from './worker-scope-heartbeat-adapter.js';
import { WorkerMaintenanceGate } from '../services/runtime-box/worker-maintenance-gate.js';
import { WorkerScopeAssignmentLifecycle, digest, scopeDigest, type AssignmentInput, type AssignmentOperation } from './worker-scope-assignment-lifecycle.js';

const roots: string[] = [];
afterEach(() => { for (const p of roots.splice(0)) fs.rmSync(p, { recursive: true, force: true }); });
beforeEach(() => vi.clearAllMocks());
function fixture(fileAuthorityReady = true, installedMode: 0o600 | 0o640 = 0o600) {
  const root = fs.mkdtempSync(`/run/user/${process.getuid!()}/scope-db-test-`); roots.push(root);
  const stage = path.join(root, 'stage'); fs.mkdirSync(stage, { mode: 0o700 });
  const input: AssignmentInput = { workerId: 'worker', deploymentId: 'test', projectId: 'new', leaseOwner: 'lease-a', root: path.join(root, 'new'),
    configFile: path.join(root, 'config.json'), identityFile: path.join(root, 'identity.jwt'), stateFile: path.join(root, 'state.json'), lockFile: path.join(root, 'lock'), backupDirectory: root };
  fs.writeFileSync(input.lockFile, '', { mode: 0o644 });
  const oldScope = { old: path.join(root, 'old') }; const newScope = { ...oldScope, new: input.root };
  const original = issueWorkbenchWorkerIdentity({ workerId: 'worker', projectIds: ['old'], capabilities: ['shell', 'custom-capability'], expiresIn: '1h' });
  fs.mkdirSync(input.root);
  fs.writeFileSync(input.identityFile, original.token + '\n', { mode: installedMode }); fs.writeFileSync(input.configFile, JSON.stringify({ projects: oldScope }), { mode: 0o640 });
  const stat = fs.statSync(input.identityFile);
  const op: AssignmentOperation = { kind: 'scope-assignment', version: 1, id: randomUUID(), workerId: 'worker', deploymentId: 'test', projectId: 'new', leaseOwner: 'lease-a', phase: 'stage-intent',
    rootIdentity: { dev: 1, ino: 1 }, oldScope, newScope, oldJti: original.identity.jti, oldPid: 10, storePath: '/nix/store/test', newConfigSha256: 'test',
    config: { path: input.configFile, backup: '', sha256: '', uid: stat.uid, gid: stat.gid, mode: 0o640 },
    identity: { path: input.identityFile, backup: '', sha256: '', uid: stat.uid, gid: stat.gid, mode: installedMode } };
  const save = () => fs.writeFileSync(input.stateFile, JSON.stringify({ version: 1, owner: op.id, phase: op.phase, operation: op }), { mode: 0o644 }); save();
  let db: any = { identities: [{ jti: original.identity.jti, worker_id: 'worker', project_ids: ['old'], capabilities: ['custom-capability', 'shell'], expires_at: original.identity.expiresAt, revoked_at: null, replaced_by_jti: null }],
    desire: { status: 'preparing', desired_worker_id: 'worker', lease_owner: 'lease-a', completed_at: null }, binding: null, settings: null, rollout: null };
  let loseReply = false; let failComplete = false; const sqls: Array<{ sql: string; values: any[]; transaction: boolean }> = [];
  const execute = async (store: any, sql: string, values: any[] = [], tx = false): Promise<any[]> => {
    sqls.push({ sql, values, transaction: tx });
    if (sql.includes('FROM runtime_box_workbench_worker_identities')) {
      if (sql.includes('replaced_by_jti=$1')) return store.identities.filter((r: any) => r.replaced_by_jti === values[0]);
      if (sql.includes('WHERE jti=$1')) return store.identities.filter((r: any) => r.jti === values[0]);
      return store.identities.filter((r: any) => r.worker_id === values[0] && !r.revoked_at && Date.parse(r.expires_at) > Date.now());
    }
    if (sql.includes('INSERT INTO runtime_box_workbench_worker_identities')) {
      const row = { jti: values[0], worker_id: values[1], project_ids: values[2], capabilities: values[3], expires_at: values[5], revoked_at: null, replaced_by_jti: null }; store.identities.push(row); return [row];
    }
    if (sql.includes('UPDATE runtime_box_workbench_worker_identities')) { const row = store.identities.find((r: any) => r.jti === values[0]); row.revoked_at = 'now'; row.replaced_by_jti = values[1]; return [row]; }
    if (sql.includes('LEFT JOIN project_compute_deployment_bindings')) return [{ ...store.desire,
      binding_project: store.binding?.project, binding_worker: store.binding?.worker, binding_workstation: store.binding?.workstation, binding_authority: store.binding?.authority,
      settings_worker: store.settings?.worker, settings_workstation: store.settings?.workstation, settings_authority: store.settings?.authority,
      rollout_status: store.rollout?.status, rollout_cohort: store.rollout?.cohort, rollout_reason: store.rollout?.reason }];
    if (sql.includes('FROM project_worker_assignment_desires')) return [store.desire];
    if (sql.includes('SELECT project_id FROM project_compute_deployment_bindings')) return store.binding ? [{ project_id: store.binding.project }] : [];
    if (sql.includes('INSERT INTO project_compute_deployment_bindings')) { if (store.binding) return []; store.binding = { project: values[0], worker: values[2], workstation: true, authority: values[3] }; return [{ project_id: values[0] }]; }
    if (sql.includes('INSERT INTO project_compute_settings')) { store.settings = { worker: values[1], workstation: values[4], authority: values[2] }; return []; }
    if (sql.includes('INSERT INTO runtime_box_workbench_rollouts')) { store.rollout = { status: 'enabled', cohort: values[1], reason: values[2] }; return []; }
    if (sql.includes('UPDATE project_worker_assignment_desires')) {
      if (failComplete || store.desire.status !== 'preparing' || store.desire.lease_owner !== values[3] || store.desire.desired_worker_id !== values[2]) return [];
      store.desire = { ...store.desire, status: values[4] ?? 'active', last_error: values[5] ?? null, lease_owner: null, completed_at: 'now' }; return [{ project_id: 'new' }];
    }
    throw new Error('UNHANDLED_TEST_SQL');
  };
  vi.mocked(query).mockImplementation(async (sql, values) => execute(db, sql, values) as any);
  vi.mocked(queryOne).mockImplementation(async (sql, values) => (await execute(db, sql, values))[0]);
  vi.mocked(transaction).mockImplementation(async callback => {
    const copy = structuredClone(db); const client = { query: async (sql: string, values: any[]) => { const rows = await execute(copy, sql, values, true); return { rows, rowCount: rows.length }; } };
    const result = await callback(client as any); db = copy; if (loseReply) { loseReply = false; throw new Error('COMMIT_REPLY_LOST'); } return result;
  });
  vi.mocked(withClient).mockImplementation((client: any) => ({
    queryOne: async (sql: string, values: any[]) => (await client.query(sql, values)).rows[0],
    execute: async (sql: string, values: any[]) => ({ changes: (await client.query(sql, values)).rowCount }),
    query: async (sql: string, values: any[]) => (await client.query(sql, values)).rows,
  }) as any);
  const adapter = createWorkerScopeAssignmentDbAdapter({ input, actorUserId: 7, stagingDirectory: stage, fileAuthorityReady, installedIdentity: { uid: stat.uid, gid: stat.gid, mode: installedMode } });
  const bindingReady = () => { op.executionNonce=randomUUID(); op.newJti ??= randomUUID(); op.phase = 'binding-intent'; op.livePid = 11; op.probe = { owner: op.id, projectId: 'new', rootDigest: digest(input.root), pid: 11, scopeDigest: scopeDigest(newScope), cleaned: true }; op.executionReceipt = { ...op.probe, commandVerified: true, backendSharedWriteVerified: true,nonce:op.executionNonce!,operationDigest:executionBindingDigest(op),rootIdentity:op.rootIdentity,backend:{pid:99999,uid:2001,gid:2001,startTicks:'1'},commandUid:2002 }; save(); };
  return { root, input, stage, op, save, adapter, sqls, db: () => db, bindingReady, loseReply: () => { loseReply = true; }, failComplete: () => { failComplete = true; } };
}

describe('official identity issue/verify/rotate connected to fake SQL transaction', () => {
  it('preserves capabilities and stores signed staged token privately, without DB write until rotation', async () => {
    const f = fixture(); const staged = await f.adapter.stageIdentity(f.op.newScope, f.op.id, 'forward');
    expect(Object.keys(staged)).toEqual(['jti']); expect(f.db().identities).toHaveLength(1);
    const file = path.join(f.stage, staged.jti + '.jwt'); expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    const identity = verifyWorkbenchWorkerIdentity(fs.readFileSync(file, 'utf8').trim())!;
    expect(identity.capabilities).toEqual(['custom-capability', 'shell']); expect(identity.projectIds).toEqual(['new', 'old']);
    f.op.newJti = staged.jti; f.op.phase = 'rotation-intent'; f.save(); await f.adapter.rotateIdentity(f.op.oldJti, staged.jti);
    expect(await f.adapter.readIdentity()).toEqual({ activeJti: staged.jti, previousJti: f.op.oldJti, projectIds: ['new', 'old'] });
    expect(f.sqls.some(x => x.transaction && x.sql.includes('replaced_by_jti=$2'))).toBe(true);
    f.op.phase = 'identity-file-intent'; f.save(); await f.adapter.publishIdentity(staged.jti, f.op.identity);
    expect(await f.adapter.publishedIdentity()).toEqual({ jti: staged.jti, uid: f.op.identity.uid, gid: f.op.identity.gid, mode: 0o600 });
  });
  it.each([0, 2])('blocks %i active identities', async count => {
    const f = fixture(); f.db().identities = Array.from({ length: count }, (_, i) => ({ ...f.db().identities[0], jti: randomUUID() }));
    await expect(f.adapter.readIdentity()).rejects.toThrow('ACTIVE_IDENTITY_COUNT');
    await expect(f.adapter.stageIdentity(f.op.newScope, f.op.id, 'forward')).rejects.toThrow('ACTIVE_IDENTITY_COUNT');
  });
  it('rotation response loss keeps durable intent and exact linkage is readable', async () => {
    const f = fixture(); const next = await f.adapter.stageIdentity(f.op.newScope, f.op.id, 'forward');
    f.op.newJti = next.jti; f.op.phase = 'rotation-intent'; f.save(); f.loseReply();
    await expect(f.adapter.rotateIdentity(f.op.oldJti, next.jti)).rejects.toThrow('COMMIT_REPLY_LOST');
    expect(await f.adapter.readIdentity()).toMatchObject({ activeJti: next.jti, previousJti: f.op.oldJti });
    expect(JSON.parse(fs.readFileSync(f.input.stateFile, 'utf8')).owner).toBe(f.op.id);
  });
  it('blocks symlink/world-readable staged token and changed target metadata', async () => {
    const f = fixture(); const next = await f.adapter.stageIdentity(f.op.newScope, f.op.id, 'forward'); const file = path.join(f.stage, next.jti + '.jwt');
    f.op.newJti = next.jti; f.op.phase = 'rotation-intent'; f.save(); fs.chmodSync(file, 0o644);
    await expect(f.adapter.rotateIdentity(f.op.oldJti, next.jti)).rejects.toThrow('FILE_UNSAFE'); fs.chmodSync(file, 0o600);
    await f.adapter.rotateIdentity(f.op.oldJti, next.jti); f.op.phase = 'identity-file-intent'; f.save(); fs.chmodSync(f.input.identityFile, 0o400);
    await expect(f.adapter.publishIdentity(next.jti, f.op.identity)).rejects.toThrow('FILE_UNSAFE');
    fs.renameSync(file, file + '.saved'); fs.symlinkSync(file + '.saved', file);
    await expect(f.adapter.publishIdentity(next.jti, f.op.identity)).rejects.toThrow();
  });
  it('rollback stages old scope with preserved capabilities, never reuses revoked token', async () => {
    const f = fixture(); const next = await f.adapter.stageIdentity(f.op.newScope, f.op.id, 'forward');
    f.op.newJti = next.jti; f.op.phase = 'rotation-intent'; f.save(); await f.adapter.rotateIdentity(f.op.oldJti, next.jti);
    f.op.phase = 'rollback-stage-intent'; f.save(); const rollback = await f.adapter.stageIdentity(f.op.oldScope, f.op.id, 'rollback');
    f.op.rollbackJti = rollback.jti; f.op.phase = 'rollback-rotation-intent'; f.save(); await f.adapter.rotateIdentity(next.jti, rollback.jti);
    expect(await f.adapter.readIdentity()).toEqual({ activeJti: rollback.jti, previousJti: next.jti, projectIds: ['old'] }); expect(rollback.jti).not.toBe(f.op.oldJti);
  });
});

describe('official binding-first helper + desire in the SAME fake transaction', () => {
  it.each([true, false])('atomic commit/readback preserves fileAuthorityReady=%s', async ready => {
    const f = fixture(ready); f.bindingReady(); await f.adapter.assertLease(f.input); await f.adapter.commitBinding(f.op);
    expect(await f.adapter.bindingState(f.op)).toBe('committed'); expect(f.db().settings.workstation).toBe(ready);
    const writes = f.sqls.filter(x => /INSERT INTO project_compute|INSERT INTO runtime_box_workbench_rollouts|UPDATE project_worker_assignment_desires/.test(x.sql));
    expect(writes).toHaveLength(4); expect(writes.every(x => x.transaction)).toBe(true);
    expect(writes[0].sql).toContain('DO NOTHING'); expect(writes[3].sql).toContain("status='preparing' AND lease_owner=$4");
  });
  it('upload-only receipt is not sufficient to commit binding', async () => {
    const f = fixture(); f.bindingReady(); f.op.executionReceipt = undefined; f.save();
    await expect(f.adapter.commitBinding(f.op)).rejects.toThrow('EXECUTION_RECEIPT_REQUIRED'); expect(f.db().binding).toBeNull();
  });
  it('same Worker with a different lease/operation receipt is not our committed result', async () => {
    const f = fixture(); f.bindingReady(); await f.adapter.commitBinding(f.op);
    f.op.id = randomUUID(); f.op.probe!.owner = f.op.id; f.op.executionReceipt!.owner = f.op.id; f.op.executionReceipt!.operationDigest=executionBindingDigest(f.op);
    expect(await f.adapter.bindingState(f.op)).toBe('ambiguous');
  });
  it('completion rejection rolls back binding/settings/rollout too', async () => {
    const f = fixture(); f.bindingReady(); f.failComplete(); await expect(f.adapter.commitBinding(f.op)).rejects.toThrow('COMPLETE_REJECTED');
    expect(f.db().binding).toBeNull(); expect(f.db().settings).toBeNull(); expect(f.db().rollout).toBeNull(); expect(await f.adapter.bindingState(f.op)).toBe('absent');
  });
  it('commit reply lost is read back as committed, DB unavailable as ambiguous', async () => {
    const f = fixture(); f.bindingReady(); f.loseReply(); await expect(f.adapter.commitBinding(f.op)).rejects.toThrow('COMMIT_REPLY_LOST');
    expect(await f.adapter.bindingState(f.op)).toBe('committed'); vi.mocked(queryOne).mockRejectedValueOnce(new Error('unavailable')); expect(await f.adapter.bindingState(f.op)).toBe('ambiguous');
  });
  it('unrelated/same-worker binding without exact operation evidence is ambiguous', async () => {
    const f = fixture(); f.bindingReady(); f.db().binding = { project: 'new', worker: 'other', workstation: true, authority: 'project' };
    expect(await f.adapter.bindingState(f.op)).toBe('ambiguous'); await expect(f.adapter.commitBinding(f.op)).rejects.toThrow('EXISTING_BINDING');
    f.db().binding = null; await f.adapter.commitBinding(f.op); f.db().rollout.reason = 'different operation'; expect(await f.adapter.bindingState(f.op)).toBe('ambiguous');
  });
  it.each(['failed', 'recovery_required', 'active'])('never resets %s desire through finish', async status => {
    const f = fixture(); f.op.phase = 'terminal-intent'; f.op.terminalIntent = 'deferred'; f.save(); f.db().desire.status = status;
    await expect(f.adapter.finishWithoutBinding(f.op, 'deferred')).rejects.toThrow('LEASE_LOST'); expect(f.db().desire.status).toBe(status);
  });
  it('exact lease mismatch or missing probe stops before activation SQL', async () => {
    const f = fixture(); f.bindingReady(); f.db().desire.lease_owner = 'foreign'; await expect(f.adapter.commitBinding(f.op)).rejects.toThrow('LEASE_LOST');
    expect(f.db().binding).toBeNull(); f.op.probe = undefined; f.save(); await expect(f.adapter.commitBinding(f.op)).rejects.toThrow('PROBE_REQUIRED');
  });
  it('defer and verified rollback transition only owned preparing desire', async () => {
    const f = fixture(); f.op.phase = 'terminal-intent'; f.op.terminalIntent = 'deferred'; f.save(); await f.adapter.finishWithoutBinding(f.op, 'deferred'); expect(f.db().desire.status).toBe('pending');
    f.db().desire.status = 'preparing'; f.db().desire.lease_owner = 'lease-a'; f.op.phase = 'terminal-intent'; f.op.terminalIntent = 'rolled-back'; f.save();
    await f.adapter.finishWithoutBinding(f.op, 'rolled-back'); expect(f.db().desire.status).toBe('failed');
  });
  it('unwired production runtime rejects instead of behaving as mock success', async () => {
    const f = fixture(); const runtime = withUnwiredScopeRuntime(f.adapter);
    await expect(runtime.authorize(f.input)).rejects.toThrow('NOT_CONNECTED'); await expect(runtime.restart(f.op.newScope)).rejects.toThrow('NOT_CONNECTED');
  });
});


function integrated() {
  const f = fixture(true, 0o640);
  fs.writeFileSync(f.input.stateFile, JSON.stringify({ version: 1, owner: null, phase: 'idle' }));
  const workerUnit = 'tower-workbench-worker-worker.service'; const heartbeatUnit = 'tower-workbench-worker-worker-heartbeat.service';
  const workerFragment = path.join(f.root, workerUnit); const heartbeatFragment = path.join(f.root, heartbeatUnit);
  const cfg = path.join(f.root, 'heartbeat-control.json');
  fs.writeFileSync(workerFragment, '[Service]\nExecStart=/nix/store/test/worker\n', { mode: 0o644 });
  const originalUnit = `[Service]\nEnvironment=TOWER_LOCAL_WORKER_ID=worker\nEnvironment=TOWER_LOCAL_WORKER_DEPLOYMENT_ID=test\nEnvironment=TOWER_LOCAL_WORKER_IDENTITY_FILE=${f.input.identityFile}\nEnvironment=TOWER_LOCAL_WORKER_PROJECT_IDS=old\nExecStart=/nix/store/test/heartbeat\n`;
  fs.writeFileSync(heartbeatFragment, originalUnit, { mode: 0o644 });
  fs.writeFileSync(cfg, JSON.stringify({ workerId: 'worker', deploymentId: 'test', workerUnit, heartbeatUnit, workerFragment, heartbeatFragment,
    identityFile: f.input.identityFile, stateFile: f.input.stateFile, backupDirectory: f.stage }), { mode: 0o600 });
  const gate = new WorkerMaintenanceGate(f.input.stateFile);
  let pid = 10, heartbeatPid = 20, heartbeatTime = Date.now(), started = Date.now();
  let loadedToken = verifyWorkbenchWorkerIdentity(fs.readFileSync(f.input.identityFile, 'utf8').trim())!;
  let scope = f.op.oldScope; let busy = false, checkpoint = '', loseFinish = false, staleIdentitySeen = false;
  const commands: string[][] = [];
  const idle = async (owner: string, context?: { mode: string }) => {
    if (!gate.owns(owner)) throw new Error('UNOWNED');
    const active = f.db().identities.find((i: any) => !i.revoked_at);
    if (active.jti !== loadedToken.jti) {
      staleIdentitySeen = true;
      if (context?.mode !== 'owned-transition') throw new Error('FRESH_HEARTBEAT_REQUIRED');
      // Authoritative DB/activity observation succeeded; ONLY expected old
      // process token lag is allowed during owned transition. DB failure throws.
    }
    return !busy;
  };
  const heartbeat = createWorkerScopeHeartbeatAdapter({ trustedConfigFile: cfg, authorize: async () => {}, idle,
    runner: async args => {
      commands.push(args);
      if (args[0] === 'show') return `FragmentPath=${args[1] === workerUnit ? workerFragment : heartbeatFragment}\nDropInPaths=\nLoadState=loaded\nNeedDaemonReload=no\nKillMode=process\nSendSIGKILL=no\nTimeoutStopUSec=infinity\n`;
      if (args[0] === 'restart') {
        // Processes read the new identity/scope ONLY on restart, not DB rotation.
        loadedToken = verifyWorkbenchWorkerIdentity(fs.readFileSync(f.input.identityFile, 'utf8').trim())!;
        scope = JSON.parse(fs.readFileSync(f.input.configFile, 'utf8')).projects;
        expect(fs.readFileSync(heartbeatFragment, 'utf8')).toContain('Environment=TOWER_LOCAL_WORKER_PROJECT_IDS=' + Object.keys(scope).sort().join(','));
        pid++; heartbeatPid++; heartbeatTime = Date.now() + 1; started = heartbeatTime;
      }
      return '';
    } });
  const observe = async () => ({ pid, heartbeatPid, heartbeatStartedAt: started, heartbeatIdentityJti: loadedToken.jti, storePath: '/nix/store/test', scope,
    identityJti: loadedToken.jti, heartbeatAt: heartbeatTime, fenceOwner: JSON.parse(fs.readFileSync(f.input.stateFile, 'utf8')).owner ?? '', activeRequests: 0 });
  const adapter = { ...f.adapter, ...heartbeat, authorize: async () => {}, idle, observe, maintenanceSmoke: async () => {},
    projectProbe: async (owner: string) => ({ owner, projectId: 'new', rootDigest: digest(f.input.root), pid, scopeDigest: scopeDigest(scope), cleaned: true as const }),
    verifyCommittedProbe:async (op:any)=>verifyPersistedScopeProbe({stateFile:f.input.stateFile,workerId:f.input.workerId,projects:op.newScope,assertTrustedState:()=>{}},op),
    projectExecutionProbe: async (owner: string) => ({ owner, projectId: 'new', rootDigest: digest(f.input.root), pid, scopeDigest: scopeDigest(scope), cleaned: true as const, commandVerified: true as const, backendSharedWriteVerified: true as const,nonce:JSON.parse(fs.readFileSync(f.input.stateFile,'utf8')).operation.executionNonce,operationDigest:executionBindingDigest(JSON.parse(fs.readFileSync(f.input.stateFile,'utf8')).operation),rootIdentity:JSON.parse(fs.readFileSync(f.input.stateFile,'utf8')).operation.rootIdentity,backend:{pid:99999,uid:2001,gid:2001,startTicks:'1'},commandUid:2002 }),
    checkpoint: async (phase: string) => {
      if (loseFinish && phase === 'terminal-intent') { f.loseReply(); loseFinish = false; }
      if (phase === checkpoint) throw new Error('INTEGRATED_CRASH');
    } };
  return { ...f, controller: new WorkerScopeAssignmentLifecycle(f.input, adapter), heartbeatFragment, originalUnit, commands,
    busy: () => { busy = true; }, crash: (phase: string) => { checkpoint = phase; }, finishLost: () => { loseFinish = true; }, staleSeen: () => staleIdentitySeen,
    state: () => JSON.parse(fs.readFileSync(f.input.stateFile, 'utf8')) };
}

describe('COMPOSED lifecycle + official DB adapter + real heartbeat file adapter', () => {
  it('0640 installed target forwards while heartbeat retains old JWT until restart', async () => {
    const f = integrated(); expect(await f.controller.assign()).toBe('assigned');
    expect(f.staleSeen()).toBe(true); expect(fs.statSync(f.input.identityFile).mode & 0o777).toBe(0o640);
    expect(f.db().desire.status).toBe('active'); expect(f.state().owner).toBeNull();
    expect(f.commands.filter(c => c[0] === 'restart')).toHaveLength(1);
  });
  it('0640 target rolls back by new old-scope identity and exact heartbeat restoration', async () => {
    const f = integrated(); f.crash('probe-intent'); await expect(f.controller.assign()).rejects.toThrow('INTEGRATED_CRASH'); f.crash('');
    expect(await f.controller.recover()).toBe('rolled-back'); expect(fs.readFileSync(f.heartbeatFragment, 'utf8')).toBe(f.originalUnit);
    expect(fs.statSync(f.input.identityFile).mode & 0o777).toBe(0o640); expect(f.db().desire.status).toBe('failed');
    expect(f.db().identities.filter((r: any) => !r.revoked_at)[0].project_ids).toEqual(['old']);
  });
  it.each(['deferred', 'rolled-back'])('finish response loss %s is resolved by exact terminal receipt', async result => {
    const f = integrated();
    if (result === 'deferred') f.busy();
    else { f.crash('probe-intent'); await expect(f.controller.assign()).rejects.toThrow(); f.crash(''); }
    f.finishLost();
    await expect(result === 'deferred' ? f.controller.assign() : f.controller.recover()).rejects.toThrow('COMMIT_REPLY_LOST');
    const rotations = f.db().identities.length; const commands = f.commands.length;
    expect(await f.controller.recover()).toBe(result); expect(f.db().identities).toHaveLength(rotations);
    expect(f.commands.slice(commands).every(c => c[0] === 'show')).toBe(true); expect(f.state().owner).toBeNull();
  });
  it.each(['terminal-intent', 'terminal-committed', 'owner-released'])('defer crash after %s does not resume mutation', async phase => {
    const f = integrated(); f.busy(); f.crash(phase); await expect(f.controller.assign()).rejects.toThrow('INTEGRATED_CRASH'); f.crash('');
    expect(await f.controller.recover()).toBe('deferred'); expect(f.db().identities).toHaveLength(1); expect(f.commands).toEqual([]);
  });
  it.each(['terminal-intent', 'terminal-committed', 'owner-released'])('verified rollback crash after %s never repeats rotation', async phase => {
    const f = integrated(); f.crash('probe-intent'); await expect(f.controller.assign()).rejects.toThrow(); f.crash(phase);
    await expect(f.controller.recover()).rejects.toThrow('INTEGRATED_CRASH'); const count = f.db().identities.length; f.crash('');
    expect(await f.controller.recover()).toBe('rolled-back'); expect(f.db().identities).toHaveLength(count);
  });
  it('operator re-request after terminal commit is ambiguous, never silently released', async () => {
    const f = integrated(); f.busy(); f.finishLost(); await expect(f.controller.assign()).rejects.toThrow();
    f.db().desire.last_error = null;
    await expect(f.controller.recover()).rejects.toThrow('AMBIGUOUS'); expect(f.state().owner).toBeTruthy();
  });
  it('heartbeat drift blocks before a SECOND identity rotation during rollback', async () => {
    const f = integrated(); f.crash('probe-intent'); await expect(f.controller.assign()).rejects.toThrow(); f.crash('');
    fs.appendFileSync(f.heartbeatFragment, '# foreign\n'); const count = f.db().identities.length;
    await expect(f.controller.recover()).rejects.toThrow('HEARTBEAT_FILE_DRIFT'); expect(f.db().identities).toHaveLength(count);
  });
  it('unsupported installed identity permissions stop BEFORE rotation', async () => {
    const f = integrated(); fs.chmodSync(f.input.identityFile, 0o644);
    await expect(f.controller.assign()).rejects.toThrow('FILE_UNSAFE'); expect(f.db().identities).toHaveLength(1);
  });
});

import { verifyPersistedScopeProbe } from '../services/runtime-box/worker-scope-execution-probe.js';
import { executionBindingDigest, protectedPath } from './worker-scope-assignment-lifecycle.js';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WorkerScopeAssignmentLifecycle, durableWrite, digest, scopeDigest, type ScopeLifecycleAdapters, type AssignmentInput, type IdentityLink, type Scope } from './worker-scope-assignment-lifecycle.js';
import { WorkerMaintenanceGate } from '../services/runtime-box/worker-maintenance-gate.js';
import { runWorkerScopeProjectProbe } from '../services/runtime-box/worker-scope-project-probe.js';

// /run/user/<uid> is a private existing OS runtime directory with protected parents.
// No chmod/root/service operations. All fixtures are ephemeral, not deliverables.
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = fs.mkdtempSync(`/run/user/${process.getuid!()}/scope-test-`); roots.push(root);
  const oldRoot = path.join(root, 'old'); const newRoot = path.join(root, 'new'); fs.mkdirSync(oldRoot); fs.mkdirSync(newRoot);
  const oldScope = { old: oldRoot }; const configFile = path.join(root, 'worker.json'); const identityFile = path.join(root, 'identity.jwt');
  fs.writeFileSync(configFile, JSON.stringify({ workerId: 'w', projects: oldScope, managedSkillsRoot: '/fixed/skills', port: 12345 }), { mode: 0o640 });
  fs.writeFileSync(identityFile, 'old', { mode: 0o600 });
  const stateFile = path.join(root, 'state.json'); fs.writeFileSync(stateFile, JSON.stringify({ version: 1, owner: null, phase: 'idle' }), { mode: 0o644 });
  const lockFile = path.join(root, 'deployment.lock'); fs.writeFileSync(lockFile, '', { mode: 0o644 });
  const backupDirectory = path.join(root, 'backup'); fs.mkdirSync(backupDirectory, { mode: 0o700 });
  const input: AssignmentInput = { root: newRoot, projectId: 'new', workerId: 'w', deploymentId: 'test', leaseOwner: 'lease', configFile, identityFile, stateFile, lockFile, backupDirectory };
  let active: IdentityLink = { activeJti: 'old', previousJti: null, projectIds: ['old'] };
  let liveScope: Scope = oldScope; let pid = 100; let heartbeat = 1; let binding: 'absent' | 'committed' | 'ambiguous' | 'deferred' | 'rolled-back' = 'absent';
  let busy = false; let failAt = ''; let stale = false; let commitThenThrow = false; let rotateThenThrow = false;
  const calls: string[] = []; const staged = new Map<string, Scope>();
  const state = () => JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  const gate = new WorkerMaintenanceGate(stateFile);
  const adapter: ScopeLifecycleAdapters = {
    authorize: async () => { calls.push('authorize'); }, assertLease: async () => {},
    readIdentity: async () => ({ ...active, projectIds: [...active.projectIds] }),
    observe: async () => ({ pid, storePath: '/nix/store/fixed', scope: liveScope, identityJti: active.activeJti, heartbeatPid: pid + 100, heartbeatStartedAt: heartbeat, heartbeatIdentityJti: active.activeJti, heartbeatAt: stale ? 1 : heartbeat, fenceOwner: state().owner ?? '', activeRequests: 0 }),
    idle: async owner => gate.owns(owner) && !busy,
    stageIdentity: async (scope, id, purpose) => { const jti = `${purpose}-${id}`; staged.set(jti, scope); calls.push('stage'); return { jti }; },
    rotateIdentity: async (previous, next) => { expect(previous).toBe(active.activeJti); expect(gate.snapshot().draining).toBe(true); active = { activeJti: next, previousJti: previous, projectIds: Object.keys(staged.get(next)!) }; calls.push('rotate'); if (rotateThenThrow) { rotateThenThrow = false; throw new Error('LOST_DB_REPLY'); } },
    publishIdentity: async (jti, meta) => { durableWrite(identityFile, jti, meta); calls.push('publish'); },
    publishedIdentity: async () => { const stat = fs.statSync(identityFile); return { jti: fs.readFileSync(identityFile, 'utf8'), uid: stat.uid, gid: stat.gid, mode: stat.mode & 0o777 }; },
    captureHeartbeatEvidence: async () => ({ version: 1 } as any), verifyHeartbeat: async () => {}, preflightHeartbeatRestore: async () => {},
    restart: async scope => { expect(gate.snapshot().draining).toBe(true); expect(busy).toBe(false); pid++; heartbeat = Date.now() + 1000; liveScope = scope; calls.push('restart'); },
    maintenanceSmoke: async () => { calls.push('smoke'); },
    projectProbe: async owner => ({ owner, projectId: 'new', rootDigest: digest(newRoot), pid, scopeDigest: scopeDigest(liveScope), cleaned: true }),
    verifyCommittedProbe:async op=>verifyPersistedScopeProbe({stateFile:input.stateFile,workerId:input.workerId,projects:op.newScope,assertTrustedState:protectedPath},op),
    projectExecutionProbe: async owner => ({ owner, projectId: 'new', rootDigest: digest(newRoot), pid, scopeDigest: scopeDigest(liveScope), cleaned: true, commandVerified: true, backendSharedWriteVerified: true, nonce:state().operation.executionNonce, operationDigest:executionBindingDigest(state().operation), rootIdentity:state().operation.rootIdentity, backend:{pid:99999,uid:2001,gid:2001,startTicks:'1'},commandUid:2002 }),
    bindingState: async () => binding,
    commitBinding: async () => { binding = 'committed'; calls.push('commit'); if (commitThenThrow) throw new Error('LOST_DB_REPLY'); },
    finishWithoutBinding: async (_op, result) => { calls.push(result); binding = result; },
    checkpoint: async phase => { if (phase === failAt) throw new Error('CRASH'); },
  };
  return { root, input, state, adapter, calls, gate, controller: new WorkerScopeAssignmentLifecycle(input, adapter),
    busy: (v = true) => { busy = v; }, crash: (p: string) => { failAt = p; }, stale: () => { stale = true; },
    ambiguous: () => { binding = 'ambiguous'; }, commitLost: () => { commitThenThrow = true; }, rotationLost: () => { rotateThenThrow = true; } };
}

describe('durable existing-path assignment lifecycle with explicit fake adapters', () => {
  it('completes additive scope, exact metadata/linkage, binding-last and fence release', async () => {
    const f = fixture(); expect(await f.controller.assign()).toBe('assigned');
    expect(f.state()).toMatchObject({ owner: null, phase: 'idle', completedOperation: { kind: 'scope-assignment', phase: 'binding-committed' } });
    expect(f.calls.indexOf('restart')).toBeLessThan(f.calls.indexOf('commit'));
    expect(fs.statSync(f.input.configFile).mode & 0o777).toBe(0o640);
    expect(JSON.parse(fs.readFileSync(f.input.configFile, 'utf8'))).toMatchObject({ managedSkillsRoot: '/fixed/skills', port: 12345 });
    expect(fs.statSync(f.state().completedOperation.identity.backup).mode & 0o777).toBe(0o600);
    expect(JSON.stringify(f.state())).not.toContain('synthetic-token');
  });
  it('release removes active operation so a later executable maintenance crash remains recoverable', async () => {
    const f = fixture(); await f.controller.assign();
    expect(f.state().operation).toBeUndefined(); expect(f.state().completedOperation.kind).toBe('scope-assignment');
    const script = `import json,sys,types
from pathlib import Path
src=Path('scripts/nix-app/tower-worker-maintenance').read_text()
ns={'__name__':'scope_recovery_test'}
exec(compile(src,'maintenance','exec'),ns)
m=ns['Maintenance'].__new__(ns['Maintenance'])
m.state=json.load(open(sys.argv[1]))
m.state.update(owner='executable-owner',phase='switching',target='approved')
assert m.state.get('operation') is None
m.approval=lambda:'approved'
m.verify=lambda target:None
m.save=lambda **updates:m.state.update(updates)
assert m.run(True)=='recovered'
assert m.state['owner'] is None
`;
    const result = spawnSync('python3', ['-c', script, f.input.stateFile], { encoding: 'utf8', timeout: 3000 });
    expect(result.status, result.stderr).toBe(0);
  });
  it('file probe alone never authorizes binding without exact execution/shared-write evidence', async () => {
    const f = fixture(); f.adapter.projectExecutionProbe = async () => undefined as any;
    await expect(f.controller.assign()).rejects.toThrow('EXECUTION_RECEIPT_REQUIRED');
    expect(f.calls).not.toContain('commit'); expect(f.state().owner).toBeTruthy();
  });
  it('does not serialize unexpected adapter secret fields into readable state', async () => {
    const f = fixture(); f.adapter.captureHeartbeatEvidence = async () => ({ version: 1, token: 'synthetic-do-not-save' } as any);
    await expect(f.controller.assign()).rejects.toThrow('UNKNOWN_FIELD');
    expect(fs.readFileSync(f.input.stateFile, 'utf8')).not.toContain('synthetic-do-not-save');
  });
  it('busy services/reservations/process adapter defers without identity/file/restart changes', async () => {
    const f = fixture(); f.busy(); expect(await f.controller.assign()).toBe('deferred');
    expect(f.calls).toEqual(['authorize', 'deferred']); expect(f.state().owner).toBeNull();
  });
  it.each(['draining', 'heartbeat-plan-intent', 'heartbeat-planned', 'stage-intent', 'rotation-intent', 'identity-file-intent', 'config-intent', 'restart-intent', 'probe-intent', 'binding-intent', 'binding-committed'])('crash at %s keeps owner and forbids ordinary takeover', async phase => {
    const f = fixture(); f.crash(phase); await expect(f.controller.assign()).rejects.toThrow('CRASH');
    expect(f.gate.enter()).toBeNull(); const old = fs.readFileSync(f.input.stateFile, 'utf8');
    await expect(new WorkerScopeAssignmentLifecycle(f.input, f.adapter).assign()).rejects.toThrow('RECOVERY_REQUIRED');
    expect(fs.readFileSync(f.input.stateFile, 'utf8')).toBe(old);
    f.crash(''); const result = await new WorkerScopeAssignmentLifecycle(f.input, f.adapter).recover();
    expect(result).toBe(phase === 'binding-committed' ? 'committed' : 'rolled-back');
    expect(f.state().owner).toBeNull();
    if (['identity-file-intent', 'config-intent', 'restart-intent', 'probe-intent', 'binding-intent'].includes(phase)) {
      expect(fs.readFileSync(f.input.identityFile, 'utf8')).toMatch(/^rollback-/); // never replay revoked old token
    }
  });
  it('rejects a pre-rotation/stale heartbeat even after PID changes', async () => {
    const f = fixture(); f.stale(); await expect(f.controller.assign()).rejects.toThrow('LIVE_VERIFICATION');
    expect(f.state().owner).toBeTruthy(); expect(f.calls).not.toContain('commit');
  });
  it.each([NaN, Infinity, Date.now() - 60000, Date.now() + 60000])('rejects invalid/stale/future heartbeat %s', async value => {
    const f = fixture(); const original = f.adapter.observe;
    f.adapter.observe = async () => ({ ...await original(), heartbeatAt: value });
    await expect(f.controller.assign()).rejects.toThrow('LIVE_VERIFICATION'); expect(f.calls).not.toContain('commit');
  });
  it('detects Project root inode replacement before rotation', async () => {
    const f = fixture(); f.adapter.checkpoint = async phase => {
      if (phase === 'heartbeat-planned') { fs.renameSync(f.input.root, f.input.root + '-old'); fs.mkdirSync(f.input.root); }
    };
    await expect(f.controller.assign()).rejects.toThrow('ROOT_CHANGED'); expect(f.calls).not.toContain('rotate');
  });
  it('DB commit lost response is verified, never rolled back blindly', async () => {
    const f = fixture(); f.commitLost(); await expect(f.controller.assign()).rejects.toThrow('LOST_DB_REPLY');
    expect(await f.controller.recover()).toBe('committed'); expect(f.calls.filter(v => v === 'rotate')).toHaveLength(1);
  });
  it('unknown DB commit retains fence and never restarts during recovery', async () => {
    const f = fixture(); f.crash('binding-intent'); await expect(f.controller.assign()).rejects.toThrow(); f.ambiguous();
    const before = f.calls.slice(); await expect(f.controller.recover()).rejects.toThrow('COMMIT_AMBIGUOUS');
    expect(f.calls.slice(before.length)).toEqual(['authorize']); expect(f.state().owner).toBeTruthy();
  });
  it('official identity rotation lost reply resolves by exact JTI linkage', async () => {
    const f = fixture(); f.rotationLost(); await expect(f.controller.assign()).rejects.toThrow('LOST_DB_REPLY');
    expect(await f.controller.recover()).toBe('rolled-back'); expect(f.calls.filter(v => v === 'rotate')).toHaveLength(2);
  });
  it.each(['rollback-stage-intent', 'rollback-rotation-intent', 'rollback-files-intent', 'rollback-restart-intent', 'rollback-verified'])('partial %s remains fenced, not replayed', async phase => {
    const f = fixture(); f.crash('config-intent'); await expect(f.controller.assign()).rejects.toThrow(); f.crash(phase);
    await expect(f.controller.recover()).rejects.toThrow('CRASH'); f.crash('');
    await expect(f.controller.recover()).rejects.toThrow('PARTIAL_ROLLBACK'); expect(f.state().owner).toBeTruthy();
  });
  it('refuses foreign config changes and preserves them instead of overwriting on rollback', async () => {
    const f = fixture(); f.crash('config-intent'); await expect(f.controller.assign()).rejects.toThrow(); f.crash('');
    fs.writeFileSync(f.input.configFile, '{"foreign":true}');
    await expect(f.controller.recover()).rejects.toThrow('CONFIG_DRIFT'); expect(fs.readFileSync(f.input.configFile, 'utf8')).toBe('{"foreign":true}');
  });
  it('lease loss and authority refusal fail before any fence or mutation', async () => {
    const f = fixture(); f.adapter.assertLease = async () => { throw new Error('LEASE_LOST'); };
    await expect(f.controller.assign()).rejects.toThrow('LEASE_LOST'); expect(f.state().owner).toBeNull();
    f.adapter.authorize = async () => { throw new Error('POLICY_NOT_AUTHORIZED'); };
    await expect(f.controller.assign()).rejects.toThrow('POLICY_NOT_AUTHORIZED'); expect(f.state().owner).toBeNull();
  });
  it('busy work arriving under fence before rotation keeps fence and does not rotate', async () => {
    const f = fixture(); f.adapter.checkpoint = async phase => { if (phase === 'rotation-intent') f.busy(); };
    await expect(f.controller.assign()).rejects.toThrow('WORKER_BUSY');
    expect(f.calls).not.toContain('rotate'); expect(f.state().owner).toBeTruthy();
  });
  it('unknown identity linkage blocks recovery rather than rotating an unrelated identity', async () => {
    const f = fixture(); f.crash('config-intent'); await expect(f.controller.assign()).rejects.toThrow(); f.crash('');
    f.adapter.readIdentity = async () => ({ activeJti: 'foreign', previousJti: 'foreign-parent', projectIds: ['old'] });
    await expect(f.controller.recover()).rejects.toThrow('ROTATION_COMMIT_AMBIGUOUS');
    expect(f.calls.filter(v => v === 'rotate')).toHaveLength(1); expect(f.state().owner).toBeTruthy();
  });
  it('corrupt backup and changed file ownership/mode are not repaired silently', async () => {
    const f = fixture(); f.crash('config-intent'); await expect(f.controller.assign()).rejects.toThrow(); f.crash('');
    fs.chmodSync(f.input.configFile, 0o600);
    await expect(f.controller.recover()).rejects.toThrow('METADATA_DRIFT');
    fs.chmodSync(f.input.configFile, 0o640);
    fs.writeFileSync(f.state().operation.config.backup, 'corrupt');
    await expect(f.controller.recover()).rejects.toThrow('BACKUP_CHANGED'); expect(f.state().owner).toBeTruthy();
  });
  it('probe failure and rollback smoke failure both preserve the fence', async () => {
    const f = fixture(); f.adapter.projectProbe = async () => { throw new Error('PROBE_FAILED'); };
    await expect(f.controller.assign()).rejects.toThrow('PROBE_FAILED');
    f.adapter.maintenanceSmoke = async () => { throw new Error('SMOKE_FAILED'); };
    await expect(f.controller.recover()).rejects.toThrow('SMOKE_FAILED'); expect(f.state().owner).toBeTruthy();
    expect(f.calls).not.toContain('commit');
  });
  it('EX controller excludes a real deployment SH participant', async () => {
    const f = fixture(); const fd = fs.openSync(f.input.lockFile, 'r');
    expect(spawnSync('flock', ['-s', '-n', '3'], { stdio: ['ignore', 'ignore', 'ignore', fd], timeout: 1000 }).status).toBe(0);
    try { await expect(f.controller.assign()).rejects.toThrow('LOCK_BUSY'); } finally { fs.closeSync(fd); }
    expect(f.state().owner).toBeNull();
  });
  it('real child exit after durable fence loses kernel lock but not recovery ownership', async () => {
    const f = fixture(); const module = new URL('./worker-scope-assignment-lifecycle.ts', import.meta.url).href;
    const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', `import {acquireScopeMutationLock,durableWrite} from ${JSON.stringify(module)}; acquireScopeMutationLock(${JSON.stringify(f.input.lockFile)}); durableWrite(${JSON.stringify(f.input.stateFile)},JSON.stringify({version:1,owner:'crashed-owner',phase:'rotation-intent'})); process.exit(73);`], { timeout: 5000, stdio: 'ignore' });
    expect(await new Promise(resolve => child.once('exit', resolve))).toBe(73);
    expect(spawnSync('flock', ['-x', '-n', f.input.lockFile, 'true'], { timeout: 1000 }).status).toBe(0);
    expect(f.gate.enter()).toBeNull(); await expect(f.controller.assign()).rejects.toThrow('RECOVERY_REQUIRED');
  });
});

describe('fixed project probe: real disk gate and production upload publication', () => {
  it('cleanup error still leaves admission counter exactly once', async () => {
    const f = fixture(); f.crash('probe-intent'); await expect(f.controller.assign()).rejects.toThrow();
    const op = f.state().operation;op.livePid=process.pid;const journal=f.state();journal.operation=op;fs.writeFileSync(f.input.stateFile,JSON.stringify(journal));
    const spy = vi.spyOn(fs, 'rmdirSync').mockImplementation(() => { throw new Error('CLEANUP_FAILED'); });
    try {
      await expect(runWorkerScopeProjectProbe({ assertTrustedState:protectedPath,stateFile: f.input.stateFile, owner: op.id, workerId: 'w', projects: op.newScope,
        gate: f.gate, resolveProjectFile: () => { throw new Error('RESOLVER_FAILED'); } })).rejects.toThrow('CLEANUP_FAILED');
      expect(f.gate.snapshot()).toEqual({ draining: true, activeRequests: 0 });
    } finally { spy.mockRestore(); }
  });
  it('does real Project file roundtrip under fence, takes no caller path or command', async () => {
    const f = fixture(); f.crash('probe-intent'); await expect(f.controller.assign()).rejects.toThrow();
    const operation = f.state().operation;operation.livePid=process.pid;const journal=f.state();journal.operation=operation;fs.writeFileSync(f.input.stateFile,JSON.stringify(journal));
    const receipt = await runWorkerScopeProjectProbe({ assertTrustedState:protectedPath,stateFile: f.input.stateFile, owner: operation.id, workerId: 'w', projects: operation.newScope, gate: f.gate,
      resolveProjectFile: (root, relative) => path.join(root, relative) });
    expect(receipt).toMatchObject({ pid: process.pid, cleaned: true, projectId: 'new' });
    expect(fs.readdirSync(f.input.root)).toEqual([]); expect(f.gate.snapshot()).toEqual({ draining: true, activeRequests: 0 });
    await expect(runWorkerScopeProjectProbe({ assertTrustedState:protectedPath,stateFile: f.input.stateFile, owner: 'foreign', workerId: 'w', projects: operation.newScope, gate: f.gate, resolveProjectFile: (r, p) => path.join(r, p) })).rejects.toThrow('NOT_OWNER');
  });
});

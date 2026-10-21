import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createWorkerScopeHeartbeatAdapter, type HeartbeatControlConfig } from './worker-scope-heartbeat-adapter.js';
import { digest, type AssignmentOperation } from './worker-scope-assignment-lifecycle.js';

const roots: string[] = [];
afterEach(() => { for (const p of roots.splice(0)) fs.rmSync(p, { recursive: true, force: true }); });
function fixture() {
  const root = fs.mkdtempSync(`/run/user/${process.getuid!()}/heartbeat-scope-`); roots.push(root);
  const worker = 'tower-workbench-worker-w.service'; const heartbeat = 'tower-workbench-worker-w-heartbeat.service';
  const c: HeartbeatControlConfig = { workerId: 'w', deploymentId: 'test', workerUnit: worker, heartbeatUnit: heartbeat,
    workerFragment: path.join(root, worker), heartbeatFragment: path.join(root, heartbeat), identityFile: path.join(root, 'identity.jwt'),
    stateFile: path.join(root, 'state.json'), backupDirectory: path.join(root, 'backups') };
  fs.mkdirSync(c.backupDirectory, { mode: 0o700 });
  fs.writeFileSync(c.workerFragment, '[Service]\nExecStart=/nix/store/fixed/bin/worker\n', { mode: 0o644 });
  const original = `[Unit]\nDescription=unchanged\n[Service]\nUser=worker\nEnvironment=TOWER_LOCAL_WORKER_ID=w\nEnvironment=TOWER_LOCAL_WORKER_DEPLOYMENT_ID=test\nEnvironment=TOWER_LOCAL_WORKER_IDENTITY_FILE=${c.identityFile}\nEnvironment=TOWER_LOCAL_WORKER_PROJECT_IDS=z,old\nEnvironment=TOWER_LOCAL_WORKER_CAPABILITIES=shell,service\nExecStart=/nix/store/fixed/bin/heartbeat\n[Install]\nWantedBy=multi-user.target\n`;
  fs.writeFileSync(c.heartbeatFragment, original, { mode: 0o640 });
  const config = path.join(root, 'trusted.json'); fs.writeFileSync(config, JSON.stringify(c), { mode: 0o600 });
  const op = { kind: 'scope-assignment', version: 1, id: 'operation-a', workerId: 'w', deploymentId: 'test', phase: 'heartbeat-plan-intent',
    oldScope: { old: '/projects/old', z: '/projects/z' }, newScope: { old: '/projects/old', z: '/projects/z', fresh: '/projects/fresh' }, identity: { path: c.identityFile } } as unknown as AssignmentOperation;
  const save = () => fs.writeFileSync(c.stateFile, JSON.stringify({ version: 1, owner: op.id, operation: op }), { mode: 0o644 }); save();
  const calls: string[][] = []; const drops: string[] = []; let authorized = true; let busy = false; let reload = 'no'; let failCommand = ''; let grants = 0;
  const adapter = createWorkerScopeHeartbeatAdapter({ trustedConfigFile: config,
    authorize: async () => { grants++; if (!authorized) throw new Error('DENIED'); }, idle: async () => !busy,
    runner: async args => {
      calls.push(args);
      if (args[0] === failCommand) throw new Error('INJECTED_CRASH');
      if (args[0] === 'show') return `FragmentPath=${args[1] === worker ? c.workerFragment : c.heartbeatFragment}\nDropInPaths=${args[1] === heartbeat ? drops.join(' ') : ''}\nLoadState=loaded\nNeedDaemonReload=${reload}\nKillMode=process\nSendSIGKILL=no\nTimeoutStopUSec=infinity\n`;
      if (args[0] === 'daemon-reload') reload = 'no';
      return '';
    } });
  const capture = async () => { op.heartbeat = await adapter.captureHeartbeatEvidence(op.newScope, op.id); save(); };
  return { root, c, config, original, op, save, adapter, capture, calls, drops, grants: () => grants,
    deny: () => { authorized = false; }, busy: () => { busy = true; }, reload: () => { reload = 'yes'; }, fail: (value: string) => { failCommand = value; } };
}

describe('heartbeat existing unit scope-only update and restore', () => {
  it('backs up exact scope line/metadata/hash, preserves all other bytes and restores exactly', async () => {
    const f = fixture(); await f.capture(); const evidence = f.op.heartbeat!;
    expect(evidence.fragment.sha256).toBe(digest(f.original)); expect(evidence.oldLine).toBe('Environment=TOWER_LOCAL_WORKER_PROJECT_IDS=z,old');
    expect(fs.statSync(evidence.fragment.backup).mode & 0o777).toBe(0o600);
    f.op.phase = 'restart-intent'; f.save(); await f.adapter.restart(f.op.newScope);
    expect(fs.readFileSync(f.c.heartbeatFragment, 'utf8')).toBe(f.original.replace(evidence.oldLine, evidence.newLine));
    expect(fs.statSync(f.c.heartbeatFragment).mode & 0o777).toBe(0o640);
    await f.adapter.verifyHeartbeat(f.op.newScope);
    expect(f.calls.filter(c => c[0] !== 'show')).toEqual([['daemon-reload'], ['restart', f.c.workerUnit, f.c.heartbeatUnit]]);
    f.op.phase = 'rollback-restart-intent'; f.save(); await f.adapter.restart(f.op.oldScope);
    expect(fs.readFileSync(f.c.heartbeatFragment, 'utf8')).toBe(f.original);
    expect(JSON.parse(fs.readFileSync(f.c.stateFile, 'utf8')).owner).toBe(f.op.id);
    expect(f.grants()).toBeGreaterThan(4);
  });
  it('only replaces the exact directive line, not a matching comment', async () => {
    const f = fixture(); const text = '# Environment=TOWER_LOCAL_WORKER_PROJECT_IDS=z,old\n' + f.original;
    fs.writeFileSync(f.c.heartbeatFragment, text); await f.capture(); f.op.phase = 'restart-intent'; f.save(); await f.adapter.restart(f.op.newScope);
    expect(fs.readFileSync(f.c.heartbeatFragment, 'utf8').split('\n')[0]).toBe('# Environment=TOWER_LOCAL_WORKER_PROJECT_IDS=z,old');
    f.op.phase = 'rollback-restart-intent'; f.save(); await f.adapter.restart(f.op.oldScope); expect(fs.readFileSync(f.c.heartbeatFragment, 'utf8')).toBe(text);
  });
  it('refuses direct restart without authorization, idle or durable evidence', async () => {
    const f = fixture(); await expect(f.adapter.restart(f.op.newScope)).rejects.toThrow('JOURNAL');
    await f.capture(); f.op.phase = 'restart-intent'; f.save(); f.deny();
    await expect(f.adapter.restart(f.op.newScope)).rejects.toThrow('DENIED');
    expect(f.calls.every(c => c[0] === 'show')).toBe(true);
    const g = fixture(); await g.capture(); g.op.phase = 'restart-intent'; g.save(); g.busy();
    await expect(g.adapter.restart(g.op.newScope)).rejects.toThrow('BUSY'); expect(fs.readFileSync(g.c.heartbeatFragment, 'utf8')).toBe(g.original);
  });
  it.each(['Environment=TOWER_LOCAL_WORKER_PROJECT_IDS=foreign', 'EnvironmentFile=/protected/input.env', 'Environment=', 'UnsetEnvironment=TOWER_LOCAL_WORKER_PROJECT_IDS', 'ExecStart=/other', 'ExecStartPost=/other'])('refuses precedence conflict %s', async line => {
    const f = fixture(); const drop = path.join(f.root, '99-override.conf'); fs.writeFileSync(drop, `[Service]\n${line}\n`, { mode: 0o644 }); f.drops.push(drop);
    await expect(f.capture()).rejects.toThrow(); expect(f.calls.every(c => c[0] === 'show')).toBe(true);
  });
  it('accepts only policy-pinned executable overrides and detects later drift', async () => {
    const f = fixture(); const store = '/nix/store/' + 'a'.repeat(32) + '-tower-app-1';
    fs.writeFileSync(f.config, JSON.stringify({ ...f.c, storePath: store }));
    const drop = path.join(f.root, '95-build.conf');
    fs.writeFileSync(drop, `[Service]\nExecStart=\nExecStart=${store}/bin/tower-workbench-worker-heartbeat\n`);
    f.drops.push(drop); await f.capture();
    f.op.phase = 'restart-intent'; f.save(); await f.adapter.restart(f.op.newScope);
    fs.appendFileSync(drop, '# drift\n');
    await expect(f.adapter.restart(f.op.newScope)).rejects.toThrow();
  });
  it.each(['wrong-build', 'argument', 'hook', 'environment'])('rejects unsafe build override %s', async kind => {
    const f = fixture(); const store = '/nix/store/' + 'a'.repeat(32) + '-tower-app-1';
    fs.writeFileSync(f.config, JSON.stringify({ ...f.c, storePath: store }));
    let text = `[Service]\nExecStart=\nExecStart=${store}/bin/tower-workbench-worker-heartbeat\n`;
    if (kind === 'wrong-build') text = text.replace('-tower-app-1', '-tower-app-2');
    if (kind === 'argument') text = text.replace('-heartbeat\n', '-heartbeat --other\n');
    if (kind === 'hook') text += 'ExecStartPost=/other\n';
    if (kind === 'environment') text += 'Environment=OTHER=value\n';
    const drop = path.join(f.root, '95-build.conf'); fs.writeFileSync(drop, text); f.drops.push(drop);
    await expect(f.capture()).rejects.toThrow();
    expect(f.calls.every(c => c[0] === 'show')).toBe(true);
  });
  it('detects new resolved drop-in after journal capture and does not overwrite', async () => {
    const f = fixture(); await f.capture(); const drop = path.join(f.root, '10-label.conf'); fs.writeFileSync(drop, '[Unit]\nDescription=label\n', { mode: 0o644 }); f.drops.push(drop);
    f.op.phase = 'restart-intent'; f.save(); await expect(f.adapter.restart(f.op.newScope)).rejects.toThrow('PRECEDENCE_CHANGED');
    expect(fs.readFileSync(f.c.heartbeatFragment, 'utf8')).toBe(f.original);
  });
  it('permits harmless loaded drop-in but journals its hash', async () => {
    const f = fixture(); const drop = path.join(f.root, '10-label.conf'); fs.writeFileSync(drop, '[Unit]\nDescription=label\n', { mode: 0o644 }); f.drops.push(drop);
    await f.capture(); expect(f.op.heartbeat!.inventory.some(i => i.path === drop)).toBe(true);
    fs.appendFileSync(drop, '# changed\n'); f.op.phase = 'restart-intent'; f.save(); await expect(f.adapter.restart(f.op.newScope)).rejects.toThrow('FILE_DRIFT');
  });
  it.each(['duplicate', 'quoted', 'reset', 'wrong-scope'])('rejects noncanonical original line: %s', async kind => {
    const f = fixture(); let text = f.original;
    if (kind === 'duplicate') text = text.replace('[Install]', 'Environment=TOWER_LOCAL_WORKER_PROJECT_IDS=old,z\n[Install]');
    if (kind === 'quoted') text = text.replace('Environment=TOWER_LOCAL_WORKER_PROJECT_IDS=z,old', 'Environment="TOWER_LOCAL_WORKER_PROJECT_IDS=z,old"');
    if (kind === 'reset') text = text.replace('[Install]', 'Environment=\n[Install]');
    if (kind === 'wrong-scope') text = text.replace('PROJECT_IDS=z,old', 'PROJECT_IDS=old');
    fs.writeFileSync(f.c.heartbeatFragment, text); await expect(f.capture()).rejects.toThrow();
  });
  it('rejects config target mismatch, symlink, metadata drift and corrupted backup', async () => {
    const f = fixture(); fs.writeFileSync(f.config, JSON.stringify({ ...f.c, heartbeatUnit: 'unrelated.service' })); await expect(f.capture()).rejects.toThrow('UNIT_ID');
    fs.writeFileSync(f.config, JSON.stringify(f.c)); await f.capture(); f.op.phase = 'restart-intent'; f.save();
    fs.chmodSync(f.c.heartbeatFragment, 0o600); await expect(f.adapter.restart(f.op.newScope)).rejects.toThrow('FILE_DRIFT'); fs.chmodSync(f.c.heartbeatFragment, 0o640);
    fs.writeFileSync(f.op.heartbeat!.fragment.backup, 'changed'); await expect(f.adapter.restart(f.op.newScope)).rejects.toThrow('BACKUP_CHANGED');
    const g = fixture(); fs.renameSync(g.c.heartbeatFragment, g.c.heartbeatFragment + '.saved'); fs.symlinkSync(g.c.heartbeatFragment + '.saved', g.c.heartbeatFragment);
    await expect(g.capture()).rejects.toThrow('UNTRUSTED');
  });
  it('crash after rename preserves journal/fence and restores only known after hash', async () => {
    const f = fixture(); await f.capture(); f.op.phase = 'restart-intent'; f.save(); f.fail('daemon-reload');
    await expect(f.adapter.restart(f.op.newScope)).rejects.toThrow('INJECTED_CRASH');
    expect(digest(fs.readFileSync(f.c.heartbeatFragment))).toBe(f.op.heartbeat!.afterSha256);
    expect(JSON.parse(fs.readFileSync(f.c.stateFile, 'utf8')).operation.heartbeat.fragment.sha256).toBe(digest(f.original));
    f.fail(''); f.reload(); f.op.phase = 'rollback-restart-intent'; f.save(); await f.adapter.restart(f.op.oldScope);
    expect(fs.readFileSync(f.c.heartbeatFragment, 'utf8')).toBe(f.original);
  });
  it('restart response failure leaves before/after evidence; foreign rollback hash is preserved', async () => {
    const f = fixture(); await f.capture(); f.op.phase = 'restart-intent'; f.save(); f.fail('restart');
    await expect(f.adapter.restart(f.op.newScope)).rejects.toThrow('INJECTED_CRASH');
    fs.appendFileSync(f.c.heartbeatFragment, '# foreign\n'); const bytes = fs.readFileSync(f.c.heartbeatFragment, 'utf8');
    f.fail(''); f.op.phase = 'rollback-restart-intent'; f.save(); await expect(f.adapter.restart(f.op.oldScope)).rejects.toThrow('FILE_DRIFT');
    expect(fs.readFileSync(f.c.heartbeatFragment, 'utf8')).toBe(bytes);
  });
  it('critical identity directive outside Service is rejected', async () => {
    const f = fixture(); fs.writeFileSync(f.c.heartbeatFragment, f.original.replace('Environment=TOWER_LOCAL_WORKER_ID=w\n', '') + '\n[Unit]\nEnvironment=TOWER_LOCAL_WORKER_ID=w\n');
    await expect(f.capture()).rejects.toThrow('SECTION_INVALID');
  });
  it('unknown pending daemon reload before capture is not accepted as baseline', async () => {
    const f = fixture(); f.reload(); await expect(f.capture()).rejects.toThrow('EFFECTIVE_UNIT_UNKNOWN');
  });
});

import { describe, it, expect } from 'vitest';
import { WorkerMaintenanceGate } from './worker-maintenance-gate.js';
import { createRemoteWorkbenchWorkerServer } from '../execution/worker/worker-server.js';
import type { AddressInfo } from 'node:net';

describe('Worker maintenance admission fence', () => {
  it('counts admitted requests until completion and rejects new requests', () => {
    const g = new WorkerMaintenanceGate(); const leave = g.enter()!;
    expect(g.acquire('owner')).toBe(true);
    expect(g.enter()).toBeNull();
    expect(g.snapshot()).toEqual({ draining: true, activeRequests: 1 });
    leave(); leave();
    expect(g.snapshot().activeRequests).toBe(0);
  });
  it('cannot release or steal another owner fence', () => {
    const g = new WorkerMaintenanceGate(); g.acquire('a');
    expect(g.acquire('b')).toBe(false); expect(g.release('b')).toBe(false);
    expect(g.release('a')).toBe(true); expect(g.enter()).not.toBeNull();
  });
  it('rejects direct HTTP runs while keeping health and authentication intact', async () => {
    const gate = new WorkerMaintenanceGate(); gate.acquire('test');
    const server = createRemoteWorkbenchWorkerServer({ workerId: 'test', token: 'synthetic-token', projects: {}, maintenanceGate: gate });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      expect((await fetch(base + '/health')).status).toBe(200);
      expect((await fetch(base + '/v1/runs', { method: 'POST', body: '{}' })).status).toBe(401);
      const r = await fetch(base + '/v1/runs', { method: 'POST', headers: { authorization: 'Bearer synthetic-token' }, body: '{}' });
      expect(r.status).toBe(503); expect(await r.text()).toContain('WORKER_MAINTENANCE');
      expect(gate.snapshot().activeRequests).toBe(0);
      gate.release('test');
      const bad = await fetch(base + '/v1/runs', { method: 'POST', headers: { authorization: 'Bearer synthetic-token' }, body: '{}' });
      expect(bad.status).toBe(400);
      expect(gate.snapshot().activeRequests).toBe(0);
    } finally { server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(e => e ? reject(e) : resolve())); }
  });
});

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

describe('durable maintenance file and fixed smoke', () => {
  it('observes a durable owner across process instances and fails closed on corruption/missing input', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'maintenance-'));
    const file = path.join(root, 'state.json');
    try {
      const a = new WorkerMaintenanceGate(file);
      expect(a.enter()).toBeNull();
      expect(a.enterProbe('unavailable-state')).toBeNull();
      fs.writeFileSync(file, JSON.stringify({ version: 1, owner: null }));
      const leave = a.enter()!;
      expect(leave).toBeTypeOf('function');
      fs.writeFileSync(file, JSON.stringify({ version: 1, owner: 'crashed-owner' }));
      expect(a.enter()).toBeNull();
      expect(new WorkerMaintenanceGate(file).enter()).toBeNull();
      expect(a.release('crashed-owner')).toBe(false);
      leave();
      fs.writeFileSync(file, 'partial');
      expect(a.enter()).toBeNull();
      expect(a.enterProbe('invalid-state')).toBeNull();
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
  it('fences file and proxy paths and runs only fixed synthetic env/file cleanup under an owned fence', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'maintenance-smoke-'));
    const smoke = path.join(root, 'smoke'); fs.mkdirSync(smoke);
    const state = path.join(root, 'state.json');
    fs.writeFileSync(state, JSON.stringify({ version: 1, owner: 'synthetic-owner' }));
    const gate = new WorkerMaintenanceGate(state);
    const server = createRemoteWorkbenchWorkerServer({ workerId: 'w', token: 'synthetic-token', projects: { p: root }, maintenanceGate: gate, maintenanceSmokeRoot: smoke });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const headers = { authorization: 'Bearer synthetic-token', 'x-tower-maintenance-owner': 'synthetic-owner' };
    try {
      for (const [method, route] of [['GET','/v1/files/p/content?path=test'], ['PUT','/v1/files/p/content?path=test'], ['GET','/v1/files/p/manifest'], ['POST','/v1/runs'], ['GET','/v1/services/p/3000/']]) {
        const r = await fetch(base + route, { method, headers });
        expect(r.status).toBe(503);
      }
      expect((await fetch(base + '/v1/maintenance/status')).status).toBe(401);
      const status = await (await fetch(base + '/v1/maintenance/status', { headers })).json();
      expect(status).toMatchObject({ draining: true, activeRequests: 0, pid: process.pid });
      expect((await fetch(base + '/v1/maintenance/smoke', { method: 'POST', headers: { authorization: headers.authorization } })).status).toBe(403);
      const result = await fetch(base + '/v1/maintenance/smoke', { method: 'POST', headers, body: JSON.stringify({ command: 'touch forbidden' }) });
      const text = await result.text();
      expect(result.status).toBe(200);
      expect(text).toContain('MAINTENANCE_SMOKE_OK');
      expect(text).toContain('"exit_code":0');
      expect(text).not.toContain('tower-synthetic-maintenance-value');
      expect(fs.existsSync(path.join(smoke, 'forbidden'))).toBe(false);
      expect(fs.readdirSync(smoke)).toEqual([]);
      expect(gate.snapshot()).toEqual({ draining: true, activeRequests: 0 });
    } finally {
      server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

it('Python recovery controller verifies a real Worker HTTP process and releases durable ownership only after synthetic cleanup', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'maintenance-controller-'));
  const state = path.join(root, 'state.json');
  const smoke = path.join(root, 'smoke'); fs.mkdirSync(smoke);
  const store = '/nix/store/' + 'a'.repeat(32) + '-synthetic';
  fs.writeFileSync(state, JSON.stringify({ version: 1, owner: 'recovery-owner', phase: 'verifying', target: store }));
  const gate = new WorkerMaintenanceGate(state);
  const server = createRemoteWorkbenchWorkerServer({ workerId: 'w', token: 'synthetic-token', projects: { p: root }, maintenanceGate: gate, maintenanceSmokeRoot: smoke,
    managedSkillsRoot: smoke, bwrapBin: '/bin/true', runtimeProvenance: { storePath: store } });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const controller = `
import importlib.machinery, importlib.util, json, os, pathlib, sys
loader=importlib.machinery.SourceFileLoader('maintenance',sys.argv[1]); spec=importlib.util.spec_from_loader(loader.name,loader)
m=importlib.util.module_from_spec(spec); loader.exec_module(m)
a=m.Maintenance.__new__(m.Maintenance)
a.directory=pathlib.Path(sys.argv[2]); a.state_path=a.directory/'state.json'; a.state=json.loads(a.state_path.read_text())
a.c={'workerId':'w','baseUrl':sys.argv[3],'smokeRoot':str(a.directory/'smoke')}
a.approval=lambda:sys.argv[4]
a.live=lambda target: a.status()['pid']==int(sys.argv[5]) and a.status()['storePath']==target
# DB heartbeat is synthetic here; HTTP, smoke subprocess, credentials and state are real.
a.db=lambda: {'heartbeatAge':0,'heartbeatAt':9999999999}
print(a.run(recover=True))
`;
  try {
    const result = await promisify(execFile)('python3', ['-c', controller, path.resolve('scripts/nix-app/tower-worker-maintenance'), root, base, store, String(process.pid)], {
      env: { ...process.env, TOWER_REMOTE_WORKER_TOKEN: 'synthetic-token' }, timeout: 30000,
    });
    expect(result.stdout.trim()).toBe('recovered');
    expect(JSON.parse(fs.readFileSync(state, 'utf8'))).toMatchObject({ owner: null, result: 'recovered', completedOwner: 'recovery-owner' });
    expect(gate.snapshot().draining).toBe(false);
  } finally {
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    fs.rmSync(root, { recursive: true, force: true });
  }
});

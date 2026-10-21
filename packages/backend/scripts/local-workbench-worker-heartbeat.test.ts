import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
let dir: string;
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.resetModules(); if (dir) fs.rmSync(dir, { recursive: true, force: true }); });
it('reloads an atomically replaced identity on the next heartbeat without restarting', async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'heartbeat-renew-'));
  const file = path.join(dir, 'identity'); fs.writeFileSync(file, 'synthetic-before');
  for (const [key, value] of Object.entries({ TOWER_LOCAL_WORKER_ID: 'w', TOWER_LOCAL_WORKER_BASE_URL: 'http://localhost:1234',
    TOWER_LOCAL_WORKER_CONTROL_PLANE_URL: 'http://localhost:5678', TOWER_LOCAL_WORKER_IDENTITY_FILE: file, TOWER_LOCAL_WORKER_PROJECT_IDS: 'p' })) vi.stubEnv(key, value);
  const fetch = vi.fn(async () => ({ ok: true })); vi.stubGlobal('fetch', fetch);
  let tick: () => void = () => {};
  vi.stubGlobal('setInterval', (callback: () => void) => { tick = callback; return 1; });
  await import('./local-workbench-worker-heartbeat.js');
  expect((fetch.mock.calls as any)[0][1].headers.authorization).toBe('Bearer synthetic-before');
  fs.writeFileSync(file + '.next', 'synthetic-after'); fs.renameSync(file + '.next', file); tick();
  await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
  expect((fetch.mock.calls as any)[1][1].headers.authorization).toBe('Bearer synthetic-after');
});
it('runs renewal before idle/delegated routing under an exclusive lock', () => {
  const source = fs.readFileSync(path.resolve('scripts/nix-app/tower-workbench-assignment-reconciler'), 'utf8');
  expect(source.indexOf('node "$renewal_entry"')).toBeLessThan(source.indexOf('node "$route_entry"'));
  expect(source).toContain('flock -x -n -E 75 196');
  expect(source).toContain('deployment-lock-busy');
  expect(source).toContain('node "$renewal_entry" || exit 1');
  expect(source).toContain("identity renewal failed; operator inspection required");
});

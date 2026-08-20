import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadRemoteWorkbenchWorkerConfig } from './remote-workbench-worker-entrypoint.js';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
});

async function tempRoot() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tower-worker-config-'));
  roots.push(root);
  return root;
}

describe('Remote Workbench Worker standalone config', () => {
  it('loads fixed project roots from an operator-owned config file', async () => {
    const root = await tempRoot();
    const project = path.join(root, 'project-a');
    await fs.mkdir(project);
    const config = path.join(root, 'worker.json');
    await fs.writeFile(config, JSON.stringify({ workerId: 'worker-a', host: '127.0.0.1', port: 43123, projects: { p: project } }));
    expect(loadRemoteWorkbenchWorkerConfig(config)).toEqual({
      workerId: 'worker-a', host: '127.0.0.1', port: 43123, projects: { p: project },
    });
  });

  it('loads only fixed operator-owned projections below /workspace', async () => {
    const root = await tempRoot();
    const project = path.join(root, 'project-a');
    const tower = path.join(root, 'tower');
    await fs.mkdir(project);
    await fs.mkdir(tower);
    const config = path.join(root, 'worker.json');
    await fs.writeFile(config, JSON.stringify({
      workerId: 'worker-a', host: '127.0.0.1', port: 43123, projects: { p: project },
      projections: { '/workspace/tower': tower },
    }));
    expect(loadRemoteWorkbenchWorkerConfig(config)).toMatchObject({
      projects: { p: project }, projections: { '/workspace/tower': tower },
    });
  });

  it('rejects unknown config keys and non-directory project roots', async () => {
    const root = await tempRoot();
    const config = path.join(root, 'worker.json');
    await fs.writeFile(config, JSON.stringify({ workerId: 'worker-a', port: 43123, projects: { p: path.join(root, 'missing') }, token: 'must-not-live-here' }));
    expect(() => loadRemoteWorkbenchWorkerConfig(config)).toThrow();
  });
});

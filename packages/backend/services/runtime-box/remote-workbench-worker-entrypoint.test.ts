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
    await fs.writeFile(config, JSON.stringify({ workerId: 'worker-a', host: '127.0.0.1', port: 43123, projects: { p: project }, bwrapBin: '/usr/bin/bwrap', runtimeProvenance: { sourceRev: 'abc123', storePath: '/nix/store/example' } }));
    expect(loadRemoteWorkbenchWorkerConfig(config)).toEqual({
      workerId: 'worker-a', host: '127.0.0.1', port: 43123, projects: { p: project }, bwrapBin: '/usr/bin/bwrap', runtimeProvenance: { sourceRev: 'abc123', storePath: '/nix/store/example' },
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
      projections: { '/workspace/tower': tower }, bwrapBin: '/usr/bin/bwrap',
    }));
    expect(loadRemoteWorkbenchWorkerConfig(config)).toMatchObject({
      projects: { p: project }, projections: { '/workspace/tower': tower },
    });
  });

  it('loads one operator-owned managed skills root for runtime projection', async () => {
    const root = await tempRoot();
    const project = path.join(root, 'project-a');
    const skills = path.join(root, 'teamskills', 'skills');
    await fs.mkdir(project, { recursive: true });
    await fs.mkdir(skills, { recursive: true });
    const config = path.join(root, 'worker.json');
    await fs.writeFile(config, JSON.stringify({ workerId: 'worker-a', port: 43123, projects: { p: project }, managedSkillsRoot: skills, bwrapBin: '/usr/bin/bwrap' }));
    expect(loadRemoteWorkbenchWorkerConfig(config)).toMatchObject({ managedSkillsRoot: skills, bwrapBin: '/usr/bin/bwrap' });
  });

  it('does not infer sandbox opt-in from installed Skills', async () => {
    const root = await tempRoot();
    const config = path.join(root, 'worker.json');
    const base = { workerId: 'worker-a', port: 43123, projects: { p: root }, bwrapBin: '/usr/bin/bwrap' };
    for (const extra of [{}, { managedSkillsRoot: root }]) {
      await fs.writeFile(config, JSON.stringify({ ...base, ...extra }));
      expect(loadRemoteWorkbenchWorkerConfig(config).isolationProfile).toBeUndefined();
    }
    // This guards config defaulting, not the remaining legacy Skill-dependent runtime branch.
  });

  it('accepts only server-owned known isolation profiles', async () => {
    const root = await tempRoot();
    const config = path.join(root, 'worker.json');
    const base = { workerId: 'worker-a', port: 43123, projects: { p: root }, bwrapBin: '/usr/bin/bwrap' };
    await fs.writeFile(config, JSON.stringify({ ...base, isolationProfile: 'project-sandbox-v1' }));
    expect(loadRemoteWorkbenchWorkerConfig(config).isolationProfile).toBe('project-sandbox-v1');
    await fs.writeFile(config, JSON.stringify({ ...base, isolationProfile: 'unrestricted' }));
    expect(() => loadRemoteWorkbenchWorkerConfig(config)).toThrow();
  });

  it('rejects unknown config keys and non-directory project roots', async () => {
    const root = await tempRoot();
    const config = path.join(root, 'worker.json');
    await fs.writeFile(config, JSON.stringify({ workerId: 'worker-a', port: 43123, projects: { p: path.join(root, 'missing') }, token: 'must-not-live-here' }));
    expect(() => loadRemoteWorkbenchWorkerConfig(config)).toThrow();
  });
});

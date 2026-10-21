import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { afterEach, expect, it, vi } from 'vitest';
import { materializeProjectRegistrySkills } from './project-skill-materializer.js';
import { updateStableSkills } from './stable-release-updater.js';

const cwd = path.resolve(import.meta.dirname, '../../../..');
const watcherCode = `
  import fs from 'node:fs';
  import path from 'node:path';
  import readline from 'node:readline';
  import { resolveRegistrySkillBundle } from './packages/backend/services/skill/skill-bundle-resolver.ts';
  import { buildRuntimeSkillBindMountPlan } from './packages/backend/services/skill/runtime-skill-bind-mount.ts';
  import { resolveOperatorSkillAssets } from './packages/backend/services/skill/operator-skill-assets.ts';
  import { getSkill } from './packages/backend/services/skill/skill-registry.ts';
  import { readTeamskillsSkillset } from './packages/backend/services/skill/teamskills-source.ts';
  const project = process.argv[1];
  for await (const line of readline.createInterface({ input: process.stdin })) {
    try {
      const selected = resolveRegistrySkillBundle('alpha');
      const registry = await getSkill('alpha');
      const plan = buildRuntimeSkillBindMountPlan(project);
      const controlPath = path.join(project, '.tower/skills/alpha/SKILL.md');
      const control = fs.existsSync(controlPath) ? fs.readFileSync(controlPath, 'utf8') : '';
      const assets = resolveOperatorSkillAssets(project, 'alpha', control);
      console.log(JSON.stringify({ step: line, digest: selected?.bundleDigest, body: registry?.content, defaults: readTeamskillsSkillset([]), enabled: plan.enabled, skipped: plan.skipped, source: plan.mounts[0]?.sourcePath, assetStatus: assets.status, assetPath: assets.status === 'source-verified' ? assets.executionDirectory : null }));
    } catch (error) { console.log(JSON.stringify({ step: line, error: String(error) })); }
  }
`;
const updaterCode = `
  import fs from 'node:fs';
  import path from 'node:path';
  import { updateStableSkills } from './packages/backend/services/skill/stable-release-updater.ts';
  const [root, sourceRoot, releasesRoot, project] = process.argv.slice(1);
  const rename = fs.renameSync;
  fs.renameSync = function(from, to) {
    const result = rename.apply(this, arguments);
    if (String(to).endsWith('/active.json')) {
      fs.writeFileSync(path.join(root, 'switched'), 'yes');
      const gate = path.join(root, 'continue');
      while (!fs.existsSync(gate)) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
    }
    return result;
  };
  const write = fs.writeFileSync;
  fs.writeFileSync = function(file) {
    if (file === path.join(project, '.tower/skills/manifest.json')) throw new Error('injected manifest write failure');
    return write.apply(this, arguments);
  };
  updateStableSkills({ sourceRoot, releasesRoot, projectRoots: [project], mode: 'apply', input: {
    descriptor: fs.readFileSync(path.join(root, 'descriptor')),
    signature: fs.readFileSync(path.join(root, 'signature')),
    archive: fs.readFileSync(path.join(root, 'archive')),
    publicKey: fs.readFileSync(path.join(root, 'publicKey')),
  }});
`;

function child(code: string, args: string[], env: NodeJS.ProcessEnv): ChildProcessWithoutNullStreams {
  return spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', code, ...args], { cwd, env, stdio: 'pipe' });
}
function observer(proc: ChildProcessWithoutNullStreams) {
  let pending: ((value: any) => void) | null = null;
  let buffer = '';
  proc.stdout.on('data', chunk => {
    buffer += chunk.toString();
    while (buffer.includes('\n')) {
      const index = buffer.indexOf('\n');
      const line = buffer.slice(0, index); buffer = buffer.slice(index + 1);
      if (pending) { const resolve = pending; pending = null; resolve(JSON.parse(line)); }
    }
  });
  return (step: string) => new Promise<any>((resolve, reject) => {
    if (pending) return reject(new Error('overlapping observation'));
    const timeout = setTimeout(() => { pending = null; reject(new Error(`watcher timed out: ${step}`)); }, 10_000);
    pending = value => { clearTimeout(timeout); resolve(value); };
    proc.stdin.write(step + '\n');
  });
}
async function waitFor(file: string): Promise<void> {
  for (let i = 0; i < 500; i++) { if (fs.existsSync(file)) return; await new Promise(resolve => setTimeout(resolve, 20)); }
  throw new Error(`timed out waiting for ${path.basename(file)}`);
}
async function waitExit(proc: ChildProcessWithoutNullStreams): Promise<number | null> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('updater did not exit')), 10_000);
    proc.once('exit', code => { clearTimeout(timeout); resolve(code); });
  });
}

const children: ChildProcessWithoutNullStreams[] = [];
let root = '';
afterEach(() => {
  for (const proc of children.splice(0)) { proc.stdin.end(); if (proc.exitCode === null) proc.kill(); }
  vi.unstubAllEnvs();
  if (root) {
    for (const rel of fs.readdirSync(root, { recursive: true }).map(String)) {
      const file = path.join(root, rel);
      if (fs.lstatSync(file).isDirectory()) fs.chmodSync(file, 0o755);
    }
    fs.rmSync(root, { recursive: true, force: true }); root = '';
  }
});

it('two long-lived processes re-read activation and same-mtime changed digest; reject mixed manifest/source and observe rollback', async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'stable-propagation-'));
  const sourceRoot = path.join(root, 'teamskills');
  const releasesRoot = path.join(root, 'releases');
  const project = path.join(root, 'project');
  const payload = path.join(root, 'payload');
  fs.mkdirSync(path.join(sourceRoot, 'skills/alpha'), { recursive: true });
  fs.mkdirSync(path.join(sourceRoot, '.tower'), { recursive: true });
  fs.mkdirSync(path.join(project, '.tower/skills'), { recursive: true });
  fs.mkdirSync(path.join(payload, 'skills/alpha'), { recursive: true });
  fs.mkdirSync(releasesRoot);
  fs.writeFileSync(path.join(sourceRoot, 'skillset.json'), JSON.stringify({ defaultSkills: ['alpha'] }));
  fs.writeFileSync(path.join(sourceRoot, 'skills/alpha/SKILL.md'), '# local');
  fs.writeFileSync(path.join(project, '.tower/skills/manifest.json'), JSON.stringify({ schemaVersion: 3, managedBy: 'tower-project-skill-runtime-layer', skills: [] }));
  fs.writeFileSync(path.join(sourceRoot, '.tower/stable-skills-policy.json'), JSON.stringify({ schemaVersion: 1, enrollments: [{ name: 'alpha', localDigest: null }] }));
  // The enrolled local source must be absent. An un-enrolled local default is not required.
  fs.rmSync(path.join(sourceRoot, 'skills/alpha'), { recursive: true });
  fs.writeFileSync(path.join(payload, 'skillset.json'), JSON.stringify({ defaultSkills: ['alpha'] }));
  const payloadBody = path.join(payload, 'skills/alpha/SKILL.md');
  fs.writeFileSync(payloadBody, '# first');
  const fixedTime = new Date('2024-01-01T00:00:00.000Z');
  fs.utimesSync(payloadBody, fixedTime, fixedTime);
  vi.stubEnv('TEAMSKILLS_PROJECT_ROOT', sourceRoot);
  vi.stubEnv('TEAMSKILLS_STABLE_RELEASES_ROOT', releasesRoot);
  const env = { ...process.env, TEAMSKILLS_PROJECT_ROOT: sourceRoot, TEAMSKILLS_STABLE_RELEASES_ROOT: releasesRoot };
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
  const build = (tag: string) => {
    const archive = execFileSync('tar', ['-czf', '-', '--format=ustar', '-C', payload, 'skillset.json', 'skills']);
    const descriptor = Buffer.from(JSON.stringify({ schemaVersion: 1, repository: 'juliuschun/teamskills', tag, commit: 'b'.repeat(40), archiveSha256: crypto.createHash('sha256').update(archive).digest('hex'), minimumAppCapability: 1, requiredFeatures: ['bind-ro', 'gatewayApis', 'retainedEntries'] }));
    return { archive, descriptor, signature: crypto.sign(null, descriptor, privateKey), publicKey: publicKey.export({ format: 'pem', type: 'spki' }) };
  };
  const watchers = [child(watcherCode, [project], env), child(watcherCode, [project], env)];
  children.push(...watchers);
  const observe = watchers.map(observer);
  const both = async (step: string) => { const rows = []; for (const fn of observe) rows.push(await fn(step)); return rows; };
  const before = await both('before');
  expect(before.every(row => !row.error && !row.digest && row.enabled === false)).toBe(true);
  const first = build('v1.0.1');
  expect(updateStableSkills({ sourceRoot, releasesRoot, projectRoots: [project], input: first, mode: 'apply' }).status).toBe('applied');
  materializeProjectRegistrySkills({ projectRootPath: project, skillNames: ['alpha'], storageMode: 'bind-ro', prune: false });
  const activated = await both('activated');
  expect(activated.every(row => !row.error && row.body === '# first' && row.enabled && row.assetStatus === 'source-verified' && row.source?.startsWith(releasesRoot)), JSON.stringify(activated)).toBe(true);
  expect(activated[0].digest).toBe(activated[1].digest);
  const immutableSnapshot = activated[0].assetPath;
  fs.writeFileSync(payloadBody, '# later'); // same length and mtime, different digest
  fs.utimesSync(payloadBody, fixedTime, fixedTime);
  expect(fs.statSync(payloadBody).mtimeMs).toBe(fixedTime.getTime());
  const second = build('v1.0.2');
  for (const [key, value] of Object.entries(second)) fs.writeFileSync(path.join(root, key), value);
  const updater = child(updaterCode, [root, sourceRoot, releasesRoot, project], env);
  children.push(updater);
  await waitFor(path.join(root, 'switched'));
  const mixed = await both('mixed');
  expect(mixed.every(row => !row.error && row.body === '# later' && !row.enabled && row.skipped?.[0]?.reason === 'source_manifest_mismatch' && row.assetStatus === 'blocked' && row.digest !== activated[0].digest), JSON.stringify(mixed)).toBe(true);
  expect(fs.readFileSync(path.join(immutableSnapshot, 'SKILL.md'), 'utf8')).toBe('# first');
  fs.writeFileSync(path.join(root, 'continue'), 'yes');
  expect(await waitExit(updater)).not.toBe(0);
  const rolledBack = await both('rolled-back');
  expect(rolledBack.every(row => !row.error && row.body === '# first' && row.digest === activated[0].digest && row.enabled && row.assetStatus === 'source-verified' && row.assetPath === immutableSnapshot), JSON.stringify(rolledBack)).toBe(true);
  expect(fs.existsSync(path.join(releasesRoot, '.stable-update-journal.json'))).toBe(false);
  expect(updateStableSkills({ sourceRoot, releasesRoot, projectRoots: [project], input: second, mode: 'apply' }).status).toBe('applied');
  const refreshed = await both('refreshed');
  expect(refreshed.every(row => !row.error && row.body === '# later' && row.digest === mixed[0].digest && row.enabled && row.assetStatus === 'source-verified' && row.assetPath !== immutableSnapshot), JSON.stringify(refreshed)).toBe(true);
  expect(fs.readFileSync(path.join(immutableSnapshot, 'SKILL.md'), 'utf8')).toBe('# first');
// Multiple real TS child processes may exceed Vitest's 5s unit-test default.
// Keep the per-observation 10s bounds and a finite integration-test budget.
}, 60_000);

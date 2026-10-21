import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { gunzipSync, gzipSync } from 'node:zlib';
import { execFileSync, spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { updateStableSkills, recoverStableSkills } from './stable-release-updater.js';
import { materializeProjectRegistrySkills } from './project-skill-materializer.js';
import { resolveOperatorSkillAssets } from './operator-skill-assets.js';
import { buildRuntimeSkillBindMountPlan } from './runtime-skill-bind-mount.js';
import { seedProjectDefaultSkills } from '../pm/project-default-skills.js';
import { readTeamskillsSkillset } from './teamskills-source.js';

const cleanup: string[] = [];
afterEach(() => { vi.unstubAllEnvs(); for (const root of cleanup.splice(0)) {
  if (fs.existsSync(root)) {
    for (const rel of fs.readdirSync(root, { recursive: true }).map(String)) {
      const file = path.join(root, rel);
      if (fs.lstatSync(file).isDirectory()) fs.chmodSync(file, 0o755);
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
} });
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stable-skill-test-'));
  cleanup.push(root);
  const releasesRoot = path.join(root, 'releases');
  const sourceRoot = path.join(root, 'teamskills');
  const project = path.join(root, 'project');
  fs.mkdirSync(releasesRoot);
  fs.mkdirSync(project);
  fs.mkdirSync(path.join(project, '.tower', 'skills'), { recursive: true });
  fs.writeFileSync(path.join(project, '.tower', 'skills', 'manifest.json'), JSON.stringify({ schemaVersion: 3, managedBy: 'tower-project-skill-runtime-layer', skills: [] }));
  const prior = path.join(releasesRoot, `sha256-${'a'.repeat(64)}`);
  fs.mkdirSync(prior);
  fs.writeFileSync(path.join(prior, '.tower-stable-release'), JSON.stringify({ tag: 'v1.0.0' }));
  fs.mkdirSync(path.join(prior, 'skills', 'alpha'), { recursive: true });
  fs.writeFileSync(path.join(prior, 'skills', 'alpha', 'SKILL.md'), '---\nname: alpha\n---\n# Old');
  fs.writeFileSync(path.join(prior, 'skillset.json'), JSON.stringify({ defaultSkills: ['alpha'] }));
  fs.mkdirSync(path.join(sourceRoot, 'skills', 'alpha'), { recursive: true });
  fs.writeFileSync(path.join(sourceRoot, 'skills', 'alpha', 'SKILL.md'), '---\nname: alpha\n---\n# Old');
  fs.writeFileSync(path.join(sourceRoot, 'skillset.json'), JSON.stringify({ defaultSkills: ['alpha'] }));
  fs.mkdirSync(path.join(sourceRoot, '.tower'));
  const baseline = crypto.createHash('sha256').update(fs.readFileSync(path.join(sourceRoot, 'skills/alpha/SKILL.md'))).digest('hex');
  const localDigest = crypto.createHash('sha256').update(`SKILL.md\0${fs.statSync(path.join(sourceRoot, 'skills/alpha/SKILL.md')).size}\0${baseline}\n`).digest('hex');
  fs.writeFileSync(path.join(sourceRoot, '.tower/stable-skills-policy.json'), JSON.stringify({ schemaVersion: 1, enrollments: [{ name: 'alpha', localDigest: `sha256:${localDigest}` }] }));
  fs.writeFileSync(path.join(sourceRoot, 'local-marker'), 'preserved');
  vi.stubEnv('TEAMSKILLS_PROJECT_ROOT', sourceRoot);
  vi.stubEnv('TEAMSKILLS_STABLE_RELEASES_ROOT', releasesRoot);
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const payload = path.join(root, 'payload');
  fs.mkdirSync(path.join(payload, 'skills', 'alpha'), { recursive: true });
  fs.writeFileSync(path.join(payload, 'skillset.json'), JSON.stringify({ version: 1, defaultSkills: ['alpha'] }));
  fs.writeFileSync(path.join(payload, 'skills', 'alpha', 'SKILL.md'), '---\nname: alpha\n---\n# Alpha');
  const build = (tag = 'v1.0.1') => {
    const archive = execFileSync('tar', ['-czf', '-', '--format=ustar', '-C', payload, 'skillset.json', 'skills']);
    const descriptor = Buffer.from(JSON.stringify({ schemaVersion: 1, repository: 'juliuschun/teamskills', tag, commit: 'b'.repeat(40), archiveSha256: crypto.createHash('sha256').update(archive).digest('hex'), minimumAppCapability: 1, requiredFeatures: ['bind-ro', 'gatewayApis', 'retainedEntries'] }));
    return { descriptor, signature: crypto.sign(null, descriptor, privateKey), archive, publicKey: publicKey.export({ format: 'pem', type: 'spki' }) };
  };
  return { root, releasesRoot, sourceRoot, project, prior, payload, build };
}

describe('stable release updater', () => {
  it('keeps local source when configured but no release is active, and rejects malformed activation', () => {
    const f = fixture();
    const local = path.join(f.sourceRoot, 'skills/alpha');
    expect(buildRuntimeSkillBindMountPlan(f.project).enabled).toBe(false); // empty manifest
    expect(materializeProjectRegistrySkills({ projectRootPath: f.project, skillNames: ['alpha'], storageMode: 'bind-ro' }).materialized[0].name).toBe('alpha');
    expect(buildRuntimeSkillBindMountPlan(f.project).mounts[0].sourcePath).toBe(local);
    const active = path.join(f.releasesRoot, 'active.json');
    fs.writeFileSync(active, '{broken');
    expect(buildRuntimeSkillBindMountPlan(f.project).enabled).toBe(false);
    expect(resolveOperatorSkillAssets(f.project, 'alpha', fs.readFileSync(path.join(local, 'SKILL.md'), 'utf8')).status).toBe('blocked');
    expect(() => updateStableSkills({ ...f, projectRoots: [f.project], input: f.build(), mode: 'apply' })).toThrow();
  });
  it('checks signed stable archive without touching source and applies to managed source only', () => {
    const f = fixture();
    const input = f.build();
    expect(updateStableSkills({ ...f, projectRoots: [f.project], input, mode: 'check' }).status).toBe('eligible');
    expect(fs.existsSync(path.join(f.sourceRoot, 'local-marker'))).toBe(true);
    expect(updateStableSkills({ ...f, projectRoots: [f.project], input, mode: 'apply' }).status).toBe('applied');
    expect(fs.existsSync(path.join(f.sourceRoot, 'local-marker'))).toBe(true);
    expect(updateStableSkills({ ...f, projectRoots: [f.project], input, mode: 'apply' }).status).toBe('already-current');
  });
  it('preserves selected names and refreshes existing bind-ro declaration with current app materializer', () => {
    const f = fixture();
    const previous = materializeProjectRegistrySkills({ projectRootPath: f.project, skillNames: ['alpha'], storageMode: 'bind-ro' });
    const oldDigest = previous.materialized[0].bundleDigest;
    const result = updateStableSkills({ ...f, projectRoots: [f.project], input: f.build(), mode: 'apply' });
    expect(result.status).toBe('applied');
    const manifest = JSON.parse(fs.readFileSync(path.join(f.project, '.tower', 'skills', 'manifest.json'), 'utf8'));
    expect(manifest.skills.map((entry: { name: string }) => entry.name)).toEqual(['alpha']);
    expect(manifest.skills[0].bundleDigest).not.toBe(oldDigest);
    expect(manifest.skills[0]).toHaveProperty('gatewayApis');
  });
  it('new Project seeding, bind-ro mount and host snapshot resolve signed source without Gateway', () => {
    const f = fixture();
    fs.writeFileSync(path.join(f.payload, 'skills', 'alpha', 'skill.yaml'), 'name: alpha\nversion: 1.0.1\nrequiredSecrets: []\n');
    const input = f.build();
    updateStableSkills({ ...f, projectRoots: [f.project], input, mode: 'apply' });
    const fresh = path.join(f.root, 'fresh'); fs.mkdirSync(fresh);
    seedProjectDefaultSkills(fresh, readTeamskillsSkillset([]));
    const manifest = JSON.parse(fs.readFileSync(path.join(fresh, '.tower/skills/manifest.json'), 'utf8'));
    expect(manifest.skills.map((entry: { name: string }) => entry.name)).toEqual(['alpha']);
    expect(manifest.skills[0].gatewayApis).toEqual([]);
    const plan = buildRuntimeSkillBindMountPlan(fresh);
    expect(plan.enabled).toBe(true);
    expect(plan.mounts[0].sourcePath).toBe(path.join(f.releasesRoot, `sha256-${JSON.parse(input.descriptor.toString()).archiveSha256}`, 'skills', 'alpha'));
    const assets = resolveOperatorSkillAssets(fresh, 'alpha', fs.readFileSync(path.join(f.payload, 'skills/alpha/SKILL.md'), 'utf8'));
    expect(assets.status).toBe('source-verified');
    if (assets.status === 'source-verified') expect(fs.existsSync(path.join(assets.executionDirectory, 'skill.yaml'))).toBe(true);
  });
  it('reconciles already-current selected manifests using current source, rather than silently skipping', () => {
    const f = fixture(); materializeProjectRegistrySkills({ projectRootPath: f.project, skillNames: ['alpha'], storageMode: 'bind-ro' });
    const input = f.build(); updateStableSkills({ ...f, projectRoots: [f.project], input, mode: 'apply' });
    const manifestPath = path.join(f.project, '.tower/skills/manifest.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    manifest.skills[0].bundleDigest = 'sha256:' + '0'.repeat(64);
    fs.writeFileSync(manifestPath, JSON.stringify(manifest));
    // Control marker still records the previous digest, so fail closed on drift.
    expect(() => updateStableSkills({ ...f, projectRoots: [f.project], input, mode: 'apply' })).toThrow('managed marker changed');
    manifest.skills[0].bundleDigest = fs.readFileSync(path.join(f.project, '.tower/skills/alpha/.tower-managed-skill'), 'utf8').match(/bundle-digest=(sha256:[a-f0-9]+)/)![1];
    fs.writeFileSync(manifestPath, JSON.stringify(manifest));
    const before = fs.readFileSync(manifestPath, 'utf8');
    expect(updateStableSkills({ ...f, projectRoots: [f.project], input, mode: 'apply' }).status).toBe('already-current');
    expect(fs.readFileSync(manifestPath, 'utf8')).not.toBe(before);
  });
  it('does not treat an arbitrary symlink or forged marker as an approved source', () => {
    const f = fixture();
    materializeProjectRegistrySkills({ projectRootPath: f.project, skillNames: ['alpha'], storageMode: 'bind-ro' });
    updateStableSkills({ ...f, projectRoots: [f.project], input: f.build(), mode: 'apply' });
    const active = path.join(f.releasesRoot, 'active.json');
    const rogue = path.join(f.root, 'rogue');
    fs.mkdirSync(rogue);
    fs.renameSync(active, path.join(rogue, 'active.json'));
    fs.symlinkSync(path.join(rogue, 'active.json'), active);
    expect(buildRuntimeSkillBindMountPlan(f.project).enabled).toBe(false);
    expect(resolveOperatorSkillAssets(f.project, 'alpha', fs.readFileSync(path.join(f.sourceRoot, 'skills/alpha/SKILL.md'), 'utf8')).status).toBe('blocked');
    fs.unlinkSync(active);
    fs.renameSync(path.join(rogue, 'active.json'), active);
    vi.stubEnv('TEAMSKILLS_STABLE_RELEASES_ROOT', path.join(f.root, 'wrong'));
    expect(buildRuntimeSkillBindMountPlan(f.project).enabled).toBe(false);
  });
  it('preserves a local fork and rejects activation after an enrolled local edit', () => {
    const f = fixture();
    materializeProjectRegistrySkills({ projectRootPath: f.project, skillNames: ['alpha'], storageMode: 'bind-ro' });
    const input = f.build();
    updateStableSkills({ ...f, projectRoots: [f.project], input, mode: 'apply' });
    const local = path.join(f.sourceRoot, 'skills/alpha/SKILL.md');
    fs.writeFileSync(local, '# forked');
    expect(resolveOperatorSkillAssets(f.project, 'alpha', '# forked').status).toBe('blocked'); // old manifest is not silently rebound
    expect(buildRuntimeSkillBindMountPlan(f.project)).toMatchObject({ enabled: false, mounts: [], skipped: [{ name: 'alpha', reason: 'source_manifest_mismatch' }] }); // local fork wins selection, but cannot mount against the old declaration
    expect(() => updateStableSkills({ ...f, projectRoots: [f.project], input, mode: 'apply' })).toThrow('local skill changed');
    expect(fs.readFileSync(local, 'utf8')).toBe('# forked');
  });
  it('keeps un-enrolled local skill selected during an enrolled release refresh', () => {
    const f = fixture();
    const local = path.join(f.sourceRoot, 'skills/beta'); fs.mkdirSync(local);
    fs.writeFileSync(path.join(local, 'SKILL.md'), '# local beta');
    materializeProjectRegistrySkills({ projectRootPath: f.project, skillNames: ['alpha', 'beta'], storageMode: 'bind-ro' });
    const before = JSON.parse(fs.readFileSync(path.join(f.project, '.tower/skills/manifest.json'), 'utf8')).skills.find((s: { name: string }) => s.name === 'beta').bundleDigest;
    updateStableSkills({ ...f, projectRoots: [f.project], input: f.build(), mode: 'apply' });
    const after = JSON.parse(fs.readFileSync(path.join(f.project, '.tower/skills/manifest.json'), 'utf8')).skills;
    expect(after.map((entry: { name: string }) => entry.name)).toEqual(['alpha', 'beta']);
    expect(after.find((entry: { name: string }) => entry.name === 'beta').bundleDigest).toBe(before);
    expect(fs.readFileSync(path.join(local, 'SKILL.md'), 'utf8')).toBe('# local beta');
  });
  it('requires explicit enrollment and never adopts a missing policy', () => {
    const f = fixture();
    fs.unlinkSync(path.join(f.sourceRoot, '.tower/stable-skills-policy.json'));
    expect(() => updateStableSkills({ ...f, projectRoots: [f.project], input: f.build(), mode: 'apply' })).toThrow();
  });
  it('rejects a release missing an existing selected skill before switching', () => {
    const f = fixture();
    materializeProjectRegistrySkills({ projectRootPath: f.project, skillNames: ['alpha'], storageMode: 'bind-ro' });
    fs.rmSync(path.join(f.payload, 'skills', 'alpha'), { recursive: true });
    fs.mkdirSync(path.join(f.payload, 'skills', 'beta'));
    fs.writeFileSync(path.join(f.payload, 'skills', 'beta', 'SKILL.md'), '# Beta');
    fs.writeFileSync(path.join(f.payload, 'skillset.json'), JSON.stringify({ defaultSkills: ['beta'] }));
    expect(() => updateStableSkills({ ...f, projectRoots: [f.project], input: f.build(), mode: 'apply' })).toThrow('removes an enrolled skill');
    expect(fs.existsSync(path.join(f.sourceRoot, 'local-marker'))).toBe(true);
  });
  it('rejects unsigned mutation, pre-release and tar symlink before activation', () => {
    const f = fixture();
    const input = f.build();
    expect(() => updateStableSkills({ ...f, projectRoots: [], input: { ...input, signature: Buffer.alloc(64) }, mode: 'check' })).toThrow('signature');
    expect(() => updateStableSkills({ ...f, projectRoots: [], input: f.build('v1.1.0-rc1'), mode: 'check' })).toThrow('not stable');
    fs.symlinkSync('/etc/passwd', path.join(f.payload, 'skills', 'alpha', 'link'));
    expect(() => updateStableSkills({ ...f, projectRoots: [], input: f.build(), mode: 'check' })).toThrow('unsupported tar entry');
    expect(fs.existsSync(path.join(f.sourceRoot, 'local-marker'))).toBe(true);
  });
  it('rejects traversal paths even in a correctly signed tar archive', () => {
    const f = fixture();
    const input = f.build();
    // Rebuild a valid gzip with a modified ustar name and checksum, then re-sign.
    const tar = gunzipSync(input.archive);
    const header = tar.subarray(0, 512);
    header.fill(0, 0, 100);
    header.write('../oops', 0, 'ascii');
    header.fill(32, 148, 156);
    const sum = header.reduce((total, byte) => total + byte, 0);
    header.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 'ascii');
    const archive = gzipSync(tar);
    // Invalid signature fails even before traversal; test the parser by preserving
    // a newly generated signing key for this adversarial yet signed descriptor.
    const keys = crypto.generateKeyPairSync('ed25519');
    const descriptor = Buffer.from(JSON.stringify({ ...JSON.parse(input.descriptor.toString()), archiveSha256: crypto.createHash('sha256').update(archive).digest('hex') }));
    const malicious = { descriptor, signature: crypto.sign(null, descriptor, keys.privateKey), archive, publicKey: keys.publicKey.export({ type: 'spki', format: 'pem' }) };
    expect(() => updateStableSkills({ ...f, projectRoots: [f.project], input: malicious, mode: 'check' })).toThrow('unsafe or duplicate archive path');
    expect(fs.existsSync(path.join(f.sourceRoot, 'local-marker'))).toBe(true);
  });
  it('rolls back a failed post-switch materialization and permits retry', () => {
    const f = fixture(); materializeProjectRegistrySkills({ projectRootPath: f.project, skillNames: ['alpha'], storageMode: 'bind-ro' });
    const input = f.build();
    const manifestPath = path.join(f.project, '.tower/skills/manifest.json');
    const before = fs.readFileSync(manifestPath, 'utf8');
    const original = fs.writeFileSync; let triggered = false;
    const spy = vi.spyOn(fs, 'writeFileSync').mockImplementation(((file: fs.PathOrFileDescriptor, ...args: unknown[]) => {
      if (!triggered && file === manifestPath) { triggered = true; throw new Error('injected manifest failure'); }
      return (original as (...values: unknown[]) => void)(file, ...args);
    }) as typeof fs.writeFileSync);
    try { expect(() => updateStableSkills({ ...f, projectRoots: [f.project], input, mode: 'apply' })).toThrow('injected manifest failure'); }
    finally { spy.mockRestore(); }
    expect(fs.existsSync(path.join(f.sourceRoot, 'local-marker'))).toBe(true);
    expect(fs.readFileSync(manifestPath, 'utf8')).toBe(before);
    expect(fs.existsSync(path.join(f.releasesRoot, 'sha256-' + JSON.parse(input.descriptor.toString()).archiveSha256))).toBe(false);
    expect(updateStableSkills({ ...f, projectRoots: [f.project], input, mode: 'apply' }).status).toBe('applied');
  });
  it('retains verified backups and journal if synchronous rollback fails, then requires explicit recovery', () => {
    const f = fixture();
    materializeProjectRegistrySkills({ projectRootPath: f.project, skillNames: ['alpha'], storageMode: 'bind-ro' });
    const before = fs.readFileSync(path.join(f.project, '.tower/skills/manifest.json'));
    const input = f.build();
    const write = fs.writeFileSync;
    const copy = fs.cpSync;
    let failManifest = true;
    const writeSpy = vi.spyOn(fs, 'writeFileSync').mockImplementation(((file: fs.PathOrFileDescriptor, ...args: unknown[]) => {
      if (failManifest && file === path.join(f.project, '.tower/skills/manifest.json')) {
        failManifest = false;
        throw new Error('injected materializer failure');
      }
      return (write as (...values: unknown[]) => void)(file, ...args);
    }) as typeof fs.writeFileSync);
    const copySpy = vi.spyOn(fs, 'cpSync').mockImplementation(((source: fs.PathLike, ...args: unknown[]) => {
      if (String(source).includes('/.project-backup-')) throw new Error('injected rollback failure');
      return (copy as (...values: unknown[]) => void)(source, ...args);
    }) as typeof fs.cpSync);
    try { expect(() => updateStableSkills({ ...f, projectRoots: [f.project], input, mode: 'apply' })).toThrow('manual recovery required'); }
    finally { copySpy.mockRestore(); writeSpy.mockRestore(); }
    const journal = path.join(f.releasesRoot, '.stable-update-journal.json');
    expect(fs.existsSync(journal)).toBe(true);
    const record = JSON.parse(fs.readFileSync(journal, 'utf8'));
    expect(record.projects).toHaveLength(1);
    expect(fs.existsSync(record.projects[0].backup)).toBe(true);
    recoverStableSkills(f.sourceRoot, f.releasesRoot);
    expect(fs.readFileSync(path.join(f.project, '.tower/skills/manifest.json')).equals(before)).toBe(true);
  });
  it('rejects altered recovery backups without deleting evidence', () => {
    const f = fixture();
    materializeProjectRegistrySkills({ projectRootPath: f.project, skillNames: ['alpha'], storageMode: 'bind-ro' });
    const input = f.build();
    const write = fs.writeFileSync;
    const copy = fs.cpSync;
    const writeSpy = vi.spyOn(fs, 'writeFileSync').mockImplementation(((file: fs.PathOrFileDescriptor, ...args: unknown[]) => {
      if (file === path.join(f.project, '.tower/skills/manifest.json')) throw new Error('injected materializer failure');
      return (write as (...values: unknown[]) => void)(file, ...args);
    }) as typeof fs.writeFileSync);
    const copySpy = vi.spyOn(fs, 'cpSync').mockImplementation(((source: fs.PathLike, ...args: unknown[]) => {
      if (String(source).includes('/.project-backup-')) throw new Error('injected rollback failure');
      return (copy as (...values: unknown[]) => void)(source, ...args);
    }) as typeof fs.cpSync);
    try { expect(() => updateStableSkills({ ...f, projectRoots: [f.project], input, mode: 'apply' })).toThrow('manual recovery required'); }
    finally { copySpy.mockRestore(); writeSpy.mockRestore(); }
    const journal = path.join(f.releasesRoot, '.stable-update-journal.json');
    const backup = JSON.parse(fs.readFileSync(journal, 'utf8')).projects[0].backup;
    fs.writeFileSync(path.join(backup, 'manifest.json'), '{tampered}');
    expect(() => recoverStableSkills(f.sourceRoot, f.releasesRoot)).toThrow('recovery backup changed');
    expect(fs.existsSync(journal)).toBe(true);
    expect(fs.existsSync(backup)).toBe(true);
  });
  it.each(['before-activation', 'after-activation', 'during-manifest'])('recovers a killed child %s without silently stealing its lock', (phase) => {
    const f = fixture();
    materializeProjectRegistrySkills({ projectRootPath: f.project, skillNames: ['alpha'], storageMode: 'bind-ro' });
    const originalManifest = fs.readFileSync(path.join(f.project, '.tower/skills/manifest.json'));
    const input = f.build();
    for (const [name, bytes] of Object.entries(input)) {
      if (name === 'publicKey') continue;
      fs.writeFileSync(path.join(f.root, name), bytes as Buffer);
    }
    fs.writeFileSync(path.join(f.root, 'publicKey'), input.publicKey);
    const script = `
      import fs from 'node:fs';
      import path from 'node:path';
      import { updateStableSkills } from './packages/backend/services/skill/stable-release-updater.ts';
      const [root, sourceRoot, releasesRoot, project, phase] = process.argv.slice(1);
      const rename = fs.renameSync;
      fs.renameSync = function(from, to) {
        if (phase === 'before-activation' && String(from).includes('/.stage-') && String(to).includes('/sha256-')) process.kill(process.pid, 'SIGKILL');
        const result = rename.apply(this, arguments);
        if (phase === 'after-activation' && String(to).endsWith('/active.json')) process.kill(process.pid, 'SIGKILL');
        return result;
      };
      const write = fs.writeFileSync;
      fs.writeFileSync = function(file) {
        if (phase === 'during-manifest' && file === path.join(project, '.tower/skills/manifest.json')) {
          write.call(this, file, '{partial'); process.kill(process.pid, 'SIGKILL');
        }
        return write.apply(this, arguments);
      };
      updateStableSkills({ sourceRoot, releasesRoot, projectRoots: [project], mode: 'apply', input: {
        descriptor: fs.readFileSync(path.join(root, 'descriptor')),
        signature: fs.readFileSync(path.join(root, 'signature')),
        archive: fs.readFileSync(path.join(root, 'archive')),
        publicKey: fs.readFileSync(path.join(root, 'publicKey')),
      }});
    `;
    const child = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script, f.root, f.sourceRoot, f.releasesRoot, f.project, phase], {
      cwd: path.resolve(import.meta.dirname, '../../../..'),
      env: { ...process.env, TEAMSKILLS_PROJECT_ROOT: f.sourceRoot, TEAMSKILLS_STABLE_RELEASES_ROOT: f.releasesRoot },
      timeout: 20_000, encoding: 'utf8',
    });
    expect(child.error).toBeUndefined();
    expect(child.signal, child.stderr).toBe('SIGKILL');
    const journal = path.join(f.releasesRoot, '.stable-update-journal.json');
    const lock = path.join(f.releasesRoot, '.stable-update.lock');
    expect(fs.existsSync(journal)).toBe(true);
    expect(fs.existsSync(lock)).toBe(true);
    expect(() => updateStableSkills({ ...f, projectRoots: [f.project], input, mode: 'apply' })).toThrow('recovery required');
    expect(() => recoverStableSkills(f.sourceRoot, f.releasesRoot)).toThrow(); // no PID-based lock theft
    fs.unlinkSync(lock); // child has exited; operator has verified no active runner
    recoverStableSkills(f.sourceRoot, f.releasesRoot);
    expect(fs.existsSync(journal)).toBe(false);
    expect(fs.readFileSync(path.join(f.project, '.tower/skills/manifest.json')).equals(originalManifest)).toBe(true);
    expect(fs.existsSync(path.join(f.releasesRoot, 'active.json'))).toBe(false);
    expect(updateStableSkills({ ...f, projectRoots: [f.project], input, mode: 'apply' }).status).toBe('applied');
  });
  it.each(['project', 'tower', 'skills', 'manifest'])('rejects symlinked %s path before mutation', (location) => {
    const f = fixture();
    const manifest = path.join(f.project, '.tower/skills/manifest.json');
    const target = path.join(f.root, 'outside');
    if (location === 'project') { fs.renameSync(f.project, target); fs.symlinkSync(target, f.project); }
    if (location === 'tower') { fs.renameSync(path.join(f.project, '.tower'), target); fs.symlinkSync(target, path.join(f.project, '.tower')); }
    if (location === 'skills') { fs.renameSync(path.dirname(manifest), target); fs.symlinkSync(target, path.dirname(manifest)); }
    if (location === 'manifest') { fs.renameSync(manifest, target); fs.symlinkSync(target, manifest); }
    expect(() => updateStableSkills({ ...f, projectRoots: [f.project], input: f.build(), mode: 'apply' })).toThrow('symlinked');
    expect(fs.existsSync(path.join(f.sourceRoot, 'local-marker'))).toBe(true);
  });
  it('rejects an existing mutable source and concurrent lock', () => {
    const f = fixture();
    const input = f.build();
    fs.writeFileSync(path.join(f.releasesRoot, '.stable-update.lock'), 'busy');
    expect(() => updateStableSkills({ ...f, projectRoots: [f.project], input, mode: 'apply' })).toThrow();
    fs.unlinkSync(path.join(f.releasesRoot, '.stable-update.lock'));
    fs.unlinkSync(path.join(f.sourceRoot, '.tower/stable-skills-policy.json'));
    expect(() => updateStableSkills({ ...f, projectRoots: [f.project], input, mode: 'apply' })).toThrow();
  });
});

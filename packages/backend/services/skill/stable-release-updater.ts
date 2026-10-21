/**
 * Stable-only organization skill source overlay. The registered teamskills Project
 * remains untouched; enrolled skill names resolve from signed release directories.
 * The CLI caller must run from the deployed app closure, never a checkout.
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { materializeProjectRegistrySkills } from './project-skill-materializer.js';
import { scanSkillBundleForReadOnlyMount } from './skill-materialization-scanner.js';
import { isSafeSkillName } from './teamskills-source.js';
import { stableOverlayPaths, readStableOverlayPolicy, readStableOverlayActivation, validatedLocalDigest } from './managed-teamskills-source.js';

export const STABLE_SKILL_UPDATER_CAPABILITY = 1;
const MAX_ARCHIVE = 32 * 1024 * 1024;
const MAX_UNPACKED = 128 * 1024 * 1024;
const MAX_FILES = 2500;
const REQUIRED_FEATURES = ['bind-ro', 'gatewayApis', 'retainedEntries'];

export interface StableReleaseDescriptor {
  schemaVersion: 1;
  repository: 'juliuschun/teamskills';
  tag: string;
  commit: string;
  archiveSha256: string;
  minimumAppCapability: number;
  requiredFeatures: string[];
}
export interface StableReleaseInput {
  descriptor: Buffer;
  signature: Buffer;
  archive: Buffer;
  publicKey: string | Buffer;
}
export interface StableUpdaterOptions {
  sourceRoot: string;
  releasesRoot: string;
  projectRoots: string[];
  input: StableReleaseInput;
  mode: 'check' | 'apply';
}
export interface StableUpdateReceipt {
  status: 'eligible' | 'applied' | 'already-current';
  tag: string;
  archiveSha256: string;
  projects: number;
}

function requireDescriptor(input: StableReleaseInput): StableReleaseDescriptor {
  if (!crypto.verify(null, input.descriptor, input.publicKey, input.signature)) throw new Error('release signature invalid');
  const d = JSON.parse(input.descriptor.toString('utf8')) as StableReleaseDescriptor;
  if (d.schemaVersion !== 1 || d.repository !== 'juliuschun/teamskills'
    || !/^v\d+\.\d+\.\d+$/.test(d.tag) || !/^[a-f0-9]{40}$/.test(d.commit)
    || !/^[a-f0-9]{64}$/.test(d.archiveSha256)
    || !Number.isSafeInteger(d.minimumAppCapability) || d.minimumAppCapability < 1
    || d.minimumAppCapability > STABLE_SKILL_UPDATER_CAPABILITY
    || !Array.isArray(d.requiredFeatures) || d.requiredFeatures.length !== REQUIRED_FEATURES.length
    || REQUIRED_FEATURES.some(f => !d.requiredFeatures.includes(f))) throw new Error('release metadata incompatible or not stable');
  if (input.archive.length > MAX_ARCHIVE || crypto.createHash('sha256').update(input.archive).digest('hex') !== d.archiveSha256) throw new Error('archive size or digest mismatch');
  return d;
}

type ArchiveFile = { name: string; data: Buffer; mode: number };
function tarEntries(archive: Buffer): ArchiveFile[] {
  const tar = gunzipSync(archive, { maxOutputLength: MAX_UNPACKED });
  const files: ArchiveFile[] = [];
  const seen = new Set<string>();
  const allPaths = new Set<string>();
  let offset = 0;
  let ended = false;
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every(byte => byte === 0)) {
      if (!tar.subarray(offset).every(byte => byte === 0)) throw new Error('trailing tar payload');
      ended = true; break;
    }
    if (seen.size >= MAX_FILES) throw new Error('too many archive entries');
    const checksum = parseInt(header.subarray(148, 156).toString('ascii').replace(/\0/g, '').trim(), 8);
    let actual = 0;
    for (let i = 0; i < 512; i++) actual += i >= 148 && i < 156 ? 32 : header[i];
    if (!Number.isSafeInteger(checksum) || checksum !== actual) throw new Error('tar checksum mismatch');
    const field = (start: number, end: number) => header.subarray(start, end).toString('utf8').split('\0')[0];
    const name = field(0, 100);
    const sizeField = field(124, 136).trim();
    const modeField = field(100, 108).trim();
    if (!/^[0-7]+$/.test(modeField) || !/^[0-7]+$/.test(sizeField)) throw new Error('invalid tar mode or size');
    const mode = parseInt(modeField, 8);
    const size = parseInt(sizeField, 8);
    const type = field(156, 157);
    if (field(345, 500) || !['0', '', '5'].includes(type) || !Number.isSafeInteger(size)
      || (type === '5' && size !== 0)) throw new Error('unsupported tar entry');
    const normalized = name.endsWith('/') && type === '5' ? name.slice(0, -1) : name;
    const parts = normalized.split('/');
    if (!normalized || normalized.startsWith('/') || normalized.includes('\\') || parts.some(p => !p || p === '.' || p === '..')
      || !/^[\x20-\x7e]+$/.test(normalized) || seen.has(normalized)) throw new Error('unsafe or duplicate archive path');
    seen.add(normalized);
    if (type !== '5') allPaths.add(normalized);
    const next = offset + 512 + Math.ceil(size / 512) * 512;
    if (next > tar.length) throw new Error('truncated archive');
    if (type !== '5') files.push({ name: normalized, data: tar.subarray(offset + 512, offset + 512 + size), mode: mode & 0o111 ? 0o555 : 0o444 });
    offset = next;
  }
  if (!ended || files.length === 0) throw new Error('invalid or empty archive');
  for (const name of seen) {
    const parts = name.split('/');
    for (let i = 1; i < parts.length; i++) if (allPaths.has(parts.slice(0, i).join('/'))) throw new Error('archive file/directory collision');
  }
  return files;
}
function validatePayload(files: ArchiveFile[]): string[] {
  const names = new Set<string>();
  const skillset = files.find(f => f.name === 'skillset.json');
  if (!skillset) throw new Error('skillset.json required');
  const parsed = JSON.parse(skillset.data.toString('utf8')) as { defaultSkills?: unknown };
  const defaults = parsed.defaultSkills;
  if (!Array.isArray(defaults) || defaults.length === 0 || defaults.some(n => typeof n !== 'string' || !isSafeSkillName(n))) throw new Error('invalid defaults');
  for (const file of files) {
    if (file.name === 'skillset.json') continue;
    const segments = file.name.split('/');
    if (segments[0] !== 'skills' || segments.length < 3 || !isSafeSkillName(segments[1])) throw new Error('unexpected archive entry');
    names.add(segments[1]);
  }
  if (new Set(defaults).size !== defaults.length || defaults.some(name => !names.has(name))) throw new Error('missing or duplicate default skill');
  for (const name of names) if (!files.some(f => f.name === `skills/${name}/SKILL.md`)) throw new Error('missing SKILL.md');
  return [...names].sort();
}
function overlayContext(opts: StableUpdaterOptions) {
  const paths = stableOverlayPaths();
  if (!paths || paths.root !== path.resolve(opts.sourceRoot) || paths.releases !== path.resolve(opts.releasesRoot)) throw new Error('overlay paths not configured');
  const policy = readStableOverlayPolicy(paths);
  for (const enrollment of policy.enrollments) {
    if (validatedLocalDigest(paths.root, enrollment.name) !== enrollment.localDigest) throw new Error('local skill changed since enrollment');
  }
  return { paths, policy, current: readStableOverlayActivation(paths) };
}
function assertSafeProjectPath(projectRoot: string): void {
  const root = path.resolve(projectRoot);
  if (fs.realpathSync(root) !== root || !fs.lstatSync(root).isDirectory()) throw new Error('symlinked project root');
  for (const sub of ['.tower', '.tower/skills', '.tower/skills/manifest.json']) {
    const current = path.join(root, sub);
    if (fs.realpathSync(current) !== current || fs.lstatSync(current).isSymbolicLink()) throw new Error('symlinked manifest path');
  }
}
function readExistingNames(projectRoot: string): string[] {
  assertSafeProjectPath(projectRoot);
  const manifest: unknown = JSON.parse(fs.readFileSync(path.join(projectRoot, '.tower', 'skills', 'manifest.json'), 'utf8'));
  if (!manifest || typeof manifest !== 'object' || !('skills' in manifest) || !Array.isArray(manifest.skills)
    || (manifest as { schemaVersion?: unknown }).schemaVersion !== 3
    || (manifest as { managedBy?: unknown }).managedBy !== 'tower-project-skill-runtime-layer') throw new Error('invalid project manifest');
  const names: string[] = [];
  for (const entry of manifest.skills) {
    if (!entry || !Array.isArray(entry.files) || typeof entry.name !== 'string' || !isSafeSkillName(entry.name) || entry.sourceKind !== 'teamskills'
      || entry.catalog !== 'teamskills' || entry.storageMode !== 'bind-ro') throw new Error('unsupported or local project manifest entry');
    const dir = path.join(projectRoot, '.tower', 'skills', entry.name);
    if (fs.realpathSync(dir) !== dir || !fs.lstatSync(dir).isDirectory() || !fs.existsSync(path.join(dir, '.tower-managed-skill'))) throw new Error('local managed skill modification or missing marker');
    const actual = fs.readdirSync(dir, { recursive: true }).map(String).filter(rel => {
      const stat = fs.lstatSync(path.join(dir, rel));
      if (stat.isSymbolicLink()) throw new Error('local managed skill symlink');
      return stat.isFile();
    }).sort();
    const expected = ['.tower-managed-skill', ...entry.files.filter((f: { relativePath: string }) => f.relativePath === 'SKILL.md' || f.relativePath === 'skill.yaml').map((f: { relativePath: string }) => f.relativePath)].sort();
    if (JSON.stringify(actual) !== JSON.stringify(expected) || !entry.files.every((f: { relativePath: string; sha256: string }) => {
      if (f.relativePath !== 'SKILL.md' && f.relativePath !== 'skill.yaml') return true;
      return crypto.createHash('sha256').update(fs.readFileSync(path.join(dir, f.relativePath))).digest('hex') === f.sha256;
    })) throw new Error('local managed skill modification');
    const marker = fs.readFileSync(path.join(dir, '.tower-managed-skill'), 'utf8');
    if (!marker.includes(`bundle-digest=${entry.bundleDigest}\n`)) throw new Error('managed marker changed');
    names.push(entry.name);
  }
  if (new Set(names).size !== names.length) throw new Error('duplicate manifest name');
  return names;
}
function syncDirectory(dir: string): void {
  const fd = fs.openSync(dir, 'r');
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}
function durableFile(file: string, bytes: string | Buffer): void {
  const fd = fs.openSync(file, 'wx', 0o600);
  try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  syncDirectory(path.dirname(file));
}
function replaceDurably(file: string, bytes: string | null): void {
  const temp = `${file}.next-${crypto.randomUUID()}`;
  try {
    if (bytes !== null) { durableFile(temp, bytes); fs.renameSync(temp, file); }
    else if (fs.existsSync(file)) fs.unlinkSync(file);
    syncDirectory(path.dirname(file));
  } finally { if (fs.existsSync(temp)) fs.unlinkSync(temp); }
}
function writeActivation(file: string, value: { tag: string; archiveSha256: string; commit: string } | null): void {
  replaceDurably(file, value ? JSON.stringify(value) : null);
}
type Activation = { tag: string; commit: string; archiveSha256: string };
type RecoveryRecord = {
  schemaVersion: 1;
  previous: Activation | null;
  next: Activation;
  candidateCreated: boolean;
  destination: string;
  staging: string | null;
  projects: Array<{ root: string; backup: string; names: string[]; digest: string; device: number; inode: number }>;
};
const JOURNAL = '.stable-update-journal.json';
const sha256 = (bytes: Buffer) => crypto.createHash('sha256').update(bytes).digest('hex');
function readRecoveryRecord(releases: string): RecoveryRecord {
  const file = path.join(releases, JOURNAL);
  if (fs.realpathSync(file) !== file || !fs.lstatSync(file).isFile()) throw new Error('unsafe recovery journal');
  const record = JSON.parse(fs.readFileSync(file, 'utf8')) as RecoveryRecord;
  if (record.schemaVersion !== 1 || !record.next || !/^v\d+\.\d+\.\d+$/.test(record.next.tag)
    || !/^[a-f0-9]{40}$/.test(record.next.commit) || !/^[a-f0-9]{64}$/.test(record.next.archiveSha256)
    || record.previous !== null && (!record.previous || !/^v\d+\.\d+\.\d+$/.test(record.previous.tag)
      || !/^[a-f0-9]{40}$/.test(record.previous.commit) || !/^[a-f0-9]{64}$/.test(record.previous.archiveSha256))
    || typeof record.candidateCreated !== 'boolean' || record.destination !== path.join(releases, `sha256-${record.next.archiveSha256}`)
    || !(record.staging === null || typeof record.staging === 'string' && record.staging.startsWith(releases + '/.stage-') && path.dirname(record.staging) === releases)
    || record.candidateCreated !== (record.staging !== null)
    || !Array.isArray(record.projects) || !record.projects.every(p => p && path.isAbsolute(p.root) && p.root.endsWith('/.tower/skills')
      && p.backup.startsWith(releases + '/.project-backup-') && path.dirname(p.backup) === releases
      && /^[a-f0-9]{64}$/.test(p.digest) && Number.isSafeInteger(p.device) && Number.isSafeInteger(p.inode)
      && Array.isArray(p.names) && p.names.length > 0
      && p.names.every(n => isSafeSkillName(n)) && new Set(p.names).size === p.names.length)) throw new Error('invalid recovery journal');
  return record;
}
function syncTree(root: string): void {
  for (const rel of fs.readdirSync(root, { recursive: true }).map(String)) {
    const target = path.join(root, rel);
    if (fs.lstatSync(target).isFile()) {
      const fd = fs.openSync(target, 'r');
      try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    }
  }
  for (const rel of fs.readdirSync(root, { recursive: true }).map(String).filter(rel => fs.lstatSync(path.join(root, rel)).isDirectory()).sort((a, b) => b.length - a.length)) syncDirectory(path.join(root, rel));
  syncDirectory(root);
}
function backupDigest(backup: string, names: string[]): string {
  if (fs.realpathSync(backup) !== backup || !fs.lstatSync(backup).isDirectory()) throw new Error('unsafe recovery backup');
  const expected = new Set(['manifest.json', ...names.flatMap(n => [n, `${n}/.tower-managed-skill`, `${n}/SKILL.md`, `${n}/skill.yaml`])]);
  const actual = fs.readdirSync(backup, { recursive: true }).map(String);
  if (actual.some(rel => !expected.has(rel) || fs.lstatSync(path.join(backup, rel)).isSymbolicLink())) throw new Error('unsafe recovery backup inventory');
  const hash = crypto.createHash('sha256');
  for (const rel of actual.filter(rel => fs.lstatSync(path.join(backup, rel)).isFile()).sort()) {
    const bytes = fs.readFileSync(path.join(backup, rel));
    hash.update(`${rel}\0${bytes.length}\0${sha256(bytes)}\n`);
  }
  for (const name of names) if (!actual.includes(`${name}/.tower-managed-skill`)) throw new Error('missing recovery backup');
  if (!actual.includes('manifest.json')) throw new Error('missing recovery manifest');
  return hash.digest('hex');
}
function restoreRecord(paths: NonNullable<ReturnType<typeof stableOverlayPaths>>, record: RecoveryRecord): void {
  // Verify *all* backups and destinations before touching any Project. This is
  // not a force-repair path for locally edited or moved Projects.
  for (const p of record.projects) {
    assertSafeProjectPath(path.dirname(path.dirname(p.root)));
    const targetStat = fs.lstatSync(p.root);
    if (targetStat.dev !== p.device || targetStat.ino !== p.inode) throw new Error('recovery Project target replaced');
    if (backupDigest(p.backup, p.names) !== p.digest) throw new Error('recovery backup changed');
    const entries = fs.readdirSync(p.backup).sort();
    if (JSON.stringify(entries) !== JSON.stringify(['manifest.json', ...p.names].sort())) throw new Error('recovery backup changed');
    for (const name of p.names) {
      const target = path.join(p.root, name);
      if (fs.existsSync(target) && (fs.realpathSync(target) !== target || !fs.lstatSync(target).isDirectory())) throw new Error('unsafe recovery target');
    }
  }
  const active = readStableOverlayActivation(paths);
  const matches = (a: Activation | null, b: Activation | null) => JSON.stringify(a && { tag: a.tag, commit: a.commit, archiveSha256: a.archiveSha256 }) === JSON.stringify(b);
  if (!matches(active, record.previous) && !matches(active, record.next)) throw new Error('activation changed since interrupted update');
  if (fs.existsSync(record.destination) && record.candidateCreated) {
    if (fs.realpathSync(record.destination) !== record.destination || !fs.lstatSync(record.destination).isDirectory()) throw new Error('unsafe recovery release');
    const marker = path.join(record.destination, '.tower-stable-release');
    if (fs.realpathSync(marker) !== marker || !fs.lstatSync(marker).isFile()
      || !matches(JSON.parse(fs.readFileSync(marker, 'utf8')) as Activation, record.next)) throw new Error('recovery candidate changed');
  }
  for (const p of record.projects) {
    for (const name of p.names) {
      const target = path.join(p.root, name);
      if (fs.existsSync(target)) fs.rmSync(target, { recursive: true });
      fs.cpSync(path.join(p.backup, name), target, { recursive: true, dereference: false });
    }
    fs.copyFileSync(path.join(p.backup, 'manifest.json'), path.join(p.root, 'manifest.json'));
    for (const name of p.names) {
      const fd = fs.openSync(path.join(p.root, name, '.tower-managed-skill'), 'r');
      try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      syncDirectory(path.join(p.root, name));
    }
    const fd = fs.openSync(path.join(p.root, 'manifest.json'), 'r');
    try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    syncDirectory(p.root);
  }
  writeActivation(paths.active, record.previous);
  // Backups and journal survive any failed rollback. Cleanup only after all
  // targets and activation have been restored and durably synced.
  if (record.candidateCreated && fs.existsSync(record.destination)) removeStagingTree(record.destination);
  if (record.staging && fs.existsSync(record.staging)) {
    if (fs.realpathSync(record.staging) !== record.staging || !fs.lstatSync(record.staging).isDirectory()) throw new Error('unsafe recovery staging');
    removeStagingTree(record.staging);
  }
  fs.unlinkSync(path.join(paths.releases, JOURNAL));
  syncDirectory(paths.releases);
  for (const p of record.projects) fs.rmSync(p.backup, { recursive: true });
}
/** Explicit recovery only, after an operator establishes that no prior runner is alive
 * and removes its stale lock. Never infer ownership from a PID (PID reuse). */
export function recoverStableSkills(sourceRoot: string, releasesRoot: string): void {
  const paths = stableOverlayPaths();
  if (!paths || paths.root !== path.resolve(sourceRoot) || paths.releases !== path.resolve(releasesRoot)) throw new Error('overlay paths not configured');
  const record = readRecoveryRecord(paths.releases);
  const lockPath = path.join(paths.releases, '.stable-update.lock');
  const lock = fs.openSync(lockPath, 'wx', 0o600);
  try { restoreRecord(paths, record); }
  finally { fs.closeSync(lock); fs.unlinkSync(lockPath); syncDirectory(paths.releases); }
}
function verifyCurrentRelease(root: string, files: ArchiveFile[], d: StableReleaseDescriptor): void {
  const marker = JSON.parse(fs.readFileSync(path.join(root, '.tower-stable-release'), 'utf8')) as { archiveSha256?: string; commit?: string; tag?: string };
  if (marker.archiveSha256 !== d.archiveSha256 || marker.commit !== d.commit || marker.tag !== d.tag) throw new Error('current release marker mismatch');
  const expected = new Set(files.map(f => f.name).concat('.tower-stable-release'));
  const actual = fs.readdirSync(root, { recursive: true }).map(String).filter(rel => {
    const stat = fs.lstatSync(path.join(root, rel));
    if (stat.isSymbolicLink()) throw new Error('current release symlink');
    return stat.isFile();
  });
  if (actual.length !== expected.size || actual.some(rel => !expected.has(rel))) throw new Error('current release file inventory mismatch');
  for (const file of files) if (!fs.readFileSync(path.join(root, file.name)).equals(file.data)) throw new Error('current release changed');
}
function ensureForwardRelease(current: { tag: string; archiveSha256: string } | null, releases: string, d: StableReleaseDescriptor): string {
  if (current) {
    const version = (tag: string) => tag.slice(1).split('.').map(Number);
    const prior = version(current.tag);
    const next = version(d.tag);
    const differing = next.findIndex((n, i) => n !== prior[i]);
    if (differing >= 0 && next[differing] < prior[differing]) throw new Error('release downgrade blocked');
    if (current.tag === d.tag && current.archiveSha256 !== d.archiveSha256) throw new Error('stable tag reused with a different digest');
  }
  return path.join(releases, `sha256-${d.archiveSha256}`);
}
/** check writes only temporary staging; apply changes only enrolled skills. */
export function updateStableSkills(opts: StableUpdaterOptions): StableUpdateReceipt {
  const configured = stableOverlayPaths();
  if (!configured || configured.root !== path.resolve(opts.sourceRoot) || configured.releases !== path.resolve(opts.releasesRoot)) throw new Error('overlay paths not configured');
  if (fs.existsSync(path.join(configured.releases, JOURNAL))) throw new Error('recovery required before update');
  const d = requireDescriptor(opts.input);
  const files = tarEntries(opts.input.archive);
  const names = validatePayload(files);
  const { paths, policy, current } = overlayContext(opts);
  if (opts.projectRoots.length === 0) throw new Error('explicit project list required');
  if (policy.enrollments.some(e => !names.includes(e.name))) throw new Error('release removes an enrolled skill');
  const projects = opts.projectRoots.map(p => path.resolve(p));
  if (new Set(projects).size !== projects.length || projects.includes(paths.root)) throw new Error('invalid project roots');
  const selected = projects.map(readExistingNames);
  if (selected.some(entries => entries.some(name => policy.enrollments.some(e => e.name === name) && !names.includes(name)))) throw new Error('release removes an existing selected skill');
  const destination = ensureForwardRelease(current, paths.releases, d);
  const sameRelease = current?.directory === destination;
  if (!sameRelease && fs.existsSync(destination)) throw new Error('release destination already exists; refusing reused content');
  if (sameRelease) verifyCurrentRelease(destination, files, d);
  if (opts.mode === 'check') {
    const staging = fs.mkdtempSync(path.join(os.tmpdir(), 'tower-skill-check-'));
    try { stageAndScan(staging, files, names); }
    finally { fs.rmSync(staging, { recursive: true, force: true }); }
    return { status: 'eligible', tag: d.tag, archiveSha256: d.archiveSha256, projects: projects.length };
  }
  const lockPath = path.join(paths.releases, '.stable-update.lock');
  const lock = fs.openSync(lockPath, 'wx', 0o600);
  try {
    if (fs.existsSync(path.join(paths.releases, JOURNAL))) throw new Error('recovery required before update');
    const locked = overlayContext(opts);
    if (locked.current?.directory !== current?.directory || JSON.stringify(locked.policy) !== JSON.stringify(policy)) throw new Error('overlay changed during lock acquisition');
    const lockedSelected = projects.map(readExistingNames);
    if (JSON.stringify(lockedSelected) !== JSON.stringify(selected)) throw new Error('Project manifest changed during lock acquisition');
    const staging = sameRelease ? null : fs.mkdtempSync(path.join(paths.releases, '.stage-'));
    const backups: RecoveryRecord['projects'] = [];
    let journalWritten = false;
    let committed = false;
    try {
      if (staging) {
        stageAndScan(staging, files, names);
        fs.writeFileSync(path.join(staging, '.tower-stable-release'), JSON.stringify({ tag: d.tag, commit: d.commit, archiveSha256: d.archiveSha256 }), { flag: 'wx' });
        for (const file of files) fs.chmodSync(path.join(staging, file.name), file.mode);
        for (const dir of fs.readdirSync(staging, { recursive: true }).map(String).filter(rel => fs.lstatSync(path.join(staging, rel)).isDirectory()).sort((a, b) => b.length - a.length)) fs.chmodSync(path.join(staging, dir), 0o555);
        fs.chmodSync(path.join(staging, '.tower-stable-release'), 0o444);
        fs.chmodSync(staging, 0o555);
        syncTree(staging);
      }
      // Back up only Projects currently selecting enrolled skills; local pins
      // retain their existing manifest declarations and control files.
      const affected = selected.map(entries => entries.filter(name => policy.enrollments.some(e => e.name === name)));
      for (let i = 0; i < projects.length; i++) {
        if (!affected[i].length) continue;
        const root = path.join(projects[i], '.tower', 'skills');
        const backup = fs.mkdtempSync(path.join(paths.releases, '.project-backup-'));
        try {
          fs.copyFileSync(path.join(root, 'manifest.json'), path.join(backup, 'manifest.json'));
          for (const name of affected[i]) fs.cpSync(path.join(root, name), path.join(backup, name), { recursive: true, dereference: false });
          syncTree(backup);
          const targetStat = fs.lstatSync(root);
          backups.push({ root, backup, names: affected[i], digest: backupDigest(backup, affected[i]), device: targetStat.dev, inode: targetStat.ino });
        } catch (error) { fs.rmSync(backup, { recursive: true, force: true }); throw error; }
      }
      const record: RecoveryRecord = {
        schemaVersion: 1,
        previous: current ? { tag: current.tag, commit: current.commit, archiveSha256: current.archiveSha256 } : null,
        next: { tag: d.tag, commit: d.commit, archiveSha256: d.archiveSha256 },
        destination, candidateCreated: staging !== null, staging, projects: backups,
      };
      try { durableFile(path.join(paths.releases, JOURNAL), JSON.stringify(record)); }
      catch (error) {
        // A partially written journal must never lose its backups. It blocks
        // subsequent updates until an operator inspects the failed prepare.
        if (fs.existsSync(path.join(paths.releases, JOURNAL))) journalWritten = true;
        throw error;
      }
      journalWritten = true;
      if (staging) {
        fs.renameSync(staging, destination);
        syncDirectory(paths.releases);
        writeActivation(paths.active, record.next);
      }
      for (let i = 0; i < projects.length; i++) {
        if (!affected[i].length) continue;
        // Re-materialize only enrolled names; preserve other entries via no-prune.
        const result = materializeProjectRegistrySkills({ projectRootPath: projects[i], skillNames: affected[i], storageMode: 'bind-ro', prune: false });
        if (!result.ok || result.materialized.length !== affected[i].length) throw new Error('project materialization failed');
      }
      // fsync only updater-owned affected controls; unrelated local skill trees
      // must not be traversed (and may contain symlinks or concurrent edits).
      for (const p of backups) {
        for (const name of p.names) syncTree(path.join(p.root, name));
        const fd = fs.openSync(path.join(p.root, 'manifest.json'), 'r');
        try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
        syncDirectory(p.root);
      }
      fs.unlinkSync(path.join(paths.releases, JOURNAL));
      journalWritten = false; // A committed update is no longer eligible for rollback.
      committed = true;
      syncDirectory(paths.releases);
      for (const { backup } of backups) {
        try { fs.rmSync(backup, { recursive: true, force: true }); }
        catch { console.warn('[stable-skills] backup cleanup incomplete; operator cleanup required'); }
      }
      return { status: sameRelease ? 'already-current' : 'applied', tag: d.tag, archiveSha256: d.archiveSha256, projects: projects.length };
    } catch (error) {
      // The journal was removed after successful materialization. Never
      // delete a published candidate during post-commit cleanup failure.
      if (committed) throw new Error('update committed; cleanup incomplete', { cause: error });
      if (journalWritten) {
        try { restoreRecord(paths, readRecoveryRecord(paths.releases)); }
        catch (err) { throw new Error(`skill update and rollback failed; manual recovery required: ${String(err)}`, { cause: error }); }
      } else {
        // Before the durable journal no Project or activation has changed.
        // If cleanup fails, leave the candidate/backups in place for inspection.
        for (const { backup } of backups) fs.rmSync(backup, { recursive: true });
        if (staging && fs.existsSync(staging)) removeStagingTree(staging);
        // No candidate has been published before a durable journal exists.
      }
      throw error;
    }
  } finally { fs.closeSync(lock); fs.unlinkSync(lockPath); syncDirectory(paths.releases); }
}

function stageAndScan(staging: string, files: ArchiveFile[], names: string[]): void {
  for (const f of files) {
    const target = path.join(staging, f.name);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, f.data, { flag: 'wx', mode: f.mode });
  }
  for (const name of names) {
    const scan = scanSkillBundleForReadOnlyMount(path.join(staging, 'skills', name));
    if (!scan.ok || scan.findings.some(f => f.code === 'symlink_skipped' || f.code === 'generated_artifact_skipped')) throw new Error(`release skill failed scan: ${name}`);
  }
}

function removeStagingTree(root: string): void {
  if (!fs.existsSync(root)) return;
  for (const rel of fs.readdirSync(root, { recursive: true }).map(String)) {
    const file = path.join(root, rel);
    if (fs.lstatSync(file).isDirectory()) fs.chmodSync(file, 0o700);
  }
  fs.chmodSync(root, 0o700);
  fs.rmSync(root, { recursive: true, force: true });
}

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { getTeamskillsProjectRoot, isSafeSkillName } from './teamskills-source.js';
import { scanSkillBundleForReadOnlyMount } from './skill-materialization-scanner.js';


export interface StableEnrollment { name: string; localDigest: string | null }
export interface StableOverlayPolicy { schemaVersion: 1; enrollments: StableEnrollment[] }

const digestPattern = /^sha256:[a-f0-9]{64}$/;
export function stableOverlayPaths(): { root: string; releases: string; policy: string; active: string } | null {
  const configured = process.env.TEAMSKILLS_STABLE_RELEASES_ROOT;
  if (!configured || !path.isAbsolute(configured)) return null;
  try {
    const root = path.resolve(getTeamskillsProjectRoot());
    const releases = path.resolve(configured);
    if (fs.realpathSync(root) !== root || fs.realpathSync(releases) !== releases
      || !fs.lstatSync(root).isDirectory() || !fs.lstatSync(releases).isDirectory()
      || releases === root || releases.startsWith(root + path.sep) || root.startsWith(releases + path.sep)) return null;
    return { root, releases, policy: path.join(root, '.tower', 'stable-skills-policy.json'), active: path.join(releases, 'active.json') };
  } catch { return null; }
}

function regularFile(file: string): boolean {
  return fs.realpathSync(file) === file && fs.lstatSync(file).isFile();
}
export function readStableOverlayPolicy(paths: NonNullable<ReturnType<typeof stableOverlayPaths>>): StableOverlayPolicy {
  if (fs.realpathSync(path.dirname(paths.policy)) !== path.dirname(paths.policy) || !regularFile(paths.policy)) throw new Error('unsafe enrollment policy');
  const parsed = JSON.parse(fs.readFileSync(paths.policy, 'utf8')) as StableOverlayPolicy;
  if (parsed.schemaVersion !== 1 || !Array.isArray(parsed.enrollments) || !parsed.enrollments.length) throw new Error('invalid enrollment policy');
  const names = new Set<string>();
  for (const entry of parsed.enrollments) {
    if (!entry || !isSafeSkillName(entry.name) || names.has(entry.name)
      || entry.localDigest !== null && (typeof entry.localDigest !== 'string' || !digestPattern.test(entry.localDigest))) throw new Error('invalid enrollment');
    names.add(entry.name);
  }
  return parsed;
}

export function validatedLocalDigest(root: string, name: string): string | null {
  const local = path.join(root, 'skills', name);
  try { fs.lstatSync(local); } catch (err: any) { if (err.code === 'ENOENT') return null; throw err; }
  if (fs.realpathSync(local) !== local || !fs.lstatSync(local).isDirectory()) throw new Error('unsafe local skill');
  const scan = scanSkillBundleForReadOnlyMount(local);
  if (!scan.ok || scan.findings.some(f => f.code.startsWith('symlink') || f.code === 'generated_artifact_skipped')) throw new Error('unsafe local skill');
  const hash = crypto.createHash('sha256');
  for (const relativePath of scan.filesAllowed.sort()) {
    const bytes = fs.readFileSync(path.join(local, relativePath));
    const sha = crypto.createHash('sha256').update(bytes).digest('hex');
    hash.update(`${relativePath}\0${bytes.length}\0${sha}\n`, 'utf8');
  }
  return `sha256:${hash.digest('hex')}`;
}

export function readStableOverlayActivation(paths: NonNullable<ReturnType<typeof stableOverlayPaths>>): { tag: string; archiveSha256: string; commit: string; directory: string } | null {
  try { fs.lstatSync(paths.active); } catch (err: any) { if (err.code === 'ENOENT') return null; throw err; }
  if (!regularFile(paths.active)) throw new Error('unsafe activation');
  const entry = JSON.parse(fs.readFileSync(paths.active, 'utf8')) as { tag: string; archiveSha256: string; commit: string };
  if (!/^v\d+\.\d+\.\d+$/.test(entry.tag) || !/^[a-f0-9]{64}$/.test(entry.archiveSha256) || !/^[a-f0-9]{40}$/.test(entry.commit)) throw new Error('invalid activation');
  const directory = path.join(paths.releases, `sha256-${entry.archiveSha256}`);
  const markerPath = path.join(directory, '.tower-stable-release');
  if (fs.realpathSync(directory) !== directory || !fs.lstatSync(directory).isDirectory()
    || !regularFile(markerPath)) throw new Error('unsafe release');
  const marker = JSON.parse(fs.readFileSync(markerPath, 'utf8')) as typeof entry;
  if (marker.tag !== entry.tag || marker.commit !== entry.commit || marker.archiveSha256 !== entry.archiveSha256) throw new Error('activation marker mismatch');
  return { ...entry, directory };
}

/** Single source selection contract shared by resolver, materializer, host snapshot and mount. */
export function readStableOverlayDefaults(): string[] | null {
  const paths = stableOverlayPaths();
  if (!paths) return null;
  try {
    const active = readStableOverlayActivation(paths);
    if (!active) return null;
    const policy = readStableOverlayPolicy(paths);
    const data = JSON.parse(fs.readFileSync(path.join(active.directory, 'skillset.json'), 'utf8')) as { defaultSkills?: unknown };
    if (!Array.isArray(data.defaultSkills) || data.defaultSkills.some(n => typeof n !== 'string' || !isSafeSkillName(n))) return null;
    return data.defaultSkills.filter(n => policy.enrollments.some(e => e.name === n) && resolveTrustedTeamskillsSkillSource(n) !== null);
  } catch { return null; }
}

export function resolveTrustedTeamskillsSkillSource(name: string): string | null {
  if (!isSafeSkillName(name)) return null;
  const root = path.resolve(getTeamskillsProjectRoot());
  const local = path.join(root, 'skills', name);
  const paths = stableOverlayPaths();
  if (!paths) {
    // If an overlay was explicitly configured but is invalid, never silently
    // downgrade to the local source for an already enrolled Project manifest.
    if (process.env.TEAMSKILLS_STABLE_RELEASES_ROOT) return null;
    try { return fs.realpathSync(local) === local ? local : null; } catch { return null; }
  }
  try {
    const active = readStableOverlayActivation(paths);
    if (!active) return fs.realpathSync(local) === local ? local : null;
    const policy = readStableOverlayPolicy(paths);
    const enrollment = policy.enrollments.find(item => item.name === name);
    if (!enrollment) return fs.realpathSync(local) === local ? local : null;
    if (validatedLocalDigest(root, name) !== enrollment.localDigest) {
      // Local fork wins at read time; updater separately blocks activation until
      // an operator reviews and re-enrolls the changed digest.
      return fs.realpathSync(local) === local ? local : null;
    }
    const source = path.join(active.directory, 'skills', name);
    if (fs.realpathSync(source) !== source || !fs.lstatSync(source).isDirectory()) return null;
    const scan = scanSkillBundleForReadOnlyMount(source);
    if (!scan.ok || scan.findings.some(f => f.code.startsWith('symlink') || f.code === 'generated_artifact_skipped')) return null;
    return source;
  } catch { return null; }
}

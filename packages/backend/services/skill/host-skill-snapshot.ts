import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { computeBundleDigest } from './skill-bundle-resolver.js';
import { scanSkillBundleForReadOnlyMount } from './skill-materialization-scanner.js';

/** Project-local executable snapshot. Never changes the managed manifest or org source. */
export function hostSkillSnapshotPath(projectRoot: string, name: string, digest: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(name) || !/^sha256:[a-f0-9]{64}$/.test(digest)) throw new Error('Invalid skill snapshot identity');
  return path.join(path.resolve(projectRoot), '.tower', 'skill-assets', digest.slice(7), name);
}

export function verifyHostSkillSnapshot(directory: string, digest: string): boolean {
  try {
    if (fs.realpathSync(directory) !== directory) return false;
    const scan = scanSkillBundleForReadOnlyMount(directory);
    if (!scan.ok || scan.findings.some(f => f.code.startsWith('symlink'))) return false;
    const files = scan.filesAllowed.map(relativePath => {
      const bytes = fs.readFileSync(path.join(directory, relativePath));
      return { relativePath, sizeBytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
    });
    return computeBundleDigest(files) === digest;
  } catch { return false; }
}

export function prepareHostSkillSnapshot(projectRoot: string, name: string, digest: string, source: string, files: string[]): string {
  const target = hostSkillSnapshotPath(projectRoot, name, digest);
  // Reject symlinked ancestors before any mkdir/copy, including dangling links.
  const root = path.resolve(projectRoot);
  if (fs.realpathSync(root) !== root) throw new Error('Unsafe project root');
  let ancestor = root;
  for (const part of path.relative(root, path.dirname(target)).split(path.sep)) {
    ancestor = path.join(ancestor, part);
    try { if (!fs.lstatSync(ancestor).isDirectory() || fs.lstatSync(ancestor).isSymbolicLink()) throw new Error('Unsafe snapshot ancestor'); }
    catch (error: any) { if (error.code !== 'ENOENT') throw error; fs.mkdirSync(ancestor); }
  }
  try {
    fs.lstatSync(target);
    if (!verifyHostSkillSnapshot(target, digest)) throw new Error('Existing skill snapshot changed');
    return target;
  } catch (error: any) { if (error.code !== 'ENOENT') throw error; }
  const staging = fs.mkdtempSync(path.join(path.dirname(target), '.prepare-'));
  try {
    for (const relative of files) {
      const dest = path.resolve(staging, relative);
      if (!dest.startsWith(staging + path.sep)) throw new Error('Unsafe snapshot file');
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.copyFileSync(path.join(source, relative), dest, fs.constants.COPYFILE_EXCL);
    }
    if (!verifyHostSkillSnapshot(staging, digest)) throw new Error('Snapshot digest mismatch');
    try { fs.renameSync(staging, target); }
    catch (error) { if (!verifyHostSkillSnapshot(target, digest)) throw error; }
    return target;
  } finally { fs.rmSync(staging, { recursive: true, force: true }); }
}

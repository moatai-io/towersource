import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { isSafeSkillName } from './teamskills-source.js';
import { scanSkillBundleForReadOnlyMount } from './skill-materialization-scanner.js';
import type { StableReleaseDescriptor, StableReleaseInput } from './stable-release-updater.js';

const MAX_ARCHIVE = 32 * 1024 * 1024;
const MAX_UNPACKED = 128 * 1024 * 1024;
const MAX_ENTRIES = 2500;

function octal(value: number, width: number): string {
  const encoded = value.toString(8);
  if (encoded.length > width - 1) throw new Error('ustar numeric field overflow');
  return encoded.padStart(width - 1, '0') + '\0';
}
function header(name: string, length: number, mode: number): Buffer {
  if (!/^[\x20-\x7e]+$/.test(name) || name.length > 100) throw new Error('archive path not representable by strict ustar');
  const out = Buffer.alloc(512);
  out.write(name, 0, 'ascii');
  out.write(octal(mode, 8), 100, 'ascii');
  out.write(octal(0, 8), 108, 'ascii');
  out.write(octal(0, 8), 116, 'ascii');
  out.write(octal(length, 12), 124, 'ascii');
  out.write(octal(0, 12), 136, 'ascii');
  out.fill(32, 148, 156);
  out.write('0', 156, 'ascii');
  out.write('ustar\0', 257, 'ascii');
  out.write('00', 263, 'ascii');
  const sum = out.reduce((n, byte) => n + byte, 0);
  out.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 'ascii');
  return out;
}

/** Deterministic strict-ustar bytes for a reviewed source tree. Nothing is published. */
export function packageStableSkillSource(sourceRoot: string): Buffer {
  const root = path.resolve(sourceRoot);
  if (fs.realpathSync(root) !== root || !fs.lstatSync(root).isDirectory()) throw new Error('unsafe source root');
  const skillsetPath = path.join(root, 'skillset.json');
  if (fs.realpathSync(skillsetPath) !== skillsetPath || !fs.lstatSync(skillsetPath).isFile()) throw new Error('unsafe skillset');
  const raw = fs.readFileSync(skillsetPath);
  const skillset: unknown = JSON.parse(raw.toString('utf8'));
  if (!skillset || typeof skillset !== 'object' || !('defaultSkills' in skillset)) throw new Error('invalid skillset');
  const defaults = (skillset as { defaultSkills: unknown }).defaultSkills;
  if (!Array.isArray(defaults) || !defaults.length || defaults.some(name => typeof name !== 'string' || !isSafeSkillName(name)) || new Set(defaults).size !== defaults.length) throw new Error('invalid defaults');
  const entries: Array<{ name: string; data: Buffer; mode: number }> = [{ name: 'skillset.json', data: raw, mode: 0o444 }];
  const skillsRoot = path.join(root, 'skills');
  if (fs.realpathSync(skillsRoot) !== skillsRoot || !fs.lstatSync(skillsRoot).isDirectory()) throw new Error('unsafe skills root');
  const dirs = fs.readdirSync(skillsRoot, { withFileTypes: true });
  if (dirs.some(dir => !dir.isDirectory() || !isSafeSkillName(dir.name))) throw new Error('unexpected skills entry');
  if (defaults.some(name => !dirs.some(dir => dir.name === name))) throw new Error('missing default skill');
  for (const name of dirs.map(d => d.name).sort()) {
    const skillRoot = path.join(skillsRoot, name);
    if (fs.realpathSync(skillRoot) !== skillRoot) throw new Error('symlinked skill');
    const scan = scanSkillBundleForReadOnlyMount(skillRoot);
    if (!scan.ok || scan.findings.length || !scan.filesAllowed.includes('SKILL.md')) throw new Error(`unsafe skill bundle: ${name}`);
    for (const relative of scan.filesAllowed) {
      const file = path.join(skillRoot, relative);
      if (fs.realpathSync(file) !== file || !fs.lstatSync(file).isFile()) throw new Error('unsafe skill file');
      entries.push({ name: `skills/${name}/${relative}`, data: fs.readFileSync(file), mode: fs.statSync(file).mode & 0o111 ? 0o555 : 0o444 });
    }
  }
  if (entries.length > MAX_ENTRIES) throw new Error('too many release files');
  const total = entries.reduce((n, entry) => n + 512 + Math.ceil(entry.data.length / 512) * 512, 1024);
  if (total > MAX_UNPACKED) throw new Error('release too large');
  const tar = Buffer.alloc(total);
  let offset = 0;
  for (const entry of entries) {
    header(entry.name, entry.data.length, entry.mode).copy(tar, offset);
    entry.data.copy(tar, offset + 512);
    offset += 512 + Math.ceil(entry.data.length / 512) * 512;
  }
  const archive = gzipSync(tar, { mtime: 0 } as any);
  // gzip OS byte varies by producer/runtime; pin the portable value.
  archive[9] = 255;
  if (archive.length > MAX_ARCHIVE) throw new Error('compressed release too large');
  return archive;
}

/** Sign exact descriptor bytes with an operator-supplied key; never create or persist keys. */
export function signStableSkillRelease(sourceRoot: string, tag: string, commit: string, privateKey: crypto.KeyLike): Pick<StableReleaseInput, 'descriptor' | 'signature' | 'archive'> {
  if (!/^v\d+\.\d+\.\d+$/.test(tag) || !/^[a-f0-9]{40}$/.test(commit)) throw new Error('invalid stable release identity');
  const archive = packageStableSkillSource(sourceRoot);
  const descriptor: StableReleaseDescriptor = {
    schemaVersion: 1, repository: 'juliuschun/teamskills', tag, commit,
    archiveSha256: crypto.createHash('sha256').update(archive).digest('hex'),
    minimumAppCapability: 1, requiredFeatures: ['bind-ro', 'gatewayApis', 'retainedEntries'],
  };
  const bytes = Buffer.from(JSON.stringify(descriptor) + '\n');
  const signature = crypto.sign(null, bytes, privateKey);
  return { descriptor: bytes, signature, archive };
}

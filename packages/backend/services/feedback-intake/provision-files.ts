/** Narrow operator filesystem adapter. No implicit paths, shell, network or env discovery. */
import * as fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

export class ProvisionApplyError extends Error { constructor() { super('feedback_provision_apply_refused_or_needs_review'); } }
export const refuse = (): never => { throw new ProvisionApplyError(); };
export const sha = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
export function privateDirectory(dir: string): void {
  if (!path.isAbsolute(dir) || path.normalize(dir) !== dir || fs.realpathSync(dir) !== dir) refuse();
  const s = fs.statSync(dir);
  if (!s.isDirectory() || s.uid !== process.geteuid!() || (s.mode & 0o7777) !== 0o700) refuse();
}
export function trustedAncestors(dir: string): void {
  for (let p = dir; ; p = path.dirname(p)) {
    const s = fs.lstatSync(p);
    if (!s.isDirectory() || ![0, process.geteuid!()].includes(s.uid) || (s.mode & 0o022)) refuse();
    if (p === path.dirname(p)) break;
  }
}
export function readPrivate(file: string, uid = process.geteuid!()): Buffer {
  if (!path.isAbsolute(file) || fs.realpathSync(file) !== file || path.normalize(file) !== file) refuse();
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    const s = fs.fstatSync(fd);
    if (!s.isFile() || s.uid !== uid || s.nlink !== 1 || (s.mode & 0o7777) !== 0o600 || s.size > 1024 * 1024) refuse();
    const buf = Buffer.alloc(1024 * 1024 + 1); let n = 0; let got: number;
    while (n < buf.length && (got = fs.readSync(fd, buf, n, buf.length - n, null)) > 0) n += got;
    if (n > 1024 * 1024) refuse();
    return buf.subarray(0, n);
  } finally { fs.closeSync(fd); }
}
export function syncDirectory(dir: string): void {
  const fd = fs.openSync(dir, fs.constants.O_RDONLY); try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}
export function exclusiveWrite(file: string, bytes: string | Buffer): void {
  const fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
  try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  syncDirectory(path.dirname(file));
}
export function atomicReplace(file: string, bytes: string | Buffer, beforeRename: () => void): void {
  const tmp = `${file}.feedback-${randomUUID()}`;
  // Interrupted temporary files are deliberately retained for operator review.
  exclusiveWrite(tmp, bytes); beforeRename(); fs.renameSync(tmp, file); syncDirectory(path.dirname(file));
}
export function withFileLock<T>(file: string, action: () => Promise<T>): Promise<T> {
  fs.mkdirSync(file, { mode: 0o700 });
  return action().finally(() => { fs.rmdirSync(file); syncDirectory(path.dirname(file)); });
}
export const managedKeys = ['TOWER_FEEDBACK_CLIENT_TOKEN', 'TOWER_FEEDBACK_CLIENT_ENABLED', 'TOWER_FEEDBACK_INTAKE_ORIGIN'] as const;
// Strict single-line dotenv subset. Refuse ambiguous multiline/expansion syntax;
// never execute a source file. Other assignment bytes remain unchanged.
export function managedValues(bytes: Buffer): Map<string, string> {
  const text = bytes.toString('utf8'); if (!Buffer.from(text).equals(bytes) || text.includes('\0')) refuse();
  const values = new Map<string, string>();
  for (const line of text.split(/\r?\n/)) {
    if (/^\s*(?:#.*)?$/.test(line)) continue;
    const match = /^(export\s+)?([A-Z_][A-Z0-9_]*)=(.*)$/.exec(line); if (!match) refuse();
    const [, exported, key, raw] = match!;
    if (/[`$\\]/.test(raw)) refuse();
    let value = raw;
    if (raw.startsWith('"') || raw.startsWith("'")) {
      if (raw.length < 2 || raw.at(-1) !== raw[0] || raw.slice(1,-1).includes(raw[0])) refuse();
      value = raw.slice(1,-1);
    } else if (/[\s'"#]/.test(raw)) refuse();
    if ((managedKeys as readonly string[]).includes(key)) {
      if (exported || values.has(key)) refuse();
      values.set(key, value);
    }
  }
  if (values.size !== 0 && values.size !== managedKeys.length) refuse();
  return values;
}

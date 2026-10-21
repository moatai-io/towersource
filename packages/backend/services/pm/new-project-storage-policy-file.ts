/** Read one optional server-owned JSON policy; no shell, dotenv or Project input. */
import fs from 'node:fs';
import path from 'node:path';

export const DEFAULT_NEW_PROJECT_POLICY_FILE = '/etc/tower/new-project-storage-policy.json';
const MAX_BYTES = 64 * 1024;
const fail = () => new Error('NEW_PROJECT_STORAGE_POLICY_FILE_UNTRUSTED');

function trusted(stat: fs.Stats): void {
  const uid = process.getuid?.();
  if ((stat.uid !== 0 && stat.uid !== uid) || (stat.mode & 0o022) !== 0 || stat.isSymbolicLink()) throw fail();
}

export function readTrustedNewProjectPolicyFile(file: string): string | undefined {
  if (!path.isAbsolute(file) || path.resolve(file) !== file || file === '/') throw fail();
  const components = [path.parse(file).root];
  for (const part of file.split(path.sep).filter(Boolean)) components.push(path.join(components.at(-1)!, part));
  const ancestors: Array<{ file: string; stat: fs.Stats }> = [];
  let target: fs.Stats | undefined;
  for (const component of components) {
    let stat: fs.Stats;
    try { stat = fs.lstatSync(component); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw fail();
    }
    trusted(stat);
    if (component === file) target = stat;
    else {
      if (!stat.isDirectory()) throw fail();
      ancestors.push({ file: component, stat });
    }
  }
  if (!target?.isFile() || target.nlink !== 1 || target.size > MAX_BYTES) throw fail();
  let fd: number | undefined;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    const before = fs.fstatSync(fd);
    trusted(before);
    if (!before.isFile() || before.dev !== target.dev || before.ino !== target.ino || before.nlink !== 1 || before.size > MAX_BYTES) throw fail();
    const bytes = Buffer.alloc(MAX_BYTES + 1);
    let size = 0;
    while (size < bytes.length) {
      const count = fs.readSync(fd, bytes, size, bytes.length - size, null);
      if (!count) break;
      size += count;
    }
    const after = fs.fstatSync(fd);
    const current = fs.lstatSync(file);
    if (size > MAX_BYTES || before.size !== size || before.ctimeMs !== after.ctimeMs || before.mtimeMs !== after.mtimeMs
      || current.dev !== before.dev || current.ino !== before.ino) throw fail();
    for (const ancestor of ancestors) {
      const stat = fs.lstatSync(ancestor.file);
      trusted(stat);
      if (!stat.isDirectory() || stat.dev !== ancestor.stat.dev || stat.ino !== ancestor.stat.ino) throw fail();
    }
    return bytes.subarray(0, size).toString('utf8');
  } catch { throw fail(); }
  finally { if (fd !== undefined) fs.closeSync(fd); }
}

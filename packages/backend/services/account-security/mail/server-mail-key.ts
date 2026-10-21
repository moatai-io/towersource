import { constants } from 'node:fs';
import { open, lstat, realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';

/** Never place the virtual key in PM2 environment, argv, a release artifact or a log. */
export async function readServerMailVirtualKey(filePath: string, sourceRoot: string): Promise<string> {
  if (!filePath || !isAbsolute(filePath)) throw new Error('Account mail key file path is invalid');
  const root = await realpath(sourceRoot);
  const parent = resolve(filePath, '..');
  const actualParent = await realpath(parent);
  const rel = relative(root, actualParent);
  if (!rel || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))) throw new Error('Account mail key file must be outside source tree');
  const stat = await lstat(filePath);
  if (!stat.isFile() || (stat.mode & 0o077) || stat.uid !== process.getuid?.()) throw new Error('Account mail key file permissions are invalid');
  const handle = await open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const current = await handle.stat();
    if (!current.isFile() || (current.mode & 0o077) || current.uid !== process.getuid?.() || current.ino !== stat.ino || current.dev !== stat.dev || current.size > 4096) {
      throw new Error('Account mail key file permissions are invalid');
    }
    const buffer = Buffer.alloc(4097);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, null);
      if (!bytesRead) break;
      length += bytesRead;
    }
    if (length > 4096) throw new Error('Account mail key file content is invalid');
    const value = buffer.subarray(0, length).toString('utf8').trim();
    if (!value || value.includes('\n') || value.includes('\r') || value.length > 4096) throw new Error('Account mail key file content is invalid');
    return value;
  } finally { await handle.close(); }
}

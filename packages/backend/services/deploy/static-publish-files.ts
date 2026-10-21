import { promises as fs } from 'node:fs';
import path from 'node:path';

/** Only backend-owned publication copies receive web-server-readable modes. */
export async function normalizePublishedModes(root: string): Promise<void> {
  const stat = await fs.lstat(root);
  if (stat.isSymbolicLink()) throw new Error('Published copies must not contain symbolic links');
  if (stat.isDirectory()) {
    await fs.chmod(root, 0o755);
    for (const name of await fs.readdir(root)) {
      await normalizePublishedModes(path.join(root, name));
    }
  } else if (stat.isFile()) {
    await fs.chmod(root, 0o644);
  } else {
    throw new Error('Published copies must contain only regular files and directories');
  }
}

export async function copyStaticPublication(srcDir: string, destDir: string): Promise<void> {
  const source = path.resolve(srcDir);
  const destination = path.resolve(destDir);
  // Reject overlap in either direction: never delete or chmod the source tree.
  if (source === destination || destination.startsWith(source + path.sep)
    || source.startsWith(destination + path.sep)) {
    throw new Error('Publication source and destination must not overlap');
  }
  await fs.rm(destination, { recursive: true, force: true });
  await fs.mkdir(destination, { recursive: true });
  await fs.cp(source, destination, {
    recursive: true,
    dereference: true,
    filter: src => !['.git', 'node_modules'].includes(path.basename(src)),
  });
  // fs.cp preserves source permissions; normalize after copying, not on Project files.
  await normalizePublishedModes(destination);
}

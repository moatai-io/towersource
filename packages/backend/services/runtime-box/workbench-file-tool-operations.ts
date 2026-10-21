import path from 'node:path';
import { downloadWorkerProjectFile, writeWorkerProjectFile, createWorkerProjectDirectory, compareAndSwapWorkerProjectFile, type WorkerFileAuthority } from './workbench-project-file-authority.js';

/** Per-tool-call adapter. Authority is pinned by the caller after ACL checks.
 * No local fallback. Do not reuse edit snapshots across concurrent tool calls.
 * Not activated in tool assembly until read/representation routing is unified.
 */
export function createWorkerFileToolOperations(authority: WorkerFileAuthority, actorUserId: number) {
  const snapshots = new Map<string, string>();
  function target(absolutePath: string): WorkerFileAuthority {
    const relative = path.relative(authority.projectRoot, path.resolve(absolutePath));
    if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw new Error('WORKER_FILE_PATH_OUTSIDE_PROJECT');
    }
    return { ...authority, relativePath: relative.split(path.sep).join('/') || '.' };
  }
  return {
    write: {
      mkdir: async (dir: string) => {
        const selected = target(dir);
        if (selected.relativePath !== '.') await createWorkerProjectDirectory({ authority: selected, actorUserId });
      },
      writeFile: async (file: string, content: string) => writeWorkerProjectFile({ authority: target(file), actorUserId, content }),
    },
    edit: {
      access: async (file: string) => { target(file); },
      readFile: async (file: string) => {
        const selected = target(file);
        const bytes = await downloadWorkerProjectFile({ authority: selected, actorUserId });
        const text = bytes.toString('utf8');
        if (!Buffer.from(text, 'utf8').equals(bytes)) throw new Error('WORKER_EDIT_REQUIRES_UTF8');
        snapshots.set(selected.relativePath, text);
        return bytes;
      },
      writeFile: async (file: string, content: string) => {
        const selected = target(file);
        const expectedContent = snapshots.get(selected.relativePath);
        if (expectedContent === undefined) throw new Error('WORKER_EDIT_SNAPSHOT_REQUIRED');
        snapshots.delete(selected.relativePath);
        await compareAndSwapWorkerProjectFile({ authority: selected, actorUserId, expectedContent, content });
      },
    },
  };
}

import type { FileEntry } from './file-system.js';

/** Bounded name search. Root failures are fatal; inaccessible children yield partial results. */
export async function searchFileTree(root: string, query: string, list: (directory: string) => Promise<FileEntry[]>) {
  const results: FileEntry[] = [];
  let partial = false;
  let truncated = false;
  let visited = 0;
  const walk = async (directory: string, depth: number) => {
    if (depth > 8 || visited >= 2000 || results.length >= 500) { truncated = true; return; }
    visited++;
    let entries: FileEntry[];
    try { entries = await list(directory); }
    catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (directory !== root && ['EACCES', 'EPERM', 'ENOENT', 'ENOTDIR'].includes(code || '')) { partial = true; return; }
      throw error;
    }
    for (const entry of entries) {
      if (results.length >= 500) { truncated = true; return; }
      if (entry.name.toLowerCase().includes(query)) results.push({ ...entry });
      if (entry.isDirectory) await walk(entry.path, depth + 1);
    }
  };
  await walk(root, 0);
  return { results, partial, truncated };
}

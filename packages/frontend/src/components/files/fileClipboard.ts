import { compactTopLevelPaths } from './SelectionToolbar';

/** A failed move remains in the clipboard; successful moves are never retried. */
export async function pasteCutPaths(paths: string[], targetDir: string, move: (oldPath: string, newPath: string) => Promise<void>) {
  const moved: { from: string; to: string }[] = [];
  const failed: string[] = [];
  for (const from of compactTopLevelPaths(paths)) {
    const to = `${targetDir.replace(/\/$/, '')}/${from.split('/').pop()}`;
    if (from === to) continue;
    if (targetDir === from || targetDir.startsWith(`${from}/`)) { failed.push(from); continue; }
    try { await move(from, to); moved.push({ from, to }); }
    catch { failed.push(from); }
  }
  return { moved, failed };
}

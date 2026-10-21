import path from 'node:path';

/** A changing Project population is discovered for every poll. No symlink or missing root is accepted downstream. */
export function selectStableUpdateProjectRoots(
  rows: Array<{ root_path: string | null }>,
  sourceRoot: string,
  explicit?: string[],
): string[] {
  if (rows.some(row => !row.root_path || !path.isAbsolute(row.root_path))) throw new Error('registered project has no canonical absolute root_path');
  const source = path.resolve(sourceRoot);
  const roots = rows.map(row => path.resolve(row.root_path!)).filter(root => root !== source);
  if (new Set(roots).size !== roots.length) throw new Error('duplicate registered Project roots');
  if (roots.length === 0) throw new Error('no registered Project targets');
  if (explicit) {
    const provided = explicit.map(root => path.resolve(root));
    const given = new Set(provided);
    if (given.size !== provided.length || given.size !== roots.length || roots.some(root => !given.has(root))) {
      throw new Error('explicit Project roots must match current DB target set');
    }
  }
  return roots.sort();
}

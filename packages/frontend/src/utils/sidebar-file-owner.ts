import { normalizeTowerFilePath } from './file-path-links';

/** Navigation only: never grants file access. Uses the same known-root aliases
 * as file links. Unknown owners are not guessed from basename/current Agent.
 */
export function normalizeSidebarFilePath(value: string): string {
  const trimmed = value.trim().replace(/\\/g, '/');
  // Only portable host aliases are context-independent. A raw /workspace path
  // belongs to its originating run, not whichever conversation is active now.
  const concrete = trimmed.startsWith('~/') ? normalizeTowerFilePath(trimmed) : trimmed;
  return concrete.replace(/\/+$/, '');
}

export function findOwningProjectForPath<T extends { rootPath?: string | null }>(projects: T[], value: string): T | undefined {
  const filePath = normalizeSidebarFilePath(value);
  return projects
    .filter(project => {
      if (!project.rootPath) return false;
      const root = normalizeSidebarFilePath(project.rootPath);
      return filePath === root || filePath.startsWith(`${root}/`);
    })
    .sort((a, b) => normalizeSidebarFilePath(b.rootPath || '').length - normalizeSidebarFilePath(a.rootPath || '').length)[0];
}

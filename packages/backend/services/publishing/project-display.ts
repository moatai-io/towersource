/**
 * Owns: folder-name → human-readable display name map for the Hub UI.
 * Public API:
 * - loadProjectDisplayMap() — returned alongside sites in /api/publish/status
 *   so the frontend can show "강태형대표님 작업" instead of "project-9f07a9ab"
 *   in group headers.
 * - loadProjectFolderKeyMap() — converts DB project ids into manifest.project
 *   folder keys for member-visible Hub filtering.
 *
 * Why a map (vs joining onto each site row):
 *  - manifest.project is folder name (system-of-record, never changes).
 *  - DB.projects.name is the user-editable display label (renames freely).
 *  - Frontend renders folder via map[folder] ?? folder so a single response
 *    fits both legacy entries and rename-after-publish.
 */
import { query } from '../../db/pg-repo.js';

interface ProjectRow {
  id: string;
  name: string;
  root_path: string | null;
}

/**
 * Returns Map<folderName, displayName>. Folder name = last segment of
 * root_path, matching the value reconciler/hook write into manifest.project.
 *
 * Skips archived projects (typically not interesting in the Hub) and rows
 * without a root_path (synthesized/legacy entries that have no on-disk
 * folder to match against).
 *
 * Failures (DB unreachable, etc.) return an empty map — frontend falls back
 * to displaying the folder name. Never throws.
 */
export async function loadProjectFolderKeyMap(): Promise<Record<string, string>> {
  try {
    const rows = await query<ProjectRow>(
      `SELECT id, name, root_path
       FROM projects
       WHERE root_path IS NOT NULL
         AND (archived IS NULL OR archived = 0)
       ORDER BY id`
    );
    const map: Record<string, string> = {};
    for (const r of rows) {
      const folder = extractFolder(r.root_path);
      if (!folder) continue;
      map[r.id] = folder;
    }
    return map;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[project-display] folder key map load failed: ${msg}`);
    return {};
  }
}

export async function loadProjectDisplayMap(): Promise<Record<string, string>> {
  try {
    const rows = await query<ProjectRow>(
      `SELECT id, name, root_path
       FROM projects
       WHERE root_path IS NOT NULL
         AND (archived IS NULL OR archived = 0)`
    );
    const map: Record<string, string> = {};
    for (const r of rows) {
      const folder = extractFolder(r.root_path);
      if (!folder || !r.name) continue;
      // First write wins. Duplicates (same folder, two project rows) are
      // pathological; pick the alphabetically-first id deterministically.
      if (!(folder in map)) map[folder] = r.name;
    }
    return map;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[project-display] load failed: ${msg}`);
    return {};
  }
}

function extractFolder(rootPath: string | null): string | null {
  if (!rootPath) return null;
  const m = rootPath.match(/[\\/]workspace[\\/]projects[\\/]([^\\/]+)/);
  return m ? m[1] : null;
}

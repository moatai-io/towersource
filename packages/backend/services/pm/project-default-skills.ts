import fs from 'node:fs';
import path from 'node:path';
import { materializeProjectRegistrySkills } from '../skill/project-skill-materializer.js';

/** Optional defaults are not a staffing requirement. Never bypass source scans. */
export function seedProjectDefaultSkills(projectRootPath: string, skillNames: string[]): void {
  const result = materializeProjectRegistrySkills({ projectRootPath, skillNames, storageMode: 'bind-ro' });
  // The manifest (even when empty) remains the runtime allowlist. Persist only
  // safe diagnostic identifiers, not scanner findings containing host paths.
  fs.writeFileSync(path.join(result.targetRootPath, 'seed-status.json'), `${JSON.stringify({
    schemaVersion: 1,
    status: result.ok ? 'ready' : 'degraded',
    materialized: result.materialized.map(skill => skill.name),
    skipped: result.skipped.map(({ name, reason }) => ({ name, reason })),
  }, null, 2)}\n`, 'utf8');
  if (!result.ok) {
    console.warn('[project-manager] Default skills unavailable; project created with a reduced skill set:',
      result.skipped.map(({ name, reason }) => `${name}:${reason}`).join(', '));
  }
  // Filesystem/materializer exceptions deliberately propagate to scaffold rollback.
}

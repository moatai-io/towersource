import fs from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = fs.readFileSync(new URL('./project-manager.ts', import.meta.url), 'utf8');

describe('legacy Project hard-delete removal contract', () => {
  it('does not detach preserved history or delete the Project row in the retirement service', () => {
    const start = source.indexOf('export async function retireProject');
    const end = source.indexOf('export async function restoreProject', start);
    const retirement = source.slice(start, end);
    for (const statement of [
      'UPDATE sessions SET project_id = NULL WHERE project_id = $1',
      'UPDATE tasks SET project_id = NULL WHERE project_id = $1',
      'UPDATE session_memory_cards SET project_id = NULL WHERE project_id = $1',
      'DELETE FROM projects WHERE id = $1',
    ]) expect(retirement).not.toContain(statement);
  });

  it('exposes reversible retire and restore operations instead', () => {
    expect(source).toContain('export async function retireProject');
    expect(source).toContain('export async function restoreProject');
    expect(source).toContain("lifecycle_status = 'retired'");
    expect(source).toContain("lifecycle_status = 'active'");
  });
});

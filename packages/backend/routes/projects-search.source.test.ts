import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const route = fs.readFileSync(path.resolve(import.meta.dirname, './api.ts'), 'utf8');
const manager = fs.readFileSync(path.resolve(import.meta.dirname, '../services/pm/project-manager.ts'), 'utf8');

describe('accessible project search', () => {
  it('exposes a dedicated authenticated search route before the projects detail route', () => {
    expect(route).toContain("router.get('/projects/search'");
    expect(route).toContain('await searchAccessibleProjects(userId, role, search)');
    expect(route).toContain("if (!userId) return res.status(401)");
  });

  it('searches archived and legacy projects without widening member access', () => {
    const search = manager.slice(manager.indexOf('export async function searchAccessibleProjects'), manager.indexOf('export async function getProjects'));
    expect(search).toContain('await getAccessibleProjectIds(userId, role)');
    expect(search).toContain('if (accessibleIds.length === 0) return []');
    expect(search).toContain('p.id = ANY($2::text[])');
    expect(search).toContain("p.system_key IS NULL");
    expect(search).toContain('pap.display_name');
    expect(search).not.toContain("p.archived IS NULL OR p.archived = 0)\n      AND");
  });
});

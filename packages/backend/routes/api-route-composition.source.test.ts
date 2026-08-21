import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const routesRoot = path.resolve(import.meta.dirname);
const apiSource = fs.readFileSync(path.join(routesRoot, 'api.ts'), 'utf8');
const projectFilesSource = fs.readFileSync(path.join(routesRoot, 'project-files/project-files-router.ts'), 'utf8');

const projectFilesCoreRoutes = [
  'GET /directories',
  'GET /files/notes-index',
  'GET /files/knowledge-graph',
  'GET /files/reveal',
  'GET /files/tree',
  'GET /files/read',
  'GET /files/exists',
  'POST /files/write',
  'POST /files/create',
  'POST /files/mkdir',
  'POST /files/delete',
  'POST /files/rename',
  'POST /files/copy',
  'GET /files/search',
] as const;

function literalRoutes(source: string): string[] {
  return [...source.matchAll(/router\.(get|post|put|patch|delete)\('([^']+)'/g)]
    .map((match) => `${match[1].toUpperCase()} ${match[2]}`);
}

describe('API route composition contracts', () => {
  it('mounts Project Files once in the protected route zone', () => {
    const authIndex = apiSource.indexOf('router.use(authMiddleware)');
    const mount = "router.use('/', projectFilesRouter)";
    const mountIndex = apiSource.indexOf(mount);

    expect(authIndex).toBeGreaterThan(0);
    expect(mountIndex).toBeGreaterThan(authIndex);
    expect(apiSource.split(mount)).toHaveLength(2);
  });

  it('keeps the Project Files core method/path inventory exact and duplicate-free', () => {
    const actual = literalRoutes(projectFilesSource);
    expect(actual).toEqual(projectFilesCoreRoutes);
    expect(new Set(actual).size).toBe(actual.length);
  });

  it('removes moved Project Files handlers from the composition root', () => {
    const rootRoutes = new Set(literalRoutes(apiSource));
    for (const route of projectFilesCoreRoutes) expect(rootRoutes.has(route)).toBe(false);
  });

  it('normalizes and validates session model PATCH values at the route boundary', () => {
    expect(apiSource).toContain("modelUsed must be a string or null");
    expect(apiSource).toContain("const current = await getSession(req.params.id as string)");
    expect(apiSource).toContain("normalizePiSessionModelId(normalizedModelUsed)");
    expect(apiSource).toContain("modelUsed does not match session engine");
    expect(apiSource.indexOf("normalizePiSessionModelId(normalizedModelUsed)"))
      .toBeLessThan(apiSource.indexOf("await updateSession(req.params.id as string, updates)"));
  });
});

import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const routesRoot = path.resolve(import.meta.dirname, '..');
const apiSource = fs.readFileSync(path.join(routesRoot, 'api.ts'), 'utf8');
const sessionCoreSource = fs.readFileSync(path.join(import.meta.dirname, 'session-core-router.ts'), 'utf8');

const sessionCoreRoutes = [
  'GET /sessions',
  'POST /sessions',
  'GET /sessions/:id/composer-actions',
  'GET /sessions/:id',
  'GET /sessions/:id/full',
  'GET /sessions/:id/initial-interview',
  'POST /sessions/:id/initial-interview',
  'GET /sessions/:id/messages',
] as const;

function literalRoutes(source: string): string[] {
  return [...source.matchAll(/router\.(get|post|put|patch|delete)\('([^']+)'/g)]
    .map((match) => `${match[1].toUpperCase()} ${match[2]}`);
}

describe('Session Core route composition contracts', () => {
  it('mounts Session Core once inside the protected route zone', () => {
    const authIndex = apiSource.indexOf('router.use(authMiddleware)');
    const mount = "router.use('/', sessionCoreRouter)";
    const mountIndex = apiSource.indexOf(mount);

    expect(authIndex).toBeGreaterThan(0);
    expect(mountIndex).toBeGreaterThan(authIndex);
    expect(apiSource.split(mount)).toHaveLength(2);
  });

  it('keeps the Session Core inventory exact and duplicate-free', () => {
    const actual = literalRoutes(sessionCoreSource);
    expect(actual).toEqual(sessionCoreRoutes);
    expect(new Set(actual).size).toBe(actual.length);
  });

  it('removes moved handlers from api.ts while retaining lifecycle routes', () => {
    const rootRoutes = new Set(literalRoutes(apiSource));
    for (const route of sessionCoreRoutes) expect(rootRoutes.has(route)).toBe(false);
    for (const retained of [
      'POST /sessions/spawn',
      'POST /sessions/:id/send',
      'PATCH /sessions/:id',
      'POST /sessions/:id/switch-engine',
      'POST /sessions/:id/messages/:messageId/branch',
      'DELETE /sessions/:id',
    ]) expect(rootRoutes.has(retained)).toBe(true);
  });

  it('keeps backward-compatible message response modes', () => {
    // Access denial and context-read ordering execute in session-core-access.test.ts.
    // Retain response-mode wiring until it has an HTTP behavior equivalent.
    expect(sessionCoreSource).toContain('getMessagesPaginated');
    expect(sessionCoreSource).toContain('const messages = await getMessages');
  });
});

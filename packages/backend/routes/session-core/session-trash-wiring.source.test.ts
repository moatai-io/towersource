import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
const api = fs.readFileSync(new URL('../api.ts', import.meta.url), 'utf8');
const core = fs.readFileSync(new URL('./session-core-router.ts', import.meta.url), 'utf8');
describe('Trash lifecycle integration', () => {
  it('archives empty and non-empty sessions without hard deletion', () => {
    const handler = api.slice(api.indexOf('async function hideSessionFromSidebar'), api.indexOf("router.post('/sessions/:id/hide'"));
    expect(handler).toContain('const ok = await deleteSession(sessionId)');
    expect(handler).not.toContain('permanentlyDeleteSession');
    expect(handler).not.toContain('messageCount');
    expect(handler).toContain('await canDeleteSession(sessionId, userId, role)');
    expect(handler).toContain("SET status = 'archived'");
  });
  it('exposes an explicit archive action without a permanent deletion route', () => {
    expect(api).toContain("router.post('/sessions/:id/archive', hideSessionFromSidebar)");
    expect(api).not.toContain("router.delete('/sessions/:id/permanent'");
  });
  it('mounts the literal trash route before generic session lookup', () => {
    expect(core.indexOf('router.use(sessionTrashRouter)')).toBeLessThan(core.indexOf("router.get('/sessions/:id'"));
  });
});

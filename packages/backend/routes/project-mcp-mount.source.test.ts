import fs from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('project MCP HTTP integration', () => {
  it('mounts single-use OAuth callbacks before bearer authentication, management and selection after it', () => {
    const source = fs.readFileSync(new URL('./api.ts', import.meta.url), 'utf8');
    const callback = source.indexOf("router.use('/', publicProjectMcpOAuthRouter)");
    const auth = source.indexOf('router.use(authMiddleware)');
    const manager = source.indexOf("router.use('/', projectMcpRouter)");
    const selection = source.indexOf("router.use('/', sessionMcpSelectionRouter)");
    expect(callback).toBeGreaterThan(-1);
    expect(callback).toBeLessThan(auth);
    expect(manager).toBeGreaterThan(auth);
    expect(selection).toBeGreaterThan(auth);
  });
});

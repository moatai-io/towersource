import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const apiSource = fs.readFileSync(path.join(import.meta.dirname, 'api.ts'), 'utf8');

describe('client reset escape hatch source contract', () => {
  it('keeps /api/client-reset public so stale app-shell Service Workers do not gate it behind auth', () => {
    const resetRouteIndex = apiSource.indexOf("router.get('/client-reset'");
    const authMiddlewareIndex = apiSource.indexOf('router.use(authMiddleware)');

    expect(resetRouteIndex).toBeGreaterThan(0);
    expect(authMiddlewareIndex).toBeGreaterThan(0);
    expect(resetRouteIndex).toBeLessThan(authMiddlewareIndex);
  });

  it('serves the reset document with cache-bypass headers', () => {
    const routeBlock = apiSource.slice(
      apiSource.indexOf("router.get('/client-reset'"),
      apiSource.indexOf('// ───── Public: health ─────'),
    );

    expect(routeBlock).toContain("Content-Type', 'text/html; charset=utf-8'");
    expect(routeBlock).toContain("Cache-Control', 'no-store, no-cache, must-revalidate'");
    expect(routeBlock).toContain("CDN-Cache-Control', 'no-store'");
    expect(routeBlock).toContain("Cloudflare-CDN-Cache-Control', 'no-store'");
    expect(routeBlock).toContain("Pragma', 'no-cache'");
    expect(routeBlock).toContain("Expires', '0'");
    expect(routeBlock).toContain("X-Robots-Tag', 'noindex, nofollow'");
  });

  it('unregisters Service Workers, deletes Cache Storage, and clears reload-loop guards', () => {
    expect(apiSource).toContain('navigator.serviceWorker.getRegistrations()');
    expect(apiSource).toContain('reg.unregister()');
    expect(apiSource).toContain('caches.keys()');
    expect(apiSource).toContain('caches.delete(key)');
    expect(apiSource).toContain("sessionStorage.removeItem('tower:reload-once')");
    expect(apiSource).toContain("sessionStorage.removeItem('tower:reload-reason')");
  });

  it('allows only same-origin path redirects back to a session deep link', () => {
    expect(apiSource).toContain("params.get('returnTo') || params.get('to') || '/'");
    expect(apiSource).toContain("raw.charAt(0) !== '/'");
    expect(apiSource).toContain("raw.indexOf('//') === 0");
    expect(apiSource).toContain('url.origin !== location.origin');
    expect(apiSource).toContain("url.searchParams.set('__tower_client_reset'");
    expect(apiSource).toContain('location.replace(target)');
  });
});

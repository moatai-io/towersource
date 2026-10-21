import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');

describe('development boot recovery contract', () => {
  it('unregisters stale service workers and app-shell caches on development hosts', () => {
    expect(html).toContain("var cleanupKey = 'tower:dev-sw-cleanup-v1'");
    expect(html).toContain('navigator.serviceWorker.getRegistrations()');
    expect(html).toContain('reg.unregister()');
    expect(html).toContain("key.indexOf('workbox-precache') === 0");
    expect(html).toContain("key.indexOf('js-runtime-cache') !== -1");
    expect(html).toContain("url.searchParams.delete('__tower_reload')");
  });

  it('disables the cache-busting boot watchdog on development hosts', () => {
    expect(html).toContain("location.hostname === 'app.localhost'");
    expect(html).toContain("location.hostname.indexOf('desk-dev.') === 0");
    expect(html).toContain('if (isDevHost) return;');

    const devGuard = html.indexOf('if (isDevHost) return;');
    const reloadParam = html.indexOf("url.searchParams.set('__tower_reload'");
    expect(devGuard).toBeGreaterThan(-1);
    expect(reloadParam).toBeGreaterThan(devGuard);
  });
});

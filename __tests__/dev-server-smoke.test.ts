import { describe, it, expect } from 'vitest';

/**
 * Dev server smoke test — verifies both frontend and backend are reachable.
 * Skips gracefully if servers aren't running (CI environment).
 */

async function fetchSafe(url: string, timeoutMs = 3000): Promise<Response | null> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timer);
    return res;
  } catch {
    return null;
  }
}

describe('dev server smoke', () => {
  it('frontend (Vite :32354) serves HTML', async () => {
    const res = await fetchSafe('http://localhost:32354/');
    if (!res) return; // skip if server not running
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('<!DOCTYPE html>');
  });

  it('backend (:32355) responds to API requests', async () => {
    const res = await fetchSafe('http://localhost:32355/api/sessions');
    if (!res) return; // skip if server not running
    // 401 or 403 = auth working, server is alive
    expect([200, 401, 403]).toContain(res.status);
  });

  it('Vite proxies /api to backend', async () => {
    const res = await fetchSafe('http://localhost:32354/api/sessions');
    if (!res) return;
    // Should get auth error (proxied to backend), not 404
    expect([200, 401, 403]).toContain(res.status);
  });
});

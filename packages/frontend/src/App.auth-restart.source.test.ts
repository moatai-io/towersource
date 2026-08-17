import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';

const APP_PATH = path.resolve(import.meta.dirname, './App.tsx');

describe('App restart-tolerant authentication contracts', () => {
  it('keeps the browser token through the Nix restart recovery window', () => {
    const src = fs.readFileSync(APP_PATH, 'utf-8');
    expect(src).toMatch(/async function fetchWithRestartTolerantAuth/);
    expect(src).toContain('AUTH_401_RETRY_DELAYS_MS = [1_000, 2_000, 4_000, 8_000]');
    expect(src).toMatch(/for \(const delayMs of AUTH_401_RETRY_DELAYS_MS\)/);
    expect(src).toMatch(/if \(response\.status !== 401\) return response/);
    expect(src).toMatch(/fetchWithRestartTolerantAuth\(`\$\{API_BASE\}\/sessions\?limit=\$\{STARTUP_SESSION_LIST_LIMIT\}`/);
  });

  it('does not clear authentication on a transient public auth-status limiter response', () => {
    const src = fs.readFileSync(APP_PATH, 'utf-8');
    const limiterBranch = src.match(/if \(r\.status === 429\) \{([\s\S]*?)\n        \}/)?.[1] || '';
    expect(limiterBranch).not.toContain("localStorage.removeItem('token')");
    expect(limiterBranch).not.toContain('setToken(null)');
  });
});

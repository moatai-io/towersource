import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');
it('awaits logout before clearing credentials and rebuilding the shell', () => {
  const app = read('../App.tsx');
  const start = app.indexOf('const handleLogout =');
  const end = app.indexOf('useSessionEventNavigation', start);
  const logout = app.slice(start, end);
  expect(logout).toContain('await confirmAccountTransition');
  expect(logout.indexOf('await fetch')).toBeLessThan(logout.indexOf('clearCredentialIfCurrent(token)'));
  expect(logout).toContain('if (!response.ok) throw');
  expect(logout).toContain('restartAccountShell()');
  expect(app).toContain("window.addEventListener('storage', storage)");
  expect(app).toContain("window.removeEventListener('storage', storage)");
});
it('pins delayed tab persistence to the owner at module initialization', () => {
  const source = read('../stores/file-store.ts');
  expect(source).toContain('const tabsOwnerKey = getTabsKey()');
  expect(source).toContain('localStorage.setItem(tabsOwnerKey, JSON.stringify(slim))');
});

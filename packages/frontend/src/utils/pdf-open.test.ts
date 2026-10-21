// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { buildPdfServeUrl, isPdfPath, openPdfInBrowserTab } from './pdf-open';
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); localStorage.clear(); });
it.each(['', 'https://tower.example.com/'])('builds encoded file URLs with base %s', base => {
  vi.stubEnv('VITE_API_URL', base);
  localStorage.setItem('token', 'synthetic+a&b');
  const result = buildPdfServeUrl('/reports/a & 한글.pdf', { download: true, revision: 'r&1' });
  const url = new URL(result, 'https://app.localhost');
  expect(result.startsWith(`${base.replace(/\/$/, '')}/api/files/serve?`)).toBe(true);
  expect(url.searchParams.get('path')).toBe('/reports/a & 한글.pdf');
  expect(url.searchParams.get('token')).toBe('synthetic+a&b');
  expect(url.searchParams.get('download')).toBe('1');
  expect(url.searchParams.get('v')).toBe('r&1');
});
it('can omit the token and does not cache it', () => {
  localStorage.setItem('token', 'synthetic');
  expect(buildPdfServeUrl('a.pdf', { includeToken: false })).not.toContain('token=');
  localStorage.removeItem('token');
  expect(buildPdfServeUrl('a.pdf')).not.toContain('token=');
});
it('keeps top-level PDF opening isolated from the opener', () => {
  const open = vi.spyOn(window, 'open').mockReturnValue(null);
  openPdfInBrowserTab('a.pdf');
  expect(open).toHaveBeenCalledWith(buildPdfServeUrl('a.pdf'), '_blank', 'noopener,noreferrer');
  expect(isPdfPath('a.PDF?download=1')).toBe(true);
  expect(isPdfPath('a.png')).toBe(false);
});

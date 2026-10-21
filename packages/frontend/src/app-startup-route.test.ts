import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { shouldPreloadApp } from './app-startup-route';

describe('App startup download boundary', () => {
  it.each(['/', '/s/abc', '/r/abc', '/rooms/abc', '/s/abc/'])('starts App early for %s', (path) => {
    expect(shouldPreloadApp(path, '')).toBe(true);
  });
  it.each(['/file-viewer', '/f/abc', '/meeting-recorder', '/shared/abc', '/ai/abc', '/ai-service-chat/abc', '/voice-lab', '/invalid-link', '/unknown'])('keeps %s independent', (path) => {
    expect(shouldPreloadApp(path, '')).toBe(false);
  });
  it.each(['passwordReset', 'accountInvitation', 'accountEmailVerification'])('does not preload App for %s', (key) => {
    expect(shouldPreloadApp('/', `?${key}=fixture`)).toBe(false);
  });
  it('downloads App before waiting for language resources, then renders translated UI', () => {
    const main = readFileSync(new URL('./main.tsx', import.meta.url), 'utf8');
    const locale = readFileSync(new URL('./i18n.ts', import.meta.url), 'utf8');
    expect(main.indexOf('const appStartup =')).toBeLessThan(main.indexOf('await i18nReady;'));
    expect(main.indexOf('await i18nReady;')).toBeLessThan(main.indexOf('ReactDOM.createRoot'));
    expect(main).toContain('appStartup ?? loadApp()');
    expect(locale).toContain('export const i18nReady =');
    expect(locale).not.toContain('await i18n.use(');
  });
  it('does not preload decorative fonts while retaining swap rendering', () => {
    const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
    expect(html).not.toMatch(/<link[^>]+rel="preload"[^>]+as="font"/);
    expect(html).toContain('font-display: swap');
  });
});

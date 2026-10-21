import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const app = fs.readFileSync(path.resolve(import.meta.dirname, './App.tsx'), 'utf8');
const bootstrap = fs.readFileSync(path.resolve(import.meta.dirname, './hooks/useAppBootstrap.ts'), 'utf8');
const styles = fs.readFileSync(path.resolve(import.meta.dirname, './index.css'), 'utf8');

describe('optional app background boot contract', () => {
  it('starts without a background and only loads configured customer branding', () => {
    expect(bootstrap).toContain('useState<string | null>(null)');
    expect(app).not.toContain('towerBg');
    expect(app).not.toContain('tower-bg.png');
    expect(bootstrap).toContain("fetch(towerHttpUrl('/api/branding/status'), { cache: 'no-store' })");
    expect(bootstrap).toContain('status?.appBackgroundConfigured');
    expect(bootstrap).toContain('setAppBackgroundSrc(CUSTOM_APP_BACKGROUND_SRC)');
  });
  it('makes only the branded chat surface translucent in both themes', () => {
    expect(app).toContain("appBackgroundSrc && activeView === 'chat' ? ' tower-branded-chat-surface' : ''");
    expect(styles).toMatch(/:root\[data-theme="light"\] \.tower-main-content-surface \{[^}]*background: var\(--th-bg-primary\)/);
    expect(styles).toMatch(/:root\[data-theme="light"\] \.tower-main-content-surface\.tower-branded-chat-surface \{[^}]*background: rgba\(255, 255, 255, 0\.12\)/);
    expect(styles).toMatch(/:root\[data-theme="dark"\] \.tower-main-content-surface\.tower-branded-chat-surface,[^}]*background: rgba\(36, 40, 50, 0\.12\);[^}]*backdrop-filter: none/);
  });
  it('guards desktop and mobile images and removes failed customer images', () => {
    expect(app).toContain('appBackgroundSrc && activeTabId === null');
    expect(app).toContain('appBackgroundSrc && !activeSystemTabId');
    expect(app.match(/onError=\{clearAppBackground\}/g)).toHaveLength(2);
    expect(app.match(/object-contain opacity-\[0\.04\]/g)).toHaveLength(2);
  });
});

import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const app = fs.readFileSync(path.resolve(import.meta.dirname, './App.tsx'), 'utf8');

describe('optional app background boot contract', () => {
  it('keeps the bundled background until the optional VM image is confirmed', () => {
    expect(app).toContain('useState(towerBg)');
    expect(app).toContain("fetch('/api/branding/status', { cache: 'no-store' })");
    expect(app).toContain('status?.appBackgroundConfigured');
    expect(app).toContain('setAppBackgroundSrc(CUSTOM_APP_BACKGROUND_SRC)');
  });
});

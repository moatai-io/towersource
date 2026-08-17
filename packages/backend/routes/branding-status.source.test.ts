import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const api = fs.readFileSync(path.resolve(import.meta.dirname, './api.ts'), 'utf8');

describe('public branding capability contract', () => {
  it('reports optional image availability with an always-successful status route', () => {
    expect(api).toContain("router.get('/branding/status'");
    expect(api).toContain('loginBackgroundConfigured: !!resolvePublicBrandImage(config.loginBackgroundImage)');
    expect(api).toContain('appBackgroundConfigured: !!resolvePublicBrandImage(config.appBackgroundImage)');
    expect(api).toContain("router.get('/branding/app-background'");
  });
});

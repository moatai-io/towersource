import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '../../../..');
const read = (path: string) => readFileSync(resolve(root, path), 'utf8');

describe('Korean installation language defaults', () => {
  it('ships Korean UI and AI defaults in the OSS installer and environment example', () => {
    for (const path of ['scripts/oss/install.sh', '.env.example']) {
      const source = read(path);
      expect(source).toMatch(/^TOWER_DEFAULT_LANGUAGE=ko$/m);
      expect(source).toMatch(/^WORKSPACE_LANGUAGE=ko$/m);
    }
  });

  it('keeps provisioning and managed bootstrap defaults Korean', () => {
    const provisioning = read('scripts/nix-app/prepare-provisioning-host');
    expect(provisioning).toContain("'WORKSPACE_LANGUAGE':'ko'");
    expect(read('scripts/azure/bootstrap-prod.sh')).toContain('set_env_value .env TOWER_DEFAULT_LANGUAGE ko');
  });

  it('serves Korean by default while preserving explicit English configuration', () => {
    for (const [path, variable] of [
      ['packages/backend/index.ts', 'process.env'],
      ['packages/backend/artifact-shadow.ts', 'env'],
    ]) {
      expect(read(path)).toContain(`${variable}.TOWER_DEFAULT_LANGUAGE === 'en' ? 'en' : 'ko'`);
    }
    expect(read('packages/frontend/public/runtime-config.js')).toContain("defaultLanguage: 'ko'");
  });

  it.each([
    [null, undefined, 'ko'],
    [null, 'ko', 'ko'],
    [null, 'en', 'en'],
    ['en', 'ko', 'en'],
    ['ko', 'en', 'ko'],
    ['fr', 'de', 'ko'],
  ])('sets pre-render HTML language for saved=%s configured=%s', (saved, configured, expected) => {
    const html = read('packages/frontend/index.html');
    expect(html).toContain('<html lang="ko">');
    const script = html.match(/<script>\s*([\s\S]*?)<\/script>/)?.[1];
    expect(script).toBeTruthy();
    const document = { documentElement: { lang: '' } };
    vm.runInNewContext(script!, {
      localStorage: { getItem: () => saved },
      window: { __TOWER_RUNTIME_CONFIG__: { defaultLanguage: configured } },
      document,
    });
    expect(document.documentElement.lang).toBe(expected);
  });
});

import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const source = fs.readFileSync(path.resolve(import.meta.dirname, './AdminPanel.tsx'), 'utf8');
const locale = (language: 'en' | 'ko') => JSON.parse(fs.readFileSync(path.resolve(import.meta.dirname, `../../locales/${language}/admin.json`), 'utf8'));

describe('Admin Panel compact navigation contract', () => {
  it('uses short top-level labels', () => {
    for (const key of ['users', 'agents', 'usage', 'ai', 'connections', 'system']) expect(source).toContain(`t('navigation.${key}')`);
    expect(source).toContain("renderTab('runtime', t('runtimeBoxTab'))");
    for (const language of ['en', 'ko'] as const) for (const value of Object.values(locale(language).navigation) as string[]) expect(value.length).toBeLessThanOrEqual(12);
  });

  it('uses compact direct Connection action labels', () => {
    for (const language of ['en', 'ko'] as const) {
      const labels = locale(language).credentialConnections;
      for (const key of ['replace', 'enable', 'disable', 'delete']) expect(labels[key].length).toBeLessThanOrEqual(12);
    }
    for (const key of ['replace', 'enable', 'disable', 'delete']) expect(source).toContain(`t('credentialConnections.${key}')`);
  });

  it('keeps top-level navigation and Connection cards responsive', () => {
    expect(source).toContain('shrink-0 whitespace-nowrap px-3 py-2');
    expect(source).toContain('flex shrink-0 overflow-x-auto');
    expect(source).toContain('px-2 sm:px-6');
    expect(source).toContain('space-y-3');
    expect(source).toContain('flex flex-wrap gap-2');
  });
});

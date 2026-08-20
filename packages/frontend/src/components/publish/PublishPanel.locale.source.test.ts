import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const en = JSON.parse(readFileSync(new URL('../../locales/en/common.json', import.meta.url), 'utf8'));
const ko = JSON.parse(readFileSync(new URL('../../locales/ko/common.json', import.meta.url), 'utf8'));

function leafPaths(value: unknown, prefix = ''): string[] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [prefix];
  return Object.entries(value as Record<string, unknown>).flatMap(([key, child]) => leafPaths(child, prefix ? `${prefix}.${key}` : key));
}

describe('Publishing Hub locale contract', () => {
  it('ships matching English and Korean publishing keys', () => {
    expect(leafPaths(en.publish).sort()).toEqual(leafPaths(ko.publish).sort());
  });
});

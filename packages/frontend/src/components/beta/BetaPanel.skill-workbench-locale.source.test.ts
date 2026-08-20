import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const source = fs.readFileSync(path.resolve(import.meta.dirname, './BetaPanel.tsx'), 'utf8');
const en = JSON.parse(fs.readFileSync(path.resolve(import.meta.dirname, '../../locales/en/skills.json'), 'utf8'));
const ko = JSON.parse(fs.readFileSync(path.resolve(import.meta.dirname, '../../locales/ko/skills.json'), 'utf8'));

function leafPaths(value: unknown, prefix = ''): string[] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [prefix];
  return Object.entries(value as Record<string, unknown>).flatMap(([key, child]) => leafPaths(child, prefix ? `${prefix}.${key}` : key));
}

describe('Skill Workbench locale contract', () => {
  it('localizes workbench states, form labels, actions, and empty states', () => {
    expect(source).toContain("useTranslation('skills')");
    expect(source).toContain("t('workbench.title')");
    expect(source).toContain("t('workbench.promptPlaceholder')");
    expect(source).toContain("t('workbench.runComparison')");
    expect(source).toContain("t('workbench.emptyCases')");
  });

  it('ships matching English and Korean workbench keys', () => {
    expect(leafPaths(en.workbench).sort()).toEqual(leafPaths(ko.workbench).sort());
  });
});

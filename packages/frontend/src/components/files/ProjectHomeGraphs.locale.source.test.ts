import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const overview = fs.readFileSync(path.resolve(import.meta.dirname, '../agents/AgentHomeOverview.tsx'), 'utf8');
const knowledgeGraph = fs.readFileSync(path.resolve(import.meta.dirname, './WorkspaceKnowledgeGraph.tsx'), 'utf8');
const activityGraph = fs.readFileSync(path.resolve(import.meta.dirname, './ProjectActivityGraph.tsx'), 'utf8');
const en = JSON.parse(fs.readFileSync(path.resolve(import.meta.dirname, '../../locales/en/files.json'), 'utf8'));
const ko = JSON.parse(fs.readFileSync(path.resolve(import.meta.dirname, '../../locales/ko/files.json'), 'utf8'));

function leafPaths(value: unknown, prefix = ''): string[] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [prefix];
  return Object.entries(value as Record<string, unknown>).flatMap(([key, child]) => leafPaths(child, prefix ? `${prefix}.${key}` : key));
}

describe('Project Home overview and graph locale contract', () => {
  it('connects all three surfaces to the files namespace', () => {
    expect(overview).toContain("useTranslation('files')");
    expect(overview).toContain('lang={i18n.resolvedLanguage||i18n.language}');
    expect(knowledgeGraph).toContain("useTranslation('files')");
    expect(activityGraph).toContain("useTranslation('files')");
  });

  it('ships matching English and Korean locale trees', () => {
    for (const section of ['agentHome', 'knowledgeGraph', 'activityGraph']) {
      expect(leafPaths(en[section]).sort()).toEqual(leafPaths(ko[section]).sort());
    }
  });
});

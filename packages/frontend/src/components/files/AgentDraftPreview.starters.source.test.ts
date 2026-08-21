import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const source = fs.readFileSync(path.resolve(import.meta.dirname, './AgentDraftPreview.tsx'), 'utf8');
const ko = JSON.parse(fs.readFileSync(path.resolve(import.meta.dirname, '../../locales/ko/files.json'), 'utf8'));
const en = JSON.parse(fs.readFileSync(path.resolve(import.meta.dirname, '../../locales/en/files.json'), 'utf8'));

describe('Primary Agent starter roster', () => {
  it('offers four public-safe starting roles with curated character faces', () => {
    for (const id of ['research', 'editor', 'operations', 'guide']) expect(source).toContain(`id: '${id}'`);
    for (const character of ['korean-diverse-1', 'core-editor', 'korean-diverse-2', 'korean-diverse-10']) expect(source).toContain(character);
  });

  it('fills face, name, and expected expertise without creating automatically', () => {
    expect(source).toContain('updateDraft({ face: `character:${starter.characterId}`');
    expect(source).toContain('expectedExpertise: t(starter.expertiseKey)');
    expect(source).not.toContain('onClick={() => createAgent(');
  });

  it('ships Korean and English starter explanations', () => {
    expect(Object.keys(ko.agentCreation.starters)).toEqual(expect.arrayContaining(['research', 'editor', 'operations', 'guide']));
    expect(Object.keys(en.agentCreation.starters)).toEqual(expect.arrayContaining(['research', 'editor', 'operations', 'guide']));
  });
});

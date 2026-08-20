import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const checkpoint = fs.readFileSync(path.resolve(import.meta.dirname, './TurnCheckpointCard.tsx'), 'utf8');
const voice = fs.readFileSync(path.resolve(import.meta.dirname, './VoiceConversationButton.tsx'), 'utf8');
const en = JSON.parse(fs.readFileSync(path.resolve(import.meta.dirname, '../../locales/en/chat.json'), 'utf8'));
const ko = JSON.parse(fs.readFileSync(path.resolve(import.meta.dirname, '../../locales/ko/chat.json'), 'utf8'));

function leafPaths(value: unknown, prefix = ''): string[] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [prefix];
  return Object.entries(value as Record<string, unknown>).flatMap(([key, child]) => leafPaths(child, prefix ? `${prefix}.${key}` : key));
}

describe('chat recovery and voice locale contract', () => {
  it('connects both chat surfaces to chat translations', () => {
    expect(checkpoint).toContain("useTranslation('chat')");
    expect(checkpoint).toContain("t('checkpoint.checkChanges')");
    expect(voice).toContain("useTranslation('chat')");
    expect(voice).toContain("t('voice.stage.startRequest')");
    expect(voice).toContain("t('voice.output'");
  });

  it('ships matching English and Korean locale trees', () => {
    for (const section of ['checkpoint', 'voice']) {
      expect(leafPaths(en[section]).sort()).toEqual(leafPaths(ko[section]).sort());
    }
  });
});

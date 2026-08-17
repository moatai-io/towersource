import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = readFileSync(new URL('./ContextPanel.tsx', import.meta.url), 'utf8');

describe('ContextPanel personal note title editor', () => {
  it('shows an inline title field only for personal files', () => {
    expect(source).toContain("aria-label={t('personalNoteTitleAndFilename')}");
    expect(source).toContain("title={t('noteTitleRenamesFile')}");
    expect(source).toContain("{t('noteTitle')}");
    expect(source).toContain("placeholder={t('enterNoteTitle')}");
    expect(source).toContain('>.md</span>');
    expect(source).toContain('group-focus-within/title:ring-2');
  });

  it('commits on blur or Enter and restores on Escape', () => {
    expect(source).toContain('commitPersonalTitle');
    expect(source).toContain("event.key === 'Enter'");
    expect(source).toContain("event.key === 'Escape'");
    expect(source).toContain('onRenamePersonalFile(openFile.path, nextTitle)');
  });
});

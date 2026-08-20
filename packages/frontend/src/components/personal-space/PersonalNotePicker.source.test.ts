import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = readFileSync(new URL('./PersonalNotePicker.tsx', import.meta.url), 'utf8');

describe('PersonalNotePicker source contract', () => {
  it('lists owner-scoped personal files and supports search', () => {
    expect(source).toContain("fetch('/api/personal-space/files'");
    expect(source).toContain("placeholder={t('personalNotePicker.searchPlaceholder')}");
    expect(source).toContain('note.relativePath');
  });

  it('offers both open and create flows', () => {
    expect(source).toContain('onOpen(note.uri)');
    expect(source).toContain("t('personalNotePicker.newNote')");
  });
});

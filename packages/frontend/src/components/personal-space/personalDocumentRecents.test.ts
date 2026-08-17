import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readRecentPersonalDocumentUris, recordRecentPersonalDocument } from './personalDocumentRecents';

const values = new Map<string, string>();

beforeEach(() => {
  values.clear();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
  });
});

describe('personal document recents', () => {
  it('moves a Viewer-opened document to the front without duplicates', () => {
    recordRecentPersonalDocument('personal://notes/a.md');
    recordRecentPersonalDocument('personal://files/b.pdf');
    recordRecentPersonalDocument('personal://notes/a.md');
    expect(readRecentPersonalDocumentUris()).toEqual(['personal://notes/a.md', 'personal://files/b.pdf']);
  });

  it('keeps at most twenty document URIs', () => {
    for (let index = 0; index < 24; index += 1) recordRecentPersonalDocument(`personal://notes/${index}.md`);
    expect(readRecentPersonalDocumentUris()).toHaveLength(20);
    expect(readRecentPersonalDocumentUris()[0]).toBe('personal://notes/23.md');
  });
});

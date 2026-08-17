import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readMobileDocumentRecents, recordMobileDocumentRecent } from './mobileDocumentRecents';

const values = new Map<string, string>();

beforeEach(() => {
  values.clear();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
  });
  vi.stubGlobal('window', { dispatchEvent: vi.fn() });
});

describe('mobile document recents', () => {
  it('keeps mobile-opened files newest first without duplicates', () => {
    recordMobileDocumentRecent('/workspace/a.md', 'a.md');
    recordMobileDocumentRecent('/workspace/b.md', 'b.md');
    recordMobileDocumentRecent('/workspace/a.md', 'a.md');
    expect(readMobileDocumentRecents().map((item) => item.path)).toEqual(['/workspace/a.md', '/workspace/b.md']);
  });

  it('keeps at most eight documents', () => {
    for (let index = 0; index < 10; index += 1) recordMobileDocumentRecent(`/workspace/${index}.md`);
    expect(readMobileDocumentRecents()).toHaveLength(8);
  });
});

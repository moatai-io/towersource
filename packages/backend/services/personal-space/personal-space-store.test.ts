import { describe, expect, it } from 'vitest';
import { buildInboxAppendContent, normalizePersonalPath, personalFilesRoot, toPersonalUri } from './personal-space-store.js';

describe('personal-space path boundary', () => {
  it('normalizes a personal virtual URI without exposing host paths', () => {
    expect(normalizePersonalPath('personal://notes/ideas/test.md')).toBe('notes/ideas/test.md');
    expect(toPersonalUri('notes/ideas/test.md')).toBe('personal://notes/ideas/test.md');
  });

  it.each([
    '',
    '..',
    '../secret.md',
    'notes/../../secret.md',
    'personal://../secret.md',
    '/absolute.md',
    'personal:///absolute.md',
    '/',
  ])('rejects storage escape path %j', (value) => {
    expect(() => normalizePersonalPath(value)).toThrow();
  });

  it('separates physical roots by owner user id', () => {
    expect(personalFilesRoot(11)).not.toBe(personalFilesRoot(12));
    expect(personalFilesRoot(11)).toContain('/personal-spaces/11/files');
  });

  it('appends bullets under one dated heading and supports checklists', () => {
    const first = buildInboxAppendContent('# Inbox\n\n', '첫 메모', false, '2026-07-10');
    const second = buildInboxAppendContent(first, '다음 할 일', true, '2026-07-10');
    expect(second.match(/## 2026-07-10/g)).toHaveLength(1);
    expect(second).toContain('- 첫 메모');
    expect(second).not.toContain('source-session');
    expect(second).toContain('- [ ] 다음 할 일');
  });
});

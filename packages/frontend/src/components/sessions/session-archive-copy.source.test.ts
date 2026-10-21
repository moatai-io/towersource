import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
const read = (path: string) => fs.readFileSync(new URL(path, import.meta.url), 'utf8');
describe('Enterprise session archive vocabulary', () => {
  it.each(['ko', 'en'])('uses archive semantics consistently (%s)', lang => {
    const labels = JSON.parse(read(`../../locales/${lang}/layout.json`));
    const expected = lang === 'ko' ? '보관' : /archive/i;
    for (const key of ['sessionTrash', 'sessionTrashRestore', 'sessionTrashMoved', 'includeArchivedSessions']) {
      if (typeof expected === 'string') expect(labels[key]).toContain(expected);
      else expect(labels[key]).toMatch(expected);
      expect(labels[key]).not.toMatch(/휴지통|삭제|trash|delete/i);
    }
  });
  it('labels Korean session list actions as delete while retaining English archive labels', () => {
    const ko = JSON.parse(read('../../locales/ko/layout.json'));
    const en = JSON.parse(read('../../locales/en/layout.json'));
    for (const key of ['deleteSession', 'hideSession']) {
      expect(ko[key]).toBe('세션 삭제');
      expect(en[key]).toMatch(/archive/i);
    }
  });
  it('uses trash icons for delete actions while preserving explicit archive and down icons', () => {
    const item = read('./SessionItem.tsx');
    const sidebar = read('../layout/Sidebar.tsx');
    expect(item.match(/deleteActionIcon = "trash"/g)).toHaveLength(2);
    expect(item.match(/deleteActionIcon === "archive"/g)).toHaveLength(2);
    expect(item.match(/M3 6h18M9 6V4h6v2M5 6l1 14h12l1-14M10 10v6M14 10v6/g)).toHaveLength(2);
    expect(sidebar).toContain('deleteActionIcon="trash"');
    expect(sidebar).not.toContain('deleteActionIcon="archive"');
    expect(item).toContain('deleteActionIcon === "down"');
  });
  it('uses the explicit archive endpoint and a non-destructive confirmation', () => {
    const lifecycle = read('../../hooks/useSessionLifecycle.ts');
    const handler = lifecycle.slice(lifecycle.indexOf('const handleDeleteSession ='), lifecycle.indexOf('const patchSession ='));
    expect(handler).toContain('/sessions/${id}/archive');
    expect(handler).toContain('danger: false');
    expect(handler).toContain('tower-open-session-archive');
  });
  it('hydrates archive titles before selection and never replays old file presentations', () => {
    const selection = read('../../hooks/useSessionSelection.ts');
    const start = selection.indexOf('const handleSelectSession =');
    const handler = selection.slice(start, selection.indexOf('return handleSelectSession', start));
    expect(handler).toContain('if (session.archived) useSessionStore.getState().mergeSessions([session])');
    expect(handler.indexOf('mergeSessions([session])')).toBeLessThan(handler.indexOf('openChatTab(session.id)'));
    expect(handler).toContain('const replayPresentFile = false');
    expect(handler).not.toContain('replayPresentFile: true');
    expect(handler.match(/setMessages\([^;]+\{ replayPresentFile \}/g)).toHaveLength(3);
  });

});

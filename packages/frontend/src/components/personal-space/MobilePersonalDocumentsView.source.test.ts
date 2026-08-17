import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const view = readFileSync(new URL('./MobilePersonalDocumentsView.tsx', import.meta.url), 'utf8');
const context = readFileSync(new URL('../layout/ContextPanel.tsx', import.meta.url), 'utf8');
const app = readFileSync(new URL('../../App.tsx', import.meta.url), 'utf8');
const header = readFileSync(new URL('../layout/Header.tsx', import.meta.url), 'utf8');

describe('Mobile personal documents', () => {
  it('opens a mobile reading-first document home from the hamburger menu', () => {
    expect(header).toContain("label={isMobile ? '내 문서' : '내 자료'}");
    expect(app).toContain("mobile ? 'personal://documents' : 'personal://materials'");
    expect(context).toContain("openFile?.path === 'personal://documents'");
    expect(context).toContain('return <MobilePersonalDocumentsView />');
  });

  it('shows pinned and recent documents with direct open actions', () => {
    for (const copy of ['내 문서', '자주 보는 문서', '최근 문서', '내 문서 검색', '전체 내 파일 보기']) expect(view).toContain(copy);
    expect(view).not.toContain('내 Todo');
    expect(view).toContain('PERSONAL_DOCUMENT_PINS_KEY');
    expect(view).toContain('readRecentPersonalDocumentUris');
    expect(view).toContain('importLocalPersonalDocumentPreferences()');
    expect(view).toContain('loadPersonalDocumentPreferences()');
    expect(view).toContain('setServerPersonalDocumentPinned(uri, pinned)');
    expect(view).toContain('recordServerPersonalDocumentOpened(document.uri)');
    expect(view).toContain('recordRecentPersonalDocument(document.uri)');
    expect(view).toContain('togglePinned(document.uri)');
    expect(view).toContain('openPersonalPath(document.uri)');
  });

  it('keeps full file management available as a secondary mobile screen', () => {
    expect(view).toContain("openPersonalPath('personal://materials')");
    expect(app).toContain("store.openTab('personal://materials'");
    expect(app).toContain("name: '내 파일'");
  });
});

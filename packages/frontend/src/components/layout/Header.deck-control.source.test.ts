import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const header = fs.readFileSync(path.resolve(__dirname, 'Header.tsx'), 'utf8');
const sidebar = fs.readFileSync(path.resolve(__dirname, 'Sidebar.tsx'), 'utf8');
const sessionItem = fs.readFileSync(path.resolve(__dirname, '../sessions/SessionItem.tsx'), 'utf8');

describe('active session deck controls', () => {
  it('shows and updates the active session deck from the app header', () => {
    expect(header).toContain('function ActiveSessionDeckControl');
    expect(header).toContain("t('assignCurrentSessionToDeck')");
    expect(header).toContain('activeSessionLabel');
    expect(header).toContain('body: JSON.stringify({ label: nextLabel })');
    expect(header).toContain('updateSessionMeta(sessionId, { label: previousLabel })');
    expect(header).toContain("toastError(t('deckAssignmentFailed'))");
  });

  it('reserves mobile header space for the session title while keeping the desktop deck control', () => {
    expect(header).toMatch(/\{!isMobile && !activeFileTab\?\.path && activeSessionId && activeSessionProjectId && \(\s*<ActiveSessionDeckControl/);
    expect(header).toContain('!isMobile && <NavTabs');
  });

  it('removes the ambiguous Default organizer entry point', () => {
    expect(sidebar).not.toContain('function DefaultDeckOrganizer');
    expect(sidebar).not.toContain("t('organize')");
  });

  it('keeps deck navigation compact, expands in batches, and opens the full directory', () => {
    expect(sidebar).toContain("t('sessionCountShort'");
    expect(sidebar).toContain('sessions.slice(0, visibleCount)');
    expect(sidebar).toContain('const LABEL_LOAD_BATCH = 20');
    expect(sidebar).toContain("t('viewMoreSessions'");
    expect(sidebar).toContain("t('showOnlyRecentSessions'");
    expect(sidebar).toContain('setVisibleCount(LABEL_PREVIEW_COUNT)');
    expect(sidebar).toContain("new CustomEvent('tower-open-session-directory'");
    expect(sidebar).toContain("t('viewAllSessions'");
    expect(sidebar).toContain("t('openDeckActions'");
    expect(sidebar).toContain('setCtxMenu({ x: rect.right, y: rect.bottom + 4 })');
  });

  it('moves deck assignment into a searchable context-menu submenu', () => {
    expect(sessionItem).toContain('function SessionDeckSubmenu');
    expect(sessionItem).toContain('aria-haspopup="menu"');
    expect(sessionItem).toContain('t("moveToDeck")');
    expect(sessionItem).toContain('t("searchDecks")');
    expect(sessionItem).toContain('max-h-[220px] overflow-y-auto');
    expect(sessionItem).toContain('hydrateProjectSessions(session.projectId, { force: true })');
    expect(sessionItem).toContain('projectSessionsLoading');
    expect(sessionItem).not.toContain('function SessionDeckFlat');
  });

  it('separates removing a deck classification from archiving its sessions', () => {
    expect(sidebar).toContain("patchSessions({ label: null })");
    expect(sidebar).toContain("t('removeDeckClassification')");
    expect(sidebar).toContain("t('archiveDeckSessions')");
    expect(sidebar).toContain("method: 'DELETE'");
  });
});

import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

const source = fs.readFileSync(path.resolve(import.meta.dirname, './App.tsx'), 'utf8');
const lifecycle = fs.readFileSync(path.resolve(import.meta.dirname, './hooks/useSessionLifecycle.ts'), 'utf8');
const mobileSidebarStart = source.indexOf('{sidebarOpen && isMobile');
const mobileSidebarEnd = source.indexOf('{sidebarOpen && !isMobile', mobileSidebarStart);
const mobileSidebarBlock = source.slice(mobileSidebarStart, mobileSidebarEnd);

describe('mobile sidebar visual hierarchy', () => {
  it('dims and softly blurs the workspace behind the drawer', () => {
    expect(source).toContain('bg-black/55 backdrop-blur-[1.5px]');
    expect(source).toContain("sidebarTab === 'files' ? 'min(82vw, 340px)' : '85vw'");
  });

  it('does not reopen the mobile drawer after creating a new conversation', () => {
    expect(lifecycle).toContain('Do not reopen the');
    expect(lifecycle).toContain('if (!useSessionStore.getState().isMobile)');
    expect(lifecycle).toContain('useSessionStore.getState().setSidebarOpen(true);');
  });

  it('covers the previous conversation while mobile session creation is pending', () => {
    expect(lifecycle).toContain('const [newSessionCreating, setNewSessionCreating] = useState(false);');
    expect(lifecycle).toContain('const newSessionCreatingRef = useRef(false);');
    expect(lifecycle).toContain('newSessionCreatingRef.current = true;');
    expect(lifecycle).toContain('newSessionCreatingRef.current = false;');
    expect(source).toContain('const mobileSessionLoadingSurface = newSessionCreating ?');
    expect(source).toContain('mobileSessionLoading={mobileSessionLoadingSurface}');
    expect(source).toContain('data-testid="new-session-loading"');
    expect(source).toContain("t('layout:preparingNewSession')");
    expect(mobileSidebarBlock).toContain("useSessionStore.getState().setActiveView('chat');");
    expect(mobileSidebarBlock).toContain('void handleNewSession(projectId, label);');
  });

  it('keeps the previous session selected and reports an error when creation fails', () => {
    expect(lifecycle).toContain("toastError(t('layout:newSessionCreateFailed'))");
    expect(lifecycle).toContain('if (!session) {');
  });

  it('keeps the mobile app shell height-owned so content scroll does not move fixed chrome', () => {
    expect(source).toContain('<div className="flex min-h-0 flex-1 overflow-hidden">');
    expect(source).toContain('<main className="flex min-h-0 min-w-0 flex-1 justify-center">');
  });

  it('closes the drawer after mobile file-sidebar actions that open content', () => {
    expect(mobileSidebarBlock).toContain('void handleNewSessionInFolder(path);');
    expect(mobileSidebarBlock).toContain("useSessionStore.getState().setMobileTab('ai');");
    expect(mobileSidebarBlock).toContain('handlePromptClick(prompt);');
    expect(mobileSidebarBlock).toContain('useSessionStore.getState().openMobileContext();');
  });
});

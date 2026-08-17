import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

const source = fs.readFileSync(path.resolve(import.meta.dirname, './App.tsx'), 'utf8');
const mobileSidebarStart = source.indexOf('{sidebarOpen && isMobile');
const mobileSidebarEnd = source.indexOf('{sidebarOpen && !isMobile', mobileSidebarStart);
const mobileSidebarBlock = source.slice(mobileSidebarStart, mobileSidebarEnd);

describe('mobile sidebar visual hierarchy', () => {
  it('dims and softly blurs the workspace behind the drawer', () => {
    expect(source).toContain('bg-black/55 backdrop-blur-[1.5px]');
    expect(source).toContain("sidebarTab === 'files' ? 'min(82vw, 340px)' : '85vw'");
  });

  it('does not reopen the mobile drawer after creating a new conversation', () => {
    expect(source).toContain('Do not reopen the');
    expect(source).toContain('if (!useSessionStore.getState().isMobile)');
    expect(source).toContain('useSessionStore.getState().setSidebarOpen(true);');
  });

  it('covers the previous conversation while mobile session creation is pending', () => {
    expect(source).toContain('const [newSessionCreating, setNewSessionCreating] = useState(false);');
    expect(source).toContain('const newSessionCreatingRef = useRef(false);');
    expect(source).toContain('newSessionCreatingRef.current = true;');
    expect(source).toContain('newSessionCreatingRef.current = false;');
    expect(source).toContain('isMobile && newSessionCreating ?');
    expect(source).toContain('data-testid="new-session-loading"');
    expect(source).toContain('새 세션을 준비하는 중…');
    expect(mobileSidebarBlock).toContain("useSessionStore.getState().setActiveView('chat');");
    expect(mobileSidebarBlock).toContain('void handleNewSession(projectId, label);');
  });

  it('keeps the previous session selected and reports an error when creation fails', () => {
    expect(source).toContain("toastError('새 세션을 만들지 못했습니다');");
    expect(source).toContain('if (!session) {');
  });

  it('closes the drawer after mobile file-sidebar actions that open content', () => {
    expect(mobileSidebarBlock).toContain('void handleNewSessionInFolder(path);');
    expect(mobileSidebarBlock).toContain("useSessionStore.getState().setMobileTab('ai');");
    expect(mobileSidebarBlock).toContain('handlePromptClick(prompt);');
    expect(mobileSidebarBlock).toContain('useSessionStore.getState().openMobileContext();');
  });
});

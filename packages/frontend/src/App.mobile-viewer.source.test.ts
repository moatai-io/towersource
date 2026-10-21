import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const app = readFileSync(new URL('./App.tsx', import.meta.url), 'utf8');
const fileOpen = readFileSync(new URL('./hooks/useFileOpenActions.ts', import.meta.url), 'utf8');
const academy = readFileSync(new URL('./hooks/useAgentAcademy.ts', import.meta.url), 'utf8');
const source = `${app}\n${fileOpen}\n${academy}`;

describe('App mobile Viewer file opening', () => {
  it('opens the fullscreen mobile context immediately for foreground Viewer clicks', () => {
    expect(fileOpen).toMatch(/if \(openInViewer && !backgroundViewer\) \{[\s\S]*?setContextPanelOpen\(true\);[\s\S]*?setActiveFilePane\('extra'\);[\s\S]*?if \(useSessionStore\.getState\(\)\.isMobile\)[\s\S]*?openMobileContext\(\)/);
  });

  it('opens mobile context before the Viewer HTTP request so websocket fallback remains visible', () => {
    const openIndex = fileOpen.indexOf('useSessionStore.getState().openMobileContext();', fileOpen.indexOf('const handleFileClick'));
    const fetchIndex = fileOpen.indexOf('fetch(`${API_BASE}/files/read?path=', fileOpen.indexOf('const handleFileClick'));
    expect(openIndex).toBeGreaterThan(-1);
    expect(fetchIndex).toBeGreaterThan(openIndex);
  });

  it('renders the fullscreen mobile Viewer with the active split tab', () => {
    expect(source).toMatch(/\{isMobile && mobileContextOpen && !sessionLinkState && \([\s\S]*?<ContextPanel[\s\S]*?tabId=\{splitTabId \?\? undefined\}/);
  });

  it('does not open mobile context for background Viewer delivery', () => {
    expect(source).toContain('if (openInViewer && !backgroundViewer) {');
  });

  it('renders AI teammate creation in the mobile AI Team surface instead of mobile Viewer context', () => {
    const academyStart = academy.indexOf('const openAgentAcademy = useCallback');
    const academyEnd = academy.indexOf('const closeAgentAcademy', academyStart);
    const academyBlock = academy.slice(academyStart, academyEnd);
    expect(academyBlock).toContain("setAiTeamSurface('creator')");
    expect(academyBlock).toContain("sessionState.setActiveView('aiTeam')");
    expect(academyBlock).not.toContain('openMobileContext');
    expect(academyBlock).not.toContain('openTab');
  });
});

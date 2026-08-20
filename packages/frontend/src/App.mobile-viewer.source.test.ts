import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = readFileSync(new URL('./App.tsx', import.meta.url), 'utf8');

describe('App mobile Viewer file opening', () => {
  it('opens the fullscreen mobile context immediately for foreground Viewer clicks', () => {
    expect(source).toMatch(/if \(openInViewer && !backgroundViewer\) \{[\s\S]*?setContextPanelOpen\(true\);[\s\S]*?setActiveFilePane\('extra'\);[\s\S]*?if \(useSessionStore\.getState\(\)\.isMobile\) \{[\s\S]*?openMobileContext\(\)/);
  });

  it('opens mobile context before the Viewer HTTP request so websocket fallback remains visible', () => {
    const openIndex = source.indexOf('useSessionStore.getState().openMobileContext();', source.indexOf('const handleFileClick'));
    const fetchIndex = source.indexOf('fetch(`${API_BASE}/files/read?path=', source.indexOf('const handleFileClick'));
    expect(openIndex).toBeGreaterThan(-1);
    expect(fetchIndex).toBeGreaterThan(openIndex);
  });

  it('renders the fullscreen mobile Viewer with the active split tab', () => {
    expect(source).toMatch(/\{isMobile && mobileContextOpen && \([\s\S]*?<ContextPanel[\s\S]*?tabId=\{splitTabId \?\? undefined\}/);
  });

  it('does not open mobile context for background Viewer delivery', () => {
    expect(source).toContain('if (openInViewer && !backgroundViewer) {');
  });

  it('opens the AI teammate hiring card as a transient fullscreen mobile workflow', () => {
    const academyStart = source.indexOf("window.addEventListener('tower-start-agent-academy'");
    const academyBlock = source.slice(source.lastIndexOf('useEffect(() => {', academyStart), academyStart);
    expect(academyBlock).toContain("mobileHiring ? { split: 'right', name: t('newAiTeammate') } : { name: t('newAiTeammate') }");
    expect(academyBlock).toContain('useSessionStore.getState().openMobileContext(false);');
  });
});

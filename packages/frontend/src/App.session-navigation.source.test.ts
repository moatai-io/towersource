import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

const app = fs.readFileSync(path.resolve(import.meta.dirname, './App.tsx'), 'utf8');
const header = fs.readFileSync(path.resolve(import.meta.dirname, './components/layout/Header.tsx'), 'utf8');
const mobileTabs = fs.readFileSync(path.resolve(import.meta.dirname, './components/layout/MobileTabBar.tsx'), 'utf8');

describe('shared Session destination navigation', () => {
  it('clears a stale Session Directory for desktop and mobile Session navigation', () => {
    expect(app).toContain('const handleNavigateSessions = useCallback(() => {');
    expect(app).toContain('setSessionDirectory(null);');
    expect(app).toContain('onNavigateSessions={handleNavigateSessions}');
    expect(app).toContain('<MobileTabBar onNavigateSessions={handleNavigateSessions} />');
  });

  it('leaves file and system surfaces before restoring Sessions on desktop', () => {
    const start = header.indexOf("case 'ai':");
    const end = header.indexOf("case 'files':", start);
    const block = header.slice(start, end);
    expect(block.indexOf('activateChatSlot()')).toBeLessThan(block.indexOf('setAiNavigationSurface()'));
    expect(block.indexOf('onNavigateSessions?.()')).toBeLessThan(block.indexOf('setAiNavigationSurface()'));
  });

  it('applies the same stale-directory cleanup on mobile', () => {
    const start = mobileTabs.indexOf("if (tab === 'ai')");
    const end = mobileTabs.indexOf("} else if (tab === 'files')", start);
    const block = mobileTabs.slice(start, end);
    expect(block.indexOf('activateChatSlot()')).toBeLessThan(block.indexOf('setAiNavigationSurface()'));
    expect(block.indexOf('onNavigateSessions?.()')).toBeLessThan(block.indexOf('setAiNavigationSurface()'));
  });
});

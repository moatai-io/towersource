import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

const source = fs.readFileSync(path.resolve(import.meta.dirname, './Header.tsx'), 'utf8');

describe('AI team primary navigation', () => {
  it('opens the conversation workspace with left teammate navigation', () => {
    const start = source.indexOf("case 'ai':");
    const end = source.indexOf("case 'files':", start);
    const block = source.slice(start, end);
    expect(block).toContain('store.setAiNavigationSurface()');
    expect(block).toContain('store.setSidebarOpen(true)');
    expect(block).not.toContain("setSidebarTab('sessions')");
    expect(block).not.toContain("setActiveView('chat')");
    expect(block).not.toContain("setActiveView('aiTeam')");
  });
});

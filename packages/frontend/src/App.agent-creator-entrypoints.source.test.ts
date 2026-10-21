import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const app = fs.readFileSync(path.resolve(import.meta.dirname, './App.tsx'), 'utf8');
const startup = fs.readFileSync(path.resolve(import.meta.dirname, './hooks/useSessionStartup.ts'), 'utf8');
const academy = fs.readFileSync(path.resolve(import.meta.dirname, './hooks/useAgentAcademy.ts'), 'utf8');
const sidebar = fs.readFileSync(path.resolve(import.meta.dirname, './components/layout/Sidebar.tsx'), 'utf8');
const header = fs.readFileSync(path.resolve(import.meta.dirname, './components/layout/Header.tsx'), 'utf8');
const teamHome = fs.readFileSync(path.resolve(import.meta.dirname, './components/agents/AITeamHome.tsx'), 'utf8');
const quickPanel = fs.readFileSync(path.resolve(import.meta.dirname, './components/agents/AITeamQuickPanel.tsx'), 'utf8');

function eventDispatchCount(source: string): number {
  return source.match(/dispatchEvent\(new CustomEvent\('tower-start-agent-academy'\)\)/g)?.length ?? 0;
}

describe('AI teammate creator entry points', () => {
  it('routes every visible creator entry point through the one App-level creator event', () => {
    expect(eventDispatchCount(sidebar)).toBe(2);
    expect(eventDispatchCount(header)).toBe(1);
    expect(eventDispatchCount(teamHome)).toBe(1);
    expect(eventDispatchCount(app)).toBe(1); // quick panel prop
    expect(eventDispatchCount(startup)).toBe(1); // first-use startup
    expect(quickPanel).toContain('onNewTeammate(); onClose();');
    expect(academy).toContain("window.addEventListener('tower-start-agent-academy', openAgentAcademy)");
    expect(academy).toContain("window.removeEventListener('tower-start-agent-academy', openAgentAcademy)");
  });

  it('keeps the shared creator inside AI Team so every entry point inherits the same placement', () => {
    const creatorStart = academy.indexOf('const openAgentAcademy = useCallback');
    const creatorEnd = academy.indexOf('const closeAgentAcademy', creatorStart);
    const creator = academy.slice(creatorStart, creatorEnd);
    expect(creator).toContain("setAiTeamSurface('creator')");
    expect(creator).toContain("sessionState.setActiveView('aiTeam')");
    expect(creator).not.toContain('openTab');
    expect(creator).not.toContain('openSplitTab');
    expect(app.match(/<AgentDraftPreview content=\{agentCreatorContent\} onCancel=\{closeAgentAcademy\} \/>/g)).toHaveLength(1);
  });
});

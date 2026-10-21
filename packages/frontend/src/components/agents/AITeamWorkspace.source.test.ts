import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

const app = fs.readFileSync(path.resolve(import.meta.dirname, '../../App.tsx'), 'utf8');
const header = fs.readFileSync(path.resolve(import.meta.dirname, '../layout/Header.tsx'), 'utf8');
const sidebar = fs.readFileSync(path.resolve(import.meta.dirname, '../layout/Sidebar.tsx'), 'utf8');
const store = fs.readFileSync(path.resolve(import.meta.dirname, '../../stores/session-store.ts'), 'utf8');

describe('AI teammate management workspace with Session-centered navigation', () => {
  it('keeps Top navigation on Conversations while Work and teammate management stay distinct', () => {
    expect(store).toContain("export type ActiveView = 'chat' | 'aiTeam'");
    expect(store).toContain('`aiTeam` is only the full AI Team home/directory surface');
    expect(store).toContain('`sessions` is the AI navigation surface');
    expect(store).toContain("mobileTab: 'ai'");
    expect(store).toContain("activeView: 'chat'");
    expect(header).toContain("{ key: 'ai', label: t('conversationsNav'), badge: 0 }");
    expect(header).not.toContain("{ key: 'work'");
    expect(header).toContain('store.setAiNavigationSurface()');
    expect(sidebar).toContain("t('recentConversationsNav')");
    expect(sidebar).toContain("t('aiTeammateManagement')");
    expect(store).toContain("'chat' | 'aiTeam'");
    expect(app).toContain('activeView={activeView}');
    expect(app).toContain('aiTeam={aiTeamSurfaceContent}');
  });

  it('renders the same AI Team directory on desktop and mobile when explicitly opened', () => {
    expect(app.match(/<AITeamHome projects=\{projects\}/g)?.length).toBe(1);
    expect(app).toContain('max-w-6xl');
    expect(app).toContain('onClose={closeAiTeamHome}');
  });

  it('keeps Sidebar as teammate/session navigation while allowing explicit team-home navigation', () => {
    expect(sidebar).not.toContain('<AITeamHome');
    expect(sidebar).toContain("new CustomEvent('tower-open-ai-team-home')");
    expect(sidebar).toContain("setActiveView('aiTeam')");
  });
});

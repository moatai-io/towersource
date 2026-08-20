import fs from 'fs';
import path from 'path';
import { describe, it, expect } from 'vitest';

const home = fs.readFileSync(path.resolve(import.meta.dirname, './AgentHomeOverview.tsx'), 'utf8');
const project = fs.readFileSync(path.resolve(import.meta.dirname, '../files/ProjectHome.tsx'), 'utf8');
const app = fs.readFileSync(path.resolve(import.meta.dirname, '../../App.tsx'), 'utf8');

describe('AI teammate operating profile', () => {
  it('keeps identity, responsibility and primary actions visible', () => {
    for (const key of ['agentHome.aiTeammate', 'agentHome.primaryResponsibility', 'agentHome.assignWork', 'agentHome.settings']) {
      expect(home).toContain(key);
    }
  });

  it('prioritizes shared work and growth before activity analytics', () => {
    const work = home.indexOf("t('agentHome.sharedWork')");
    const growth = home.indexOf("t('agentHome.growth')");
    const activity = home.indexOf("t('agentHome.recentUsage')");
    expect(work).toBeGreaterThan(0);
    expect(growth).toBeGreaterThan(work);
    expect(activity).toBeGreaterThan(growth);
    expect(home).not.toContain('agentHome.reviewItems');
  });

  it('shows total, personal and company collaboration experience', () => {
    for (const value of ['agentHome.sharedWork', 'agentHome.myWork', 'agentHome.companyWork', 'collaboration.totalWorkstreams', 'collaboration.myWorkstreams']) {
      expect(home).toContain(value);
    }
  });

  it('uses reader-facing locale contracts instead of implementation jargon', () => {
    for (const key of ['agentHome.userRequests', 'agentHome.processedTokens', 'agentHome.memberUsage', 'agentHome.createdSkills', 'agentHome.frequentSkills', 'agentHome.viewAllWork']) {
      expect(home).toContain(key);
    }
    expect(home).not.toContain('최근 14일 대화');
    expect(home).not.toContain('남은 조건');
  });

  it('renders controlled growth guidance through locale keys', () => {
    expect(home).toContain("t('agentHome.growthBlocker')");
    expect(home).toContain("t('agentHome.growthAction')");
    expect(home).not.toContain('{blocker.label}이 다음 직급 기준');
  });

  it('keeps direct actions wired from ProjectHome', () => {
    expect(project).toContain('onNewConversation={startNewConversation}');
    expect(project).toContain('onEditTeammate={editTeammate}');
    expect(project).toContain('collaboration={agentHome?.collaboration}');
    expect(project).toContain("onOpenAllWork={() => setHomeTab('work')}");
    expect(app).toContain("setActiveView('chat')");
  });
});

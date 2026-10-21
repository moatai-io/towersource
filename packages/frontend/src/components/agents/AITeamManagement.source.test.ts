import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const source = fs.readFileSync(path.resolve(import.meta.dirname, './AITeamHome.tsx'), 'utf8');

describe('AI teammate management information architecture', () => {
  it('centers teammate identity, role, status, and management actions', () => {
    expect(source).toContain("t('aiTeammateManagement')");
    expect(source).toContain("t('aiTeammateManagementDescription')");
    expect(source).toContain('levelTitle(level)');
    expect(source).toContain("t('teammateInstruction')");
    expect(source).toContain("t('manageTeammate')");
    expect(source).toContain("t('startConversation')");
  });

  it('does not duplicate Work with charts or recent-work sorting while retaining compact totals', () => {
    expect(source).not.toContain('dailyTurns');
    expect(source).not.toContain('recentUsage');
    expect(source).not.toContain("t('recentTurns')");
    expect(source).toContain("t('totalConversations')");
    expect(source).toContain("t('completedWork')");
    expect(source).not.toContain("t('sortRecentWork')");
    expect(source).not.toContain('ChallengeTimelinePanel');
    expect(source).not.toContain('WorkHub');
  });
});

import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const source = fs.readFileSync(path.resolve(import.meta.dirname, './AITeamHome.tsx'), 'utf8');

describe('AI teammate management cards', () => {
  it('offers explicit management and conversation actions without turning the whole card into navigation', () => {
    expect(source).toContain('onClick={() => onOpenProjectHome(project)}');
    expect(source).toContain('onClick={() => onNewSession(project.id)}');
    expect(source).toContain("t('manageTeammate')");
    expect(source).toContain("t('startConversation')");
    expect(source).not.toContain('role="link"');
  });

  it('keeps identity, skill level, workspace, role, and compact operating totals', () => {
    for (const copy of ["levelTitle(level)", "t('teammateInstruction')", "t('workspace')", "t('teammateStatus.available')", "t('totalConversations')", "t('completedWork')"]) {
      expect(source).toContain(copy);
    }
    expect(source).toContain('conversationCount: project.sessionCount ?? 0');
    expect(source).toContain('completedWorkCount: project.careerMetrics?.completedWorkstreams ?? 0');
    expect(source).not.toContain('session.userTurnCount || 0');
    for (const removed of ['memberCount', 'recentUsage', 'changePercent', 'dailyTurns']) {
      expect(source).not.toContain(removed);
    }
  });
});

 it('keeps owned and discoverable team portraits free of decorative frames', () => {
  expect(source).toContain('variant="list" showListAccent={false} className="h-[84px] w-[84px] shrink-0"');
  expect(source).toContain('<AgentIdentityAvatar project={project} className="h-20 w-20 shrink-0"');
  expect(source).not.toContain('rounded-xl border border-primary-400/20');
});

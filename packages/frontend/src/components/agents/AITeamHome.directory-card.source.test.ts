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

  it('surfaces identity, role, workspace, and availability instead of work usage', () => {
    for (const copy of ["t('teammateRole')", "t('teammateInstruction')", "t('workspace')", "t('teammateStatus.available')"]) {
      expect(source).toContain(copy);
    }
    for (const removed of ['memberCount', 'recentUsage', 'changePercent', 'dailyTurns']) {
      expect(source).not.toContain(removed);
    }
  });
});

import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

const home = fs.readFileSync(path.resolve(import.meta.dirname, './AgentHomeOverview.tsx'), 'utf8');
const project = fs.readFileSync(path.resolve(import.meta.dirname, '../files/ProjectHome.tsx'), 'utf8');

describe('Agent home direct targets', () => {
  it('keeps Approval-specific result links out of the teammate home', () => {
    expect(home).not.toContain('onOpenApproval');
    expect(home).not.toContain('recentResults');
    expect(project).not.toContain("new CustomEvent('tower-open-approval'");
    expect(project).not.toContain('approval-inbox-title');
  });

  it('opens a selected workstream from the operating profile', () => {
    expect(home).toContain('onOpenWork(x.workstreamKey)');
    expect(project).toContain("new CustomEvent('tower-open-project-work'");
  });

  it('opens recent sessions directly', () => {
    expect(home).toContain('onOpenSession(s.id)');
    expect(project).toContain('onOpenSession={openSession}');
  });
});

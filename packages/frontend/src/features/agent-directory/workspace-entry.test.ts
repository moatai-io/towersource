import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import { resolveEnteredWorkspace } from './workspace-entry';
const base = { activeView: 'chat', systemTabKind: null, systemProjectId: null, activeSessionProjectId: 'session-project', capabilityProjectId: 'files-project' };
describe('actual workspace entry boundary', () => {
  it.each(['aiTeam', 'work', 'favorites', 'inbox', 'rooms', 'automations'])('does not enter from %s despite stale session/project selection', activeView => {
    expect(resolveEnteredWorkspace({ ...base, activeView })).toBeNull();
  });
  it('resolves conversation, home tab and direct files entry', () => {
    expect(resolveEnteredWorkspace(base)).toBe('session-project');
    expect(resolveEnteredWorkspace({ ...base, systemTabKind: 'projectFiles', systemProjectId: 'home' })).toBe('home');
    expect(resolveEnteredWorkspace({ ...base, activeView: 'projectFiles' })).toBe('files-project');
    expect(resolveEnteredWorkspace({ ...base, systemTabKind: 'publishing' })).toBeNull();
  });
  it('does not mount legacy operator auto-participation in the workspace or sidebar', () => {
    const app = fs.readFileSync(new URL('../../App.tsx', import.meta.url), 'utf8');
    const sidebar = fs.readFileSync(new URL('../../components/layout/Sidebar.tsx', import.meta.url), 'utf8');
    expect(app).not.toContain('AdministratorParticipation');
    expect(sidebar).not.toContain('<AdministratorParticipation');
    expect(sidebar).toContain('/api/projects/${project.id}/members');
    expect(sidebar).toContain('handleRemoveMember(m.userId)');
  });
});

import { describe, expect, it } from 'vitest';
import { selectRegisteredProjectRoot, type RegisteredProjectRoot } from './project-root-selection.js';
const retired: RegisteredProjectRoot = { project_id: 'old', root_path: '/workspace/general', archived: 1, lifecycle_status: 'retired' };
const active: RegisteredProjectRoot = { project_id: 'current', root_path: '/workspace/general', archived: 0, lifecycle_status: 'active' };
const expected = { projectId: 'current', projectRoot: '/workspace/general' };
describe('registered file root selection', () => {
  it.each([[retired, active], [active, retired]])('ignores retired same-root alias regardless of row ordering', (...rows) => {
    expect(selectRegisteredProjectRoot(rows, '/workspace/general/uploads/a.txt', expected)).toBe(active);
    expect(selectRegisteredProjectRoot(rows, '/workspace/general/uploads/a.txt')).toBe(active);
  });
  it('requires unique active identity for path-only calls but honors explicit active identity', () => {
    const second = { ...active, project_id: 'other' };
    expect(() => selectRegisteredProjectRoot([active, second], '/workspace/general/a')).toThrow('AMBIGUOUS');
    expect(selectRegisteredProjectRoot([active, second], '/workspace/general/a', expected)).toBe(active);
  });
  it.each(['retired', 'blocked', 'pending', 'disabled'])('never crosses a deeper %s root to a live parent', lifecycle_status => {
    const nested = { project_id: 'nested', root_path: '/workspace/general/child', archived: 0, lifecycle_status };
    expect(() => selectRegisteredProjectRoot([active, nested], '/workspace/general/child/a')).toThrow('INACTIVE');
    expect(() => selectRegisteredProjectRoot([active, nested], '/workspace/general/child/a', expected)).toThrow('MISMATCH');
  });
  it('never substitutes active identity for an explicitly requested retired project', () => {
    expect(() => selectRegisteredProjectRoot([retired, active], '/workspace/general/a', { ...expected, projectId: 'old' })).toThrow('INACTIVE');
    expect(() => selectRegisteredProjectRoot([active], '/workspace/general/a', { ...expected, projectId: 'old' })).toThrow('MISMATCH');
  });
  it('validates the registered root even for canonical host and outside-project paths', () => {
    expect(() => selectRegisteredProjectRoot([active], '/workspace/general/a', { ...expected, projectRoot: '/workspace/wrong' })).toThrow('MISMATCH');
    expect(() => selectRegisteredProjectRoot([active], '/workspace/general-other/a', expected)).toThrow('MISMATCH');
    expect(selectRegisteredProjectRoot([active], '/workspace/general-other/a')).toBeUndefined();
    expect(() => selectRegisteredProjectRoot([retired], '/workspace/general/a')).toThrow('INACTIVE');
  });
  it('keeps a nested active identity separate even if its storage resolves to host', () => {
    const child = { ...active, project_id: 'child', root_path: '/workspace/general/child' };
    expect(selectRegisteredProjectRoot([active, child], '/workspace/general/child/a')).toBe(child);
    expect(() => selectRegisteredProjectRoot([active, child], '/workspace/general/child/a', expected)).toThrow('MISMATCH');
    expect(selectRegisteredProjectRoot([active, child], '/workspace/general/child/a', { projectId: 'child', projectRoot: child.root_path })).toBe(child);
  });
  it('does not activate an archived row with active lifecycle', () => {
    expect(() => selectRegisteredProjectRoot([{ ...active, archived: 1 }], '/workspace/general/a', expected)).toThrow('INACTIVE');
  });
  it('supports legacy null lifecycle and Project root listings without order dependence', () => {
    const row = { ...active, root_path: '/workspace/./general/', lifecycle_status: null };
    expect(selectRegisteredProjectRoot([row], '/workspace/general', expected)).toBe(row);
    expect(selectRegisteredProjectRoot([{ ...active, project_id: 'parent', root_path: '/workspace' }, row], '/workspace/general/a')).toBe(row);
  });
});

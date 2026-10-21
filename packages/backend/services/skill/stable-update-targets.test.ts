import { describe, expect, it } from 'vitest';
import { selectStableUpdateProjectRoots } from './stable-update-targets.js';

describe('stable updater target selection', () => {
  const rows = [{ root_path: '/projects/teamskills' }, { root_path: '/projects/a' }, { root_path: '/projects/b' }];
  it('discovers current registered Project roots except the teamskills source at each invocation', () => {
    expect(selectStableUpdateProjectRoots(rows, '/projects/teamskills')).toEqual(['/projects/a', '/projects/b']);
    expect(selectStableUpdateProjectRoots([...rows, { root_path: '/projects/new' }], '/projects/teamskills')).toContain('/projects/new');
  });
  it('supports explicit roots only when matching the entire current DB set', () => {
    expect(selectStableUpdateProjectRoots(rows, '/projects/teamskills', ['/projects/b', '/projects/a'])).toEqual(['/projects/a', '/projects/b']);
    expect(() => selectStableUpdateProjectRoots(rows, '/projects/teamskills', ['/projects/a'])).toThrow('must match');
  });
  it('rejects missing, relative, duplicated and empty target sets', () => {
    expect(() => selectStableUpdateProjectRoots([{ root_path: null }], '/projects/teamskills')).toThrow();
    expect(() => selectStableUpdateProjectRoots([{ root_path: 'relative' }], '/projects/teamskills')).toThrow();
    expect(() => selectStableUpdateProjectRoots([...rows, rows[1]], '/projects/teamskills')).toThrow('duplicate');
    expect(() => selectStableUpdateProjectRoots([rows[0]], '/projects/teamskills')).toThrow('no registered');
  });
});

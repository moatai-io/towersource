import { describe, it, expect, vi, beforeEach } from 'vitest';
import { homedir } from 'node:os';
vi.mock('../pm/project-access.js', () => ({
  isDotfileDenied: vi.fn(() => false),
  isPathAccessible: vi.fn(async () => true),
}));
vi.mock('../../db/pg-repo.js', () => ({ query: vi.fn(), queryOne: vi.fn() }));
import { isDotfileDenied, isPathAccessible } from '../pm/project-access.js';
import { query, queryOne } from '../../db/pg-repo.js';
import { filterAccessibleSessionFiles } from './session-file-access.js';
import { getTouchedFiles } from './session-touched-files.js';
import { getProjectRecentFiles } from './session-project-files.js';
const viewer = { userId: 42, role: 'member' };
const rows = ['/private/secret.md', '/project/report.md'].map(file_path => ({
  file_path, tool_name: 'write', created_at: '2026-01-01', last_touched_at: '2026-01-01',
  source_session_id: 'other', source_session_title: 'Other',
}));
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(isDotfileDenied).mockReturnValue(false);
  vi.mocked(isPathAccessible).mockImplementation(async p => !p.startsWith('/private'));
  vi.mocked(query).mockResolvedValue(rows);
  vi.mocked(queryOne).mockResolvedValue({ project_id: 'project' });
});
describe('session file visibility', () => {
  it.each(['member', 'operator', 'admin'])('passes current %s authority without a role bypass', async role => {
    expect(await filterAccessibleSessionFiles(rows, { ...viewer, role })).toEqual([rows[1]]);
    expect(isPathAccessible).toHaveBeenCalledWith('/private/secret.md', 42, role);
  });
  it('rechecks revoked authority rather than caching a prior session grant', async () => {
    expect(await filterAccessibleSessionFiles([rows[1]], viewer)).toHaveLength(1);
    vi.mocked(isPathAccessible).mockResolvedValue(false);
    expect(await filterAccessibleSessionFiles([rows[1]], viewer)).toEqual([]);
  });
  it('omits ambiguous relative paths and system-denied paths', async () => {
    vi.mocked(isDotfileDenied).mockReturnValue(true);
    expect(await filterAccessibleSessionFiles([{ file_path: 'report.md' }, rows[1]], viewer)).toEqual([]);
    expect(isPathAccessible).not.toHaveBeenCalled();
  });
  it('expands portable home paths for ACL checks', async () => {
    await filterAccessibleSessionFiles([{ file_path: '~/workspace/report.md' }], viewer);
    expect(isPathAccessible).toHaveBeenCalledWith(`${homedir()}/workspace/report.md`, 42, 'member');
  });
  it('fails closed when authority lookup fails', async () => {
    vi.mocked(isPathAccessible).mockRejectedValue(new Error('ACL unavailable'));
    await expect(filterAccessibleSessionFiles(rows, viewer)).rejects.toThrow('ACL unavailable');
  });
  it('filters touched files before applying the display limit', async () => {
    expect((await getTouchedFiles('session', viewer, 1)).files.map(f => f.path)).toEqual(['/project/report.md']);
  });
  it('applies session audience before aggregation and limiting project fallback files', async () => {
    await getProjectRecentFiles('session', viewer, 1);
    const [sql, params] = vi.mocked(query).mock.calls.at(-1)!;
    expect(sql).toContain('s.user_id = $4');
    expect(sql).toContain("s.visibility = 'project'");
    expect(sql.indexOf('s.user_id = $4')).toBeLessThan(sql.indexOf('GROUP BY'));
    expect(params).toEqual(['project', 'session', 4, viewer.userId]);
  });
  it('also filters project fallback files', async () => {
    expect((await getProjectRecentFiles('session', viewer, 1)).files.map(f => f.path)).toEqual(['/project/report.md']);
  });
});

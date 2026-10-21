import { beforeEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ query: vi.fn(), one: vi.fn(), access: vi.fn() }));
vi.mock('../../db/pg-repo.js', () => ({ query: mocks.query, queryOne: mocks.one }));
vi.mock('../pm/project-access.js', () => ({ canAccessSession: mocks.access }));
import { getRelatedSessionsByFiles } from './session-backlinks.js';
beforeEach(() => { vi.resetAllMocks(); });
it('cannot probe source filenames without session audience', async () => {
  mocks.access.mockResolvedValue({ allowed: false });
  expect(await getRelatedSessionsByFiles('source', null, 7, 'operator')).toMatchObject({ filesInSession: 0, candidatesConsidered: 0, results: [] });
  expect(mocks.query).not.toHaveBeenCalled();
});
it('filters candidate files and scoring population before ranking, then rechecks metadata audience', async () => {
  mocks.access.mockResolvedValue({ allowed: true });
  mocks.query.mockResolvedValueOnce([{ file_path: '/project/feature.ts' }])
    .mockResolvedValueOnce([{ file_path: '/project/feature.ts', session_id: 'visible' }])
    .mockResolvedValueOnce([{ id: 'visible', name: 'Shared', user_id: 20, project_id: 'project', updated_at: 'now' }]);
  mocks.one.mockResolvedValue({ n: 100 });
  const result = await getRelatedSessionsByFiles('source', null, 7, 'operator');
  expect(result.results).toHaveLength(1);
  const [candidates, meta] = [mocks.query.mock.calls[1], mocks.query.mock.calls[2]];
  expect(candidates[0]).not.toContain('administrator_participations');
  expect(candidates[0]).toContain("s.visibility = 'project'");
  expect(candidates[1][2]).toBe(7);
  expect(meta[0]).not.toContain('session_shares');
  expect(mocks.one.mock.calls[0][0]).toContain('room_members');
  expect(mocks.one.mock.calls[0][1]).toEqual([7]);
});

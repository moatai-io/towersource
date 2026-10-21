import { beforeEach, afterAll, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const { query } = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock('../../db/pg-repo.js', () => ({ query, queryOne: vi.fn() }));
import { filterAccessibleSessionFiles } from './session-file-access.js';
import { isPathWritableByRole } from '../pm/project-access.js';

// Real ACL functions + real symlinks; only membership storage is simulated.
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tower-session-file-authority-'));
const alpha = path.join(root, 'alpha');
const beta = path.join(root, 'beta');
fs.mkdirSync(alpha); fs.mkdirSync(beta);
fs.mkdirSync(path.join(beta, '.audit'));
fs.writeFileSync(path.join(alpha, 'report.md'), '# Report');
fs.writeFileSync(path.join(beta, 'private.md'), '# Private');
fs.symlinkSync(beta, path.join(alpha, 'outside'), 'dir');
fs.symlinkSync(path.join(beta, '.audit'), path.join(alpha, 'audit-link'), 'dir');
const file = (p: string) => ({ file_path: p });
const report = file(path.join(alpha, 'report.md'));
let memberRole: string | null;
beforeEach(() => {
  memberRole = 'member';
  query.mockReset();
  query.mockImplementation(async (sql: string) => {
    if (sql.includes('LEFT JOIN project_members')) return [
      { root_path: alpha, role: memberRole }, { root_path: beta, role: null },
    ];
    // No Operator access or company-wide business grants in this fixture.
    return [];
  });
});
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

describe('session file list with real path authority', () => {
  it.each(['member', 'operator'])('allows an actual project member (%s) and denies another project', async role => {
    expect(await filterAccessibleSessionFiles([report, file(path.join(beta, 'private.md'))], { userId: 7, role }))
      .toEqual([report]);
    expect(await isPathWritableByRole(report.file_path, 7, role)).toBe(true);
  });
  it('revokes list and write access when membership is removed', async () => {
    expect(await filterAccessibleSessionFiles([report], { userId: 7, role: 'member' })).toEqual([report]);
    memberRole = null;
    expect(await filterAccessibleSessionFiles([report], { userId: 7, role: 'member' })).toEqual([]);
    expect(await isPathWritableByRole(report.file_path, 7, 'member')).toBe(false);
  });
  it('does not turn viewer read access into write authority', async () => {
    expect(await filterAccessibleSessionFiles([report], { userId: 7, role: 'viewer' })).toEqual([report]);
    expect(await isPathWritableByRole(report.file_path, 7, 'viewer')).toBe(false);
  });
  it('rejects symlink escape to a project without membership', async () => {
    expect(await filterAccessibleSessionFiles([file(path.join(alpha, 'outside/private.md'))], { userId: 7, role: 'member' })).toEqual([]);
  });
  it('denies platform admin without membership and system-denied symlinks', async () => {
    const privateFile = file(path.join(beta, 'private.md'));
    expect(await filterAccessibleSessionFiles([privateFile, file(path.join(alpha, 'audit-link/log.md'))], { userId: 1, role: 'admin' }))
      .toEqual([]);
  });
});

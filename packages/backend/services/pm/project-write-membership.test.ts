import { beforeEach, describe, expect, it, vi } from 'vitest';
import path from 'node:path';
const mocks = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock('../../db/pg-repo.js', () => ({ query: mocks.query, queryOne: vi.fn() }));
vi.mock('./project-membership-manager.js', () => ({ isProjectMember: vi.fn(), getAccessibleProjectIds: vi.fn() }));
vi.mock('../session/session-share-manager.js', () => ({ hasInternalShareAccess: vi.fn() }));
import { isPathWritableByRole, isPathAccessible } from './project-access.js';
const root = path.join(process.env.WORKSPACE_ROOT || path.join(process.env.HOME || '/tmp', 'workspace'), 'projects', 'synthetic-write-policy');
beforeEach(() => { vi.resetAllMocks(); });
describe('project file read and write use current membership rather than cached readable roots', () => {
  it.each(['member', 'owner'])('allows project %s to read current Project files', async (role) => {
    mocks.query.mockResolvedValue([{ root_path: root, role }]);
    expect(await isPathAccessible(`${root}/current-file.txt`, 10, 'member')).toBe(true);
    expect(mocks.query).toHaveBeenCalledWith(expect.stringContaining('LEFT JOIN project_members'), [10]);
  });
  it.each(['viewer', 'guest', null])('denies Project reads without writable membership %s', async (role) => {
    mocks.query.mockResolvedValue([{ root_path: root, role }]);
    expect(await isPathAccessible(`${root}/current-file.txt`, 10, 'member')).toBe(false);
  });
  it('does not let a parent membership override a more specific inaccessible Project read', async () => {
    mocks.query.mockResolvedValue([{ root_path: root, role: 'owner' }, { root_path: `${root}/nested`, role: null }]);
    expect(await isPathAccessible(`${root}/nested/file.txt`, 10, 'member')).toBe(false);
  });
  it.each(['viewer', 'guest', 'unknown'])('denies %s globally without a membership lookup', async (role) => {
    mocks.query.mockResolvedValue([{ root_path: root, role: 'owner' }]);
    expect(await isPathWritableByRole(`${root}/file.txt`, 10, role)).toBe(false);
    expect(mocks.query).not.toHaveBeenCalled();
  });
  it.each(['viewer', 'guest', 'read', null])('denies global member with project membership %s', async (role) => {
    mocks.query.mockResolvedValue([{ root_path: root, role }]);
    expect(await isPathWritableByRole(`${root}/file.txt`, 10, 'member')).toBe(false);
  });
  it.each(['member', 'owner'])('allows project %s to manage company files', async (role) => {
    mocks.query.mockResolvedValue([{ root_path: root, role }]);
    expect(await isPathWritableByRole(`${root}/someone-elses-file.txt`, 10, 'member')).toBe(true);
    expect(mocks.query).toHaveBeenCalledWith(expect.stringContaining('pm.user_id = $1'), [10]);
  });
  it('checks fresh membership on every write after downgrade/revocation', async () => {
    mocks.query.mockResolvedValueOnce([{ root_path: root, role: 'member' }])
      .mockResolvedValueOnce([{ root_path: root, role: 'viewer' }])
      .mockResolvedValueOnce([{ root_path: root, role: null }]);
    expect(await isPathWritableByRole(`${root}/file`, 10, 'member')).toBe(true);
    expect(await isPathWritableByRole(`${root}/file`, 10, 'member')).toBe(false);
    expect(await isPathWritableByRole(`${root}/file`, 10, 'member')).toBe(false);
  });
  it('does not override nested read-only or inaccessible roots with parent write membership', async () => {
    mocks.query.mockResolvedValue([{ root_path: root, role: 'owner' }, { root_path: `${root}/nested`, role: 'viewer' }]);
    expect(await isPathWritableByRole(`${root}/nested/file`, 10, 'member')).toBe(false);
    mocks.query.mockResolvedValue([{ root_path: root, role: 'owner' }, { root_path: `${root}/nested`, role: null }]);
    expect(await isPathWritableByRole(`${root}/nested/file`, 10, 'member')).toBe(false);
  });
  it('denies role-only management of nonmember project files', async () => {
    mocks.query.mockResolvedValue([{ root_path: root }]);
    expect(await isPathWritableByRole(`${root}/file`, 10, 'operator')).toBe(false);
    expect(mocks.query).toHaveBeenCalled();
  });
});

it.each(['/etc/passwd', '/var/lib/private.db', `${process.env.HOME}/tower/packages/backend/config.ts`, `${process.env.HOME}/.ssh/id_rsa`, `${root}/.env`, `${process.env.TOWER_DATA_DIR || process.env.DATA_DIR || `${process.env.TOWER_REPO_ROOT || `${process.env.HOME}/tower`}/data`}/session-attachments/7/private.png`])('operator file API rejects host/platform/private path %s', async (file) => {
  mocks.query.mockResolvedValue([{ root_path: root }, { root_path: `${process.env.HOME}/tower` }, { root_path: '/' }]);
  expect(await isPathAccessible(file, 10, 'operator')).toBe(false);
  expect(await isPathWritableByRole(file, 10, 'operator')).toBe(false);
});

it.each(['sessions/notes.md', 'credentials/provider.ts', 'secrets/README.md', '.github/workflows/test.yml', '.env.example', 'session-attachments/mock-fixture.png'])('invited operator may manage legitimate business path %s without name-based denial', async relative => {
  mocks.query.mockResolvedValue([{ root_path: root, role: 'member' }]);
  expect(await isPathAccessible(`${root}/${relative}`, 10, 'operator')).toBe(true);
  expect(await isPathWritableByRole(`${root}/${relative}`, 10, 'operator')).toBe(true);
});

it('keeps registered projects beneath the platform checkout excluded', async () => {
  const nested = `${process.env.TOWER_REPO_ROOT || `${process.env.HOME}/tower`}/workspace/projects/example`;
  mocks.query.mockResolvedValue([{ root_path: nested }]);
  expect(await isPathAccessible(`${nested}/business.md`, 10, 'operator')).toBe(false);
  expect(await isPathWritableByRole(`${nested}/business.md`, 10, 'operator')).toBe(false);
});

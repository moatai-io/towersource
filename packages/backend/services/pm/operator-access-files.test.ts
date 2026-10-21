import { beforeEach, describe, expect, it, vi } from 'vitest';
import path from 'node:path';
const { query } = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock('../../db/pg-repo.js', () => ({ query, queryOne: vi.fn() }));
import { isOperatorAccessProjectPath, isPathAccessible, isPathWritableByRole, buildToolGuard, wrapPiTools } from './project-access.js';
const root = process.env.TOWER_REPO_ROOT || path.join(process.env.HOME || '/tmp', 'tower');
const active = { root_path: root, role: null, enabled: true, status: 'active', archived: 0, membership_role: 'member' };
beforeEach(() => query.mockReset().mockResolvedValue([active]));
describe('current Operator access file authority', () => {
  it.each([isPathAccessible, isPathWritableByRole])('preserves explicit Project membership for operators', async check => {
    query.mockResolvedValue([{ ...active, role: 'member', enabled: false }]);
    expect(await check(`${root}/uploads/example.txt`, 7, 'operator')).toBe(true);
    expect(query.mock.calls[0][0]).toContain('LEFT JOIN project_members');
  });
  it('allows active operator project files', async () => {
    query.mockResolvedValueOnce([{ ...active, role: 'member' }]);
    expect(await isPathWritableByRole(`${root}/uploads/example.txt`, 7, 'operator')).toBe(true);
    expect(query.mock.calls[0][0]).toContain('project_members');
  });
  it.each([{ enabled: false }, { status: 'paused' }, { archived: 1 }])('rejects revoked or inactive authority %j', async override => {
    query
      .mockResolvedValueOnce([{ ...active, role: null, enabled: false }])
      .mockResolvedValueOnce([{ ...active, ...override }])
      .mockResolvedValueOnce([]);
    expect(await isPathWritableByRole(`${root}/example.ts`, 7, 'operator')).toBe(false);
  });
  it('denies role-only access without invitation', async () => {
    query.mockResolvedValue([{ ...active, membership_role: null }]);
    expect(await isOperatorAccessProjectPath(`${root}/example.ts`, 7)).toBe(false);
  });
  it('does not cache switch changes', async () => {
    expect(await isOperatorAccessProjectPath(`${root}/example.ts`, 7)).toBe(true);
    query.mockResolvedValue([{ ...active, enabled: false }]);
    expect(await isOperatorAccessProjectPath(`${root}/example.ts`, 7)).toBe(false);
  });
  it('honors the most specific project membership even when absent', async () => {
    query
      .mockResolvedValueOnce([{ ...active, role: 'member' }, { ...active, root_path: `${root}/nested`, role: null }])
      .mockResolvedValueOnce([{ ...active, enabled: false }, { ...active, root_path: `${root}/nested`, enabled: false }])
      .mockResolvedValueOnce([]);
    expect(await isPathAccessible(`${root}/nested/file.ts`, 7, 'operator')).toBe(false);
  });
  it('honors the most specific operator access project even when disabled', async () => {
    query.mockResolvedValue([active, { ...active, root_path: `${root}/nested`, enabled: false }]);
    expect(await isOperatorAccessProjectPath(`${root}/nested/file.ts`, 7)).toBe(false);
  });
  it.each(['/etc/example', `${root}/data/example`, `${root}/.env`, `${root}-other/file`])('rejects protected or unrelated target %s', async target => {
    expect(await isOperatorAccessProjectPath(target, 7)).toBe(false);
  });
  it('keeps viewer read-only', async () => {
    expect(await isPathWritableByRole(`${root}/example.ts`, 7, 'viewer')).toBe(false);
  });
  it('scopes the tool exception to its root and operator role', () => {
    const guard = buildToolGuard({
      role: 'operator',
      allowedPath: `${root}/workspace`,
      operatorWriteRoot: `${root}/src`,
    });
    expect(guard('Write', { file_path: `${root}/src/example.ts` }).allowed).toBe(true);
    expect(guard('Read', { path: `${root}/src/example.ts` }).allowed).toBe(true);
    expect(guard('Ls', { path: `${root}/src` }).allowed).toBe(true);
    expect(guard('CreateMarkdownArtifact', { file_path: `${root}/src/notes.md` }).allowed).toBe(true);
    expect(guard('Write', { file_path: `${root}/other/example.ts` }).allowed).toBe(false);
    expect(guard('Read', { path: `${root}/other/example.ts` }).allowed).toBe(false);
    expect(buildToolGuard({ role: 'member', allowedPath: `${root}/workspace`, operatorWriteRoot: root })('Write', { file_path: `${root}/example.ts` }).allowed).toBe(false);
  });
  it('refreshes the guard before every tool execution', async () => {
    const execute = vi.fn();
    const resolveGuard = vi.fn().mockResolvedValueOnce(() => ({ allowed: true })).mockResolvedValueOnce(() => ({ allowed: false, message: 'revoked' }));
    const [tool] = wrapPiTools([{ name: 'write', execute }], () => ({ allowed: true }), { resolveGuard });
    await tool.execute('1', { path: `${root}/example.ts` });
    await tool.execute('2', { path: `${root}/example.ts` });
    expect(execute).toHaveBeenCalledTimes(1);
  });
});

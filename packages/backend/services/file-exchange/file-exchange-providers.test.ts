import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const { canAccessSession, canWriteSessionContent } = vi.hoisted(() => ({ canAccessSession: vi.fn(), canWriteSessionContent: vi.fn() }));
vi.mock('../pm/project-access.js', () => ({
  canAccessSession,
  canWriteSessionContent,
  canAccessRoom: vi.fn(),
  isPathAccessible: vi.fn(),
  isPathWritableByRole: vi.fn(),
}));
import { assertFileDestination, reserveUniqueName } from './file-exchange-providers.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true }))); });

describe('File Exchange destination validation', () => {
  const actor = { userId: 7, role: 'member' };

  it('accepts the owner-only personal files directory', async () => {
    await expect(assertFileDestination(actor, { scope: 'personal', relativeDirectory: 'files/results' })).resolves.toBeUndefined();
  });

  it('allows the Session owner to target their Session', async () => {
    canWriteSessionContent.mockResolvedValueOnce({ allowed: true, reason: 'owner_match' });

    await expect(assertFileDestination(actor, { scope: 'session', sessionId: 'owned-session' })).resolves.toBeUndefined();
    expect(canWriteSessionContent).toHaveBeenCalledWith('owned-session', 7, 'member');
  });

  it('keeps viewer and guest session destinations read-only', async () => {
    await expect(assertFileDestination({ userId: 8, role: 'viewer' }, { scope: 'session', sessionId: 'shared-session' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(assertFileDestination({ userId: 9, role: 'guest' }, { scope: 'session', sessionId: 'shared-session' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('rejects a session destination when the actor cannot access the session', async () => {
    canWriteSessionContent.mockResolvedValueOnce({ allowed: false, status: 403, message: 'Access denied: Session content write requires Session ownership or admin/operator role' });

    await expect(assertFileDestination(actor, { scope: 'session', sessionId: 'private-session' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
});

describe('File Exchange exclusive destination reservation', () => {
  it('never overwrites an existing file and allocates a collision suffix', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tower-file-exchange-'));
    roots.push(root);
    await fs.writeFile(path.join(root, 'report.pdf'), 'original');

    const reserved = await reserveUniqueName(root, 'report.pdf');
    await reserved.handle.writeFile('copy');
    await reserved.handle.close();

    expect(reserved.name).toBe('report (1).pdf');
    expect(await fs.readFile(path.join(root, 'report.pdf'), 'utf8')).toBe('original');
    expect(await fs.readFile(reserved.path, 'utf8')).toBe('copy');
  });

  it('allocates distinct names under concurrent requests', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tower-file-exchange-'));
    roots.push(root);
    const [first, second] = await Promise.all([
      reserveUniqueName(root, 'same.txt'),
      reserveUniqueName(root, 'same.txt'),
    ]);
    await Promise.all([first.handle.close(), second.handle.close()]);

    expect(new Set([first.name, second.name]).size).toBe(2);
    expect([first.name, second.name].sort()).toEqual(['same (1).txt', 'same.txt']);
  });
});

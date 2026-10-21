import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import { probeWorkstationAccess } from './workstation-access-probe.js';
vi.mock('node:fs/promises', () => ({ default: { access: vi.fn() } }));
beforeEach(() => vi.resetAllMocks());
const failure = (code: string) => Object.assign(new Error('redacted path detail'), { code });
const target = { id: 'control', path: '/private/control', expected: 'inaccessible' as const };
describe('Workstation access probe', () => {
  it('flags readonly content replaceable through its parent', async () => {
    vi.mocked(fs.access).mockImplementation(async (path, mode) => {
      if (path === '/skills/a' && mode === constants.W_OK) throw failure('EACCES');
    });
    const [result] = await probeWorkstationAccess([{ id: 'skill', path: '/skills/a', expected: 'read-only' }]);
    expect(result).toMatchObject({ access: { read: 'allowed', write: 'denied', parentWrite: 'allowed' }, verdict: 'mismatch' });
  });
  it('reports denied access without returning paths or errors', async () => {
    vi.mocked(fs.access).mockRejectedValue(failure('EACCES'));
    const [result] = await probeWorkstationAccess([target]);
    expect(result.verdict).toBe('pass');
    expect(JSON.stringify(result)).not.toContain('/private');
    expect(JSON.stringify(result)).not.toContain('redacted path detail');
  });
  it.each(['ENOENT', 'ENOTDIR', 'EIO', 'ELOOP'])('does not certify protection on %s', async code => {
    vi.mocked(fs.access).mockRejectedValue(failure(code));
    expect((await probeWorkstationAccess([target]))[0].verdict).toBe('inconclusive');
  });
  it('does not hide confirmed exposure behind another failed check', async () => {
    vi.mocked(fs.access).mockImplementation(async (_path, mode) => {
      if (mode !== constants.R_OK) throw failure('EIO');
    });
    expect((await probeWorkstationAccess([target]))[0].verdict).toBe('mismatch');
  });
  it('requires readable and writable existing workspace', async () => {
    vi.mocked(fs.access).mockResolvedValue();
    expect((await probeWorkstationAccess([{ ...target, expected: 'read-write' }]))[0].verdict).toBe('pass');
  });
  it('bounds target count', async () => {
    await expect(probeWorkstationAccess(Array(65).fill(target))).rejects.toThrow('PROBE_LIMIT');
  });
});

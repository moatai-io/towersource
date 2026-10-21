import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const db = vi.hoisted(() => ({ queryOne: vi.fn(), execute: vi.fn() }));
vi.mock('../../config.js', () => ({ config: { jwtSecret: 'synthetic-renewal-test' } }));
vi.mock('../../db/pg-repo.js', () => ({ transaction: async (fn: any) => fn({}), withClient: () => db }));
import { issueWorkbenchWorkerIdentity, verifyWorkbenchWorkerIdentity } from './workbench-worker-identity.js';
import { renewLocalWorkerIdentity } from './workbench-worker-identity-renewal.js';
let dir: string, file: string;
function setup(expiresIn = '2d') {
  const issued = issueWorkbenchWorkerIdentity({ workerId: 'w', projectIds: ['p'], capabilities: ['job'], expiresIn });
  fs.writeFileSync(file, issued.token, { mode: 0o640 });
  const row = { worker_id: 'w', project_ids: ['p'], capabilities: ['job'], jti: issued.identity.jti,
    expires_at: issued.identity.expiresAt, revoked_at: null, replaced_by_jti: null };
  db.queryOne.mockResolvedValue(row);
  return { issued, row };
}
beforeEach(() => { vi.clearAllMocks(); db.execute.mockResolvedValue({ changes: 1 }); dir = fs.mkdtempSync(path.join(os.tmpdir(), 'renew-test-')); file = path.join(dir, 'identity'); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); vi.restoreAllMocks(); });
describe('same-host Worker identity renewal', () => {
  it('renews near expiry with identical scope and revocation handle, preserving mode', async () => {
    const { issued } = setup();
    expect(await renewLocalWorkerIdentity('w', file)).toMatchObject({ status: 'renewed' });
    const next = verifyWorkbenchWorkerIdentity(fs.readFileSync(file, 'utf8').trim())!;
    expect(next).toMatchObject({ workerId: 'w', projectIds: ['p'], capabilities: ['job'], jti: issued.identity.jti });
    expect(Date.parse(next.expiresAt) - Date.now()).toBeGreaterThan(29 * 86400_000);
    expect(fs.statSync(file).mode & 0o777).toBe(0o640);
    expect(fs.readdirSync(dir)).toEqual(['identity']);
  });
  it('does not renew healthy long-lived identity', async () => {
    const { issued } = setup('30d');
    expect(await renewLocalWorkerIdentity('w', file)).toEqual({ status: 'not-due' });
    expect(db.execute).not.toHaveBeenCalled(); expect(fs.readFileSync(file, 'utf8')).toBe(issued.token);
  });
  it.each(['revoked', 'replaced', 'expired-db', 'scope', 'worker', 'missing'])('rejects %s audit without touching token', async kind => {
    const { issued, row } = setup();
    if (kind === 'revoked') Object.assign(row, { revoked_at: new Date().toISOString() });
    if (kind === 'replaced') Object.assign(row, { replaced_by_jti: 'new' });
    if (kind === 'expired-db') row.expires_at = new Date(0).toISOString();
    if (kind === 'scope') row.project_ids = ['other'];
    if (kind === 'worker') row.worker_id = 'other';
    if (kind === 'missing') db.queryOne.mockResolvedValue(undefined);
    await expect(renewLocalWorkerIdentity('w', file)).rejects.toThrow('INACTIVE');
    expect(db.execute).not.toHaveBeenCalled(); expect(fs.readFileSync(file, 'utf8')).toBe(issued.token);
  });
  it('rejects expired JWT and wrong Worker', async () => {
    setup('-1s'); await expect(renewLocalWorkerIdentity('w', file)).rejects.toThrow('INVALID');
    setup(); await expect(renewLocalWorkerIdentity('other', file)).rejects.toThrow('INVALID');
  });
  it('rejects symlink and group-writable target', async () => {
    setup(); const link = path.join(dir, 'link'); fs.symlinkSync(file, link);
    await expect(renewLocalWorkerIdentity('w', link)).rejects.toThrow('UNSAFE');
    fs.chmodSync(file, 0o660); await expect(renewLocalWorkerIdentity('w', file)).rejects.toThrow('UNSAFE');
  });
  it('retries file-ahead-of-DB partial update', async () => {
    const { row } = setup('30d'); row.expires_at = new Date(Date.now() + 86400_000).toISOString();
    expect(await renewLocalWorkerIdentity('w', file)).toMatchObject({ status: 'renewed' });
  });
  it('leaves old token and cleans temporary file on DB failure', async () => {
    const { issued } = setup(); db.execute.mockRejectedValueOnce(new Error('db unavailable'));
    await expect(renewLocalWorkerIdentity('w', file)).rejects.toThrow('db unavailable');
    expect(fs.readFileSync(file, 'utf8')).toBe(issued.token); expect(fs.readdirSync(dir)).toEqual(['identity']);
  });
  it('fails safely on atomic install failure and retries', async () => {
    const { issued } = setup(); const rename = vi.spyOn(fs, 'renameSync').mockImplementationOnce(() => { throw new Error('disk'); });
    await expect(renewLocalWorkerIdentity('w', file)).rejects.toThrow('disk');
    expect(fs.readFileSync(file, 'utf8')).toBe(issued.token); expect(fs.readdirSync(dir)).toEqual(['identity']);
    rename.mockRestore(); expect(await renewLocalWorkerIdentity('w', file)).toMatchObject({ status: 'renewed' });
  });
});

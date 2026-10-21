import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { applyCanonicalProjectMigration, planCanonicalProjectMigration, type CanonicalProjectMigrationDeps, type CanonicalProjectMigrationPlan } from './canonical-project-migration.js';

const roots: string[] = [];
const policy = { version: 1 as const, mode: 'shared-local' as const, backendUid: process.getuid!(), workerUid: process.getuid!() === 65534 ? 65533 : 65534, projectParents: [] as string[] };

afterEach(() => { vi.restoreAllMocks(); for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

function fixture(storage: 'none' | 'host' | 'worker' = 'none') {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'canonical-migration-')); roots.push(parent);
  const root = path.join(parent, 'project'); fs.mkdirSync(root); const file = path.join(root, 'file.txt'); fs.writeFileSync(file, 'x');
  policy.projectParents = [parent];
  const project = { id: 'p', name: 'Project', root_path: root, archived: 0, lifecycle_status: 'active', system_key: null,
    storage_kind: storage === 'none' ? null : storage, storage_worker_id: storage === 'worker' ? 'w' : null,
    storage_state: storage === 'none' ? null : 'ready' as const, storage_version: storage === 'none' ? null : 1 };
  const deps: CanonicalProjectMigrationDeps = {
    loadProject: vi.fn(async () => project as any), readPolicy: vi.fn(() => ({ ...policy, projectParents: [...policy.projectParents] })),
    runPreflight: vi.fn(() => ({ status: 'blocked', mutated: false, scanned: 2, blockingCount: 1, excludedCount: 0, findingsTruncated: false,
      findings: [{ path: file, reason: 'worker-access-missing', blocking: true }], repairCandidates: [{ path: file, reason: 'worker-access-missing' }] })),
    readAcl: vi.fn((_p, kind) => kind === 'access' ? 'user::rw-' : ''), stat: p => fs.lstatSync(p),
    applyAcl: vi.fn(), restoreAcl: vi.fn(), verifyWorkerAccess: vi.fn(), verifyBackendAccess: vi.fn(), persistHostBinding: vi.fn(),
    now: vi.fn(() => new Date('2026-09-18T00:00:00.000Z')),
  };
  return { parent, root, file, project, deps };
}

async function plan(f = fixture()) { return { ...f, migration: await planCanonicalProjectMigration({ projectId: 'p', deploymentId: 'production' }, f.deps) }; }

it('plans exact ACL metadata and a host binding without mutating', async () => {
  const { migration, file, deps } = await plan();
  expect(migration.storageAction).toBe('insert_host_ready');
  expect(migration.aclChanges[0]).toEqual(expect.objectContaining({ path: file, relativePath: 'file.txt', reason: 'worker-access-missing', accessAcl: 'user::rw-' }));
  expect(migration.planHash).toMatch(/^[a-f0-9]{64}$/);
  expect(deps.applyAcl).not.toHaveBeenCalled(); expect(deps.persistHostBinding).not.toHaveBeenCalled();
});

it('rejects legacy Worker storage and unsupported or incomplete findings', async () => {
  const worker = fixture('worker');
  await expect(planCanonicalProjectMigration({ projectId: 'p' }, worker.deps)).rejects.toThrow('LEGACY_WORKER_STORAGE_EXCLUDED');
  const unsupported = fixture();
  vi.mocked(unsupported.deps.runPreflight).mockReturnValue({ status: 'blocked', mutated: false, scanned: 1, blockingCount: 1, excludedCount: 0,
    findings: [{ path: unsupported.file, reason: 'hardlink-excluded', blocking: true }], repairCandidates: [] });
  await expect(planCanonicalProjectMigration({ projectId: 'p' }, unsupported.deps)).rejects.toThrow('PREFLIGHT_UNSUPPORTED_FINDING');
});

it('rejects candidates outside the root and protected paths', async () => {
  const outside = fixture();
  vi.mocked(outside.deps.runPreflight).mockReturnValue({ status: 'blocked', mutated: false, scanned: 1, blockingCount: 1, excludedCount: 0,
    findings: [{ path: outside.parent, reason: 'worker-access-missing', blocking: true }], repairCandidates: [{ path: outside.parent, reason: 'worker-access-missing' }] });
  await expect(planCanonicalProjectMigration({ projectId: 'p' }, outside.deps)).rejects.toThrow('CANDIDATE_OUTSIDE_ROOT');
  const protectedFixture = fixture(); fs.mkdirSync(path.join(protectedFixture.root, '.tower')); const target = path.join(protectedFixture.root, '.tower', 'x'); fs.writeFileSync(target, 'x');
  vi.mocked(protectedFixture.deps.runPreflight).mockReturnValue({ status: 'blocked', mutated: false, scanned: 1, blockingCount: 1, excludedCount: 0,
    findings: [{ path: target, reason: 'worker-access-missing', blocking: true }], repairCandidates: [{ path: target, reason: 'worker-access-missing' }] });
  await expect(planCanonicalProjectMigration({ projectId: 'p' }, protectedFixture.deps)).rejects.toThrow('PROTECTED_PATH');
});

it('requires exact approval and rejects stale metadata before mutation', async () => {
  const { migration, deps, file, parent } = await plan();
  const receipts = path.join(parent, 'receipts'); fs.mkdirSync(receipts, { mode: 0o700 });
  await expect(applyCanonicalProjectMigration({ plan: migration, approvedHash: '0'.repeat(64), receiptDirectory: receipts }, deps)).rejects.toThrow('APPROVAL_MISMATCH');
  fs.chmodSync(file, 0o600);
  await expect(applyCanonicalProjectMigration({ plan: migration, approvedHash: migration.planHash, receiptDirectory: receipts }, deps)).rejects.toThrow('STALE_PLAN');
  expect(deps.applyAcl).not.toHaveBeenCalled();
});

it('applies ACLs, verifies both identities, then persists storage and a verified receipt', async () => {
  const { migration, deps, parent } = await plan();
  const receipts = path.join(parent, 'receipts'); fs.mkdirSync(receipts, { mode: 0o700 });
  const result = await applyCanonicalProjectMigration({ plan: migration, approvedHash: migration.planHash, receiptDirectory: receipts }, deps);
  expect(result.status).toBe('verified');
  expect(deps.applyAcl).toHaveBeenCalledTimes(1);
  expect(deps.verifyWorkerAccess).toHaveBeenCalled(); expect(deps.verifyBackendAccess).toHaveBeenCalled();
  expect(deps.persistHostBinding).toHaveBeenCalledWith('p', 'production');
  expect(JSON.parse(fs.readFileSync(result.receipt, 'utf8')).status).toBe('verified');
  expect(fs.statSync(result.receipt).mode & 0o777).toBe(0o600);
});

it('restores the ACL snapshot when smoke or binding persistence fails', async () => {
  const { migration, deps, parent } = await plan();
  const receipts = path.join(parent, 'receipts'); fs.mkdirSync(receipts, { mode: 0o700 });
  vi.mocked(deps.verifyWorkerAccess).mockImplementation(() => { throw new Error('smoke failed'); });
  await expect(applyCanonicalProjectMigration({ plan: migration, approvedHash: migration.planHash, receiptDirectory: receipts }, deps)).rejects.toThrow('smoke failed');
  expect(deps.restoreAcl).toHaveBeenCalledTimes(1); expect(deps.persistHostBinding).not.toHaveBeenCalled();
  const receipt = fs.readdirSync(receipts).find(name => name.endsWith('.json'))!;
  expect(JSON.parse(fs.readFileSync(path.join(receipts, receipt), 'utf8')).status).toBe('rolled_back');
});

it('treats an existing canonical host binding as an idempotent no-op', async () => {
  const host = fixture('host');
  const migration = await planCanonicalProjectMigration({ projectId: 'p' }, host.deps);
  expect(migration.storageAction).toBe('no_action');
  const receipts = path.join(host.parent, 'receipts'); fs.mkdirSync(receipts, { mode: 0o700 });
  await applyCanonicalProjectMigration({ plan: migration, approvedHash: migration.planHash, receiptDirectory: receipts }, host.deps);
  expect(host.deps.persistHostBinding).not.toHaveBeenCalled();
});

it('includes backend-only denials in a bounded plan and passes both identities', async () => {
  const f = fixture();
  const candidate = path.join(f.root, 'file.txt');
  vi.mocked(f.deps.runPreflight).mockReturnValue({ status: 'blocked', mutated: false, scanned: 2, blockingCount: 1, excludedCount: 0,
    findings: [{ path: candidate, reason: 'backend-access-missing', blocking: true }],
    repairCandidates: [{ path: candidate, reason: 'backend-access-missing' }] });
  const plan = await planCanonicalProjectMigration({ projectId: 'p' }, f.deps);
  expect(f.deps.runPreflight).toHaveBeenCalledWith(f.root, policy.workerUid, policy.backendUid);
  expect(plan.aclChanges.map(item => item.reason)).toContain('backend-access-missing');
  expect(f.deps.applyAcl).not.toHaveBeenCalled();
});

it('accepts backend default inheritance gaps without bypassing truncation', async () => {
  const f = fixture();
  const report = { status: 'blocked', mutated: false, scanned: 1, blockingCount: 1, excludedCount: 0,
    findings: [{ path: f.root, reason: 'backend-default-inheritance-missing', blocking: true }],
    repairCandidates: [{ path: f.root, reason: 'backend-default-inheritance-missing' }] };
  vi.mocked(f.deps.runPreflight).mockReturnValue(report);
  expect((await planCanonicalProjectMigration({ projectId: 'p' }, f.deps)).aclChanges[0].reason).toBe('backend-default-inheritance-missing');
  vi.mocked(f.deps.runPreflight).mockReturnValue({ ...report, findingsTruncated: true });
  await expect(planCanonicalProjectMigration({ projectId: 'p' }, f.deps)).rejects.toThrow('PREFLIGHT_UNUSABLE');
});

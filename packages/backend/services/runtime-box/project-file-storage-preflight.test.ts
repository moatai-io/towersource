import { describe, expect, it } from 'vitest';
import { planProjectFileStoragePreflight as plan, type StoragePreflightInput } from './project-file-storage-preflight.js';
function fixture(): StoragePreflightInput {
  const common = { projectId: 'p', deploymentId: 'production', scope: 'project-root' as const, complete: true, capturedAt: 1000, entries: [{ path: 'final/한글 파일.html', type: 'file' as const, sizeBytes: 3, sha256: 'a'.repeat(64) }] };
  return { projectId: 'p', deploymentId: 'production', target: { kind: 'host', workerId: null }, host: { ...structuredClone(common), source: { kind: 'host', workerId: null } }, worker: { ...structuredClone(common), source: { kind: 'worker', workerId: 'w' } }, now: 2000 };
}
describe('storage preflight evidence comparison', () => {
  it('does not confuse identical content with ready storage or approval', () => {
    expect(plan(fixture())).toMatchObject({ status: 'content-matched', readyToActivate: false, differences: [] });
  });
  it('does not treat empty matching storage as ready', () => {
    const input = fixture(); input.host.entries = []; input.worker.entries = [];
    expect(plan(input).readyToActivate).toBe(false);
  });
  it('reports divergent contents and one-sided files without selecting a winner', () => {
    const input = fixture(); input.worker.entries[0].sha256 = 'b'.repeat(64);
    input.host.entries.push({ path: 'host.txt', type: 'file', sizeBytes: 1, sha256: 'c'.repeat(64) });
    input.worker.entries.push({ path: 'worker.txt', type: 'file', sizeBytes: 1, sha256: 'd'.repeat(64) });
    expect(plan(input).differences.map(d => d.reason)).toEqual(['content-conflict', 'host-only', 'worker-only']);
  });
  it('detects file-directory conflicts', () => {
    const input = fixture(); input.worker.entries[0] = { path: input.host.entries[0].path, type: 'directory' };
    expect(plan(input).differences[0].reason).toBe('type-conflict');
  });
  it.each(['../escape', '/absolute', 'a//b', 'a/./b', 'a\\b', 'nul\0'])('rejects invalid manifest path %s', path => {
    const input = fixture(); input.host.entries[0].path = path;
    expect(() => plan(input)).toThrow('PATH_INVALID');
  });
  it('rejects duplicate paths and descendants of files', () => {
    const input = fixture(); input.host.entries.push({ ...input.host.entries[0] });
    expect(() => plan(input)).toThrow('PATH_INVALID');
    input.host.entries[1].path += '/child';
    expect(() => plan(input)).toThrow('PATH_INVALID');
  });
  it('rejects missing hashes, truncated snapshots, stale and mismatched evidence', () => {
    let input = fixture(); delete input.host.entries[0].sha256;
    expect(() => plan(input)).toThrow('HASH_REQUIRED');
    input = fixture(); input.worker.complete = false;
    expect(() => plan(input)).toThrow('INCOMPLETE');
    input = fixture(); input.now = 100000;
    expect(() => plan(input)).toThrow('STALE');
    input = fixture(); input.worker.projectId = 'other';
    expect(() => plan(input)).toThrow('SCOPE_MISMATCH');
    input = fixture(); input.target = { kind: 'worker', workerId: 'other' };
    expect(() => plan(input)).toThrow('TARGET_MISMATCH');
  });
  it('binds the evidence hash to content and target, independent of entry ordering', () => {
    const input = fixture(); input.host.entries.push({ path: 'a', type: 'directory' });
    const hash = plan(input).evidenceHash; input.host.entries.reverse();
    expect(plan(input).evidenceHash).toBe(hash);
    input.target = { kind: 'worker', workerId: 'w' };
    expect(plan(input).evidenceHash).not.toBe(hash);
  });
});

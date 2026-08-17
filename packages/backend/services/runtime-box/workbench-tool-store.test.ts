import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { stableManifestHash, stableManifestJson, type WorkbenchToolManifest } from './workbench-tools.js';
import {
  createManagedWorkbenchToolStoreCandidate,
  finalizeManagedWorkbenchToolStoreCandidate,
  managedWorkbenchToolStoreRef,
  readAndVerifyManagedWorkbenchToolRevision,
  resolveManagedWorkbenchToolStoreLocation,
  WorkbenchToolStoreError,
} from './workbench-tool-store.js';

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach(root => fs.rmSync(root, { recursive: true, force: true })));

function fixture(): { root: string; manifest: WorkbenchToolManifest; ref: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tower-workbench-store-'));
  roots.push(root);
  const ref = managedWorkbenchToolStoreRef('project-1', 4);
  const revision = path.join(root, ref);
  fs.mkdirSync(path.join(revision, 'bin'), { recursive: true });
  fs.writeFileSync(path.join(revision, 'bin', 'cowsay'), '#!/bin/sh\n');
  const manifest: WorkbenchToolManifest = {
    schemaVersion: 1,
    workbenchId: 'project-1',
    revision: 4,
    createdAt: '2026-07-31T00:00:00.000Z',
    createdBy: { userId: 1, sessionId: null, jobId: null },
    manager: 'uv-tool',
    tools: [{ name: 'cowsay', version: '6.1', entrypoints: ['cowsay'], installSpec: 'cowsay==6.1' }],
    paths: { prefix: '.runtime-box/workbench-tools/revisions/000004', bin: '.runtime-box/workbench-tools/revisions/000004/bin' },
    validation: { status: 'passed', commands: [{ cmd: 'cowsay --version', exitCode: 0 }] },
    previousRevision: 3,
    rollbackRef: null,
  };
  fs.writeFileSync(path.join(revision, 'manifest.json'), stableManifestJson(manifest));
  return { root, manifest, ref };
}

describe('Workbench managed tool store', () => {
  it('builds an opaque Project/revision store ref and resolves only below the managed root', () => {
    const ref = managedWorkbenchToolStoreRef('project-1', 4);
    expect(ref).toBe('projects/project-1/revisions/000004');
    expect(resolveManagedWorkbenchToolStoreLocation({ projectId: 'project-1', revision: 4, storeRef: ref, storeRoot: '/data/workbench' }).revisionPath)
      .toBe('/data/workbench/projects/project-1/revisions/000004');
    expect(() => resolveManagedWorkbenchToolStoreLocation({ projectId: 'project-2', revision: 4, storeRef: ref, storeRoot: '/data/workbench' }))
      .toThrow(WorkbenchToolStoreError);
  });

  it('verifies Project identity, manifest hash, and entrypoints', () => {
    const { root, manifest, ref } = fixture();
    const result = readAndVerifyManagedWorkbenchToolRevision({
      projectId: 'project-1', revision: 4, storeRef: ref,
      expectedManifestHash: stableManifestHash(manifest), storeRoot: root,
    });
    expect(result.revisionPath).toBe(path.join(root, ref));
    fs.rmSync(path.join(root, ref, 'bin', 'cowsay'));
    expect(() => readAndVerifyManagedWorkbenchToolRevision({
      projectId: 'project-1', revision: 4, storeRef: ref,
      expectedManifestHash: stableManifestHash(manifest), storeRoot: root,
    })).toThrow('entrypoint missing');
  });

  it('verifies registry release evidence when present and rejects evidence drift even with a recomputed manifest hash', () => {
    const { root, manifest, ref } = fixture();
    const evidenced: WorkbenchToolManifest = {
      ...manifest,
      registryReleaseEvidence: [{
        status: 'verified', registry: 'pypi', package: 'cowsay', version: '6.1',
        metadataUrl: 'https://pypi.org/pypi/cowsay/6.1/json', checkedAt: '2026-08-04T00:00:00.000Z',
        limitation: 'registry-release-file-set-not-selected-artifact',
        artifacts: [{
          filename: 'cowsay-6.1-py3-none-any.whl', packageType: 'bdist_wheel', sha256: 'a'.repeat(64), size: 10,
          url: 'https://files.pythonhosted.org/packages/a/cowsay.whl',
        }],
      }],
    };
    fs.writeFileSync(path.join(root, ref, 'manifest.json'), stableManifestJson(evidenced));
    expect(() => readAndVerifyManagedWorkbenchToolRevision({
      projectId: 'project-1', revision: 4, storeRef: ref,
      expectedManifestHash: stableManifestHash(evidenced), storeRoot: root,
    })).not.toThrow();

    const tampered: WorkbenchToolManifest = {
      ...evidenced,
      registryReleaseEvidence: evidenced.registryReleaseEvidence!.map(item => ({ ...item, package: 'other-package' })),
    };
    fs.writeFileSync(path.join(root, ref, 'manifest.json'), stableManifestJson(tampered));
    expect(() => readAndVerifyManagedWorkbenchToolRevision({
      projectId: 'project-1', revision: 4, storeRef: ref,
      expectedManifestHash: stableManifestHash(tampered), storeRoot: root,
    })).toThrow(/identity mismatch|evidence missing/);
  });

  it('finalizes staging atomically, verifies final path, and refuses revision reuse', async () => {
    const { root, manifest, ref } = fixture();
    const finalized = path.join(root, ref);
    fs.rmSync(finalized, { recursive: true, force: true });
    const candidate = await createManagedWorkbenchToolStoreCandidate({ projectId: 'project-1', revision: 4, commandId: 'command-1', storeRoot: root });
    fs.mkdirSync(path.join(candidate.stagingPath, 'bin'), { recursive: true });
    fs.writeFileSync(path.join(candidate.stagingPath, 'bin', 'cowsay'), '#!/bin/sh\n');
    const completed = await finalizeManagedWorkbenchToolStoreCandidate({ candidate, manifest });
    expect(completed.revisionPath).toBe(finalized);
    expect(fs.existsSync(candidate.stagingPath)).toBe(false);
    expect(readAndVerifyManagedWorkbenchToolRevision({ projectId: 'project-1', revision: 4, storeRef: ref, expectedManifestHash: stableManifestHash(manifest), storeRoot: root }).manifest)
      .toMatchObject({ revision: 4 });
    await expect(createManagedWorkbenchToolStoreCandidate({ projectId: 'project-1', revision: 4, commandId: 'command-2', storeRoot: root }))
      .rejects.toThrow('already exists');
  });

  it('rejects a symlinked revision source', () => {
    const { root, manifest, ref } = fixture();
    const real = path.join(root, 'real-copy');
    fs.renameSync(path.join(root, ref), real);
    fs.symlinkSync(real, path.join(root, ref), 'dir');
    expect(() => readAndVerifyManagedWorkbenchToolRevision({
      projectId: 'project-1', revision: 4, storeRef: ref,
      expectedManifestHash: stableManifestHash(manifest), storeRoot: root,
    })).toThrow(/real directory|symlink/);
  });

  it('rejects any payload symlink that escapes the immutable revision', () => {
    const { root, manifest, ref } = fixture();
    fs.symlinkSync('/etc/passwd', path.join(root, ref, 'tools-escape'));
    expect(() => readAndVerifyManagedWorkbenchToolRevision({
      projectId: 'project-1', revision: 4, storeRef: ref,
      expectedManifestHash: stableManifestHash(manifest), storeRoot: root,
    })).toThrow('payload symlink escaped managed revision');
  });

  function expectRuntimeInterpreterFailure(
    setup: (bin: string) => void,
    expected: string,
  ): void {
    const { root, manifest, ref } = fixture();
    const bin = path.join(root, ref, 'tools', 'cowsay', 'bin');
    fs.mkdirSync(bin, { recursive: true });
    setup(bin);
    let thrown: unknown;
    try {
      readAndVerifyManagedWorkbenchToolRevision({
        projectId: 'project-1', revision: 4, storeRef: ref,
        expectedManifestHash: stableManifestHash(manifest), storeRoot: root,
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(WorkbenchToolStoreError);
    expect((thrown as Error).message).toContain(expected);
  }

  it('allows a bounded Python sibling chain ending at an exact runtime interpreter allowlist path', () => {
    const { root, manifest, ref } = fixture();
    const bin = path.join(root, ref, 'tools', 'cowsay', 'bin');
    fs.mkdirSync(bin, { recursive: true });
    fs.symlinkSync('python3', path.join(bin, 'python'));
    fs.symlinkSync('python3.12', path.join(bin, 'python3'));
    fs.symlinkSync('/usr/local/bin/python3.12', path.join(bin, 'python3.12'));
    expect(() => readAndVerifyManagedWorkbenchToolRevision({
      projectId: 'project-1', revision: 4, storeRef: ref,
      expectedManifestHash: stableManifestHash(manifest), storeRoot: root,
    })).not.toThrow();
  });

  it('rejects a missing Python sibling with WorkbenchToolStoreError', () => {
    expectRuntimeInterpreterFailure(bin => fs.symlinkSync('python3', path.join(bin, 'python')), 'link in chain is missing');
  });

  it('rejects a regular-file Python sibling with WorkbenchToolStoreError', () => {
    expectRuntimeInterpreterFailure(bin => {
      fs.symlinkSync('python3', path.join(bin, 'python'));
      fs.writeFileSync(path.join(bin, 'python3'), '#!/bin/sh\n');
    }, 'link in chain resolved to a regular filesystem entry');
  });

  it('rejects a cyclic Python sibling chain with WorkbenchToolStoreError', () => {
    expectRuntimeInterpreterFailure(bin => {
      fs.symlinkSync('python3', path.join(bin, 'python'));
      fs.symlinkSync('python', path.join(bin, 'python3'));
    }, 'cycle detected');
  });

  it('rejects a Python chain escaping to /tmp with WorkbenchToolStoreError', () => {
    expectRuntimeInterpreterFailure(bin => fs.symlinkSync('/tmp/python3', path.join(bin, 'python')), 'final target is outside the runtime interpreter allowlist');
  });

  it('rejects a non-allowlisted absolute interpreter target with the explicit fail-closed contract', () => {
    expectRuntimeInterpreterFailure(bin => fs.symlinkSync('/usr/bin/env', path.join(bin, 'python')), 'runtime interpreter symlink invalid');
  });
});

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { queryOne } from '../../db/pg-repo.js';
import {
  assertSafeToolSpec,
  classifyWorkbenchToolRuntimeObservation,
  inspectWorkbenchTools,
  revisionName,
  stableManifestHash,
  stableManifestJson,
  uvToolInstallCommand,
  withWorkbenchToolPath,
  type WorkbenchToolManifest,
} from './workbench-tools.js';

vi.mock('../../db/pg-repo.js', () => ({
  queryOne: vi.fn(),
  transaction: vi.fn(),
  withClient: vi.fn(),
}));

const tempDirs: string[] = [];
afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
  vi.clearAllMocks();
});

const manifest: WorkbenchToolManifest = {
  schemaVersion: 1,
  workbenchId: 'project-a',
  revision: 1,
  createdAt: '2026-07-31T00:00:00.000Z',
  createdBy: { userId: 7, sessionId: 'session-a', jobId: 'job-a' },
  manager: 'uv-tool',
  tools: [{ name: 'cowsay', version: '6.1', entrypoints: ['cowsay'], installSpec: 'cowsay==6.1' }],
  paths: { prefix: '.runtime-box/workbench-tools/revisions/000001', bin: '.runtime-box/workbench-tools/revisions/000001/bin' },
  validation: { status: 'passed', commands: [{ cmd: 'cowsay --version', exitCode: 0 }] },
  previousRevision: null,
  rollbackRef: null,
};

describe('Workbench tool manifest primitives', () => {
  it('uses fixed-width immutable revision names', () => {
    expect(revisionName(1)).toBe('000001');
    expect(revisionName(42)).toBe('000042');
    expect(() => revisionName(0)).toThrow('positive integer');
  });

  it('hashes the same manifest deterministically and changes on revision changes', () => {
    expect(stableManifestHash(manifest)).toBe(stableManifestHash({ ...manifest }));
    expect(stableManifestHash(manifest)).not.toBe(stableManifestHash({ ...manifest, revision: 2 }));
  });

  it('rejects shell metacharacters and missing entrypoints', () => {
    expect(() => assertSafeToolSpec({ name: 'safe-cli', version: '1.2.3', entrypoints: ['safe-cli'] })).not.toThrow();
    expect(() => assertSafeToolSpec({ name: 'x;rm', version: '1', entrypoints: ['x'] })).toThrow('unsafe tool name');
    expect(() => assertSafeToolSpec({ name: 'x', version: '1', entrypoints: [] })).toThrow('entrypoints');
  });

  it.each([
    ['absent', undefined, 2, { runtimeStatus: 'absent', projectionStatus: null, mountedRevision: null, recreateStatus: 'not_required', recreateRequired: false }],
    ['stopped without projection', { status: 'stopped', projection_status: null, mounted_revision: null }, 2, { runtimeStatus: 'stopped', recreateStatus: 'not_required', recreateRequired: false }],
    ['stopped with recovery projection', { status: 'stopped', projection_status: 'recovery_required', mounted_revision: 1 }, 2, { runtimeStatus: 'stopped', recreateStatus: 'not_required', recreateRequired: false }],
    ['running mounted current', { status: 'running', projection_status: 'mounted', mounted_revision: 2 }, 2, { runtimeStatus: 'running', projectionStatus: 'mounted', mountedRevision: 2, recreateStatus: 'not_required', recreateRequired: false }],
    ['running mounted stale', { status: 'running', projection_status: 'mounted', mounted_revision: 1 }, 2, { runtimeStatus: 'running', projectionStatus: 'mounted', mountedRevision: 1, recreateStatus: 'required', recreateRequired: true }],
    ['running missing projection', { status: 'running', projection_status: null, mounted_revision: null }, 2, { runtimeStatus: 'running', recreateStatus: 'unknown', recreateRequired: null }],
    ['running failed projection', { status: 'running', projection_status: 'failed', mounted_revision: 1 }, 2, { runtimeStatus: 'running', recreateStatus: 'unknown', recreateRequired: null }],
    ['running mounting projection', { status: 'running', projection_status: 'mounting', mounted_revision: 1 }, 2, { runtimeStatus: 'running', recreateStatus: 'unknown', recreateRequired: null }],
    ['running unmounted projection', { status: 'running', projection_status: 'unmounted', mounted_revision: 1 }, 2, { runtimeStatus: 'running', recreateStatus: 'unknown', recreateRequired: null }],
    ['running recovery projection', { status: 'running', projection_status: 'recovery_required', mounted_revision: 1 }, 2, { runtimeStatus: 'running', recreateStatus: 'unknown', recreateRequired: null }],
    ['running mounted null revision', { status: 'running', projection_status: 'mounted', mounted_revision: null }, 2, { runtimeStatus: 'running', recreateStatus: 'unknown', recreateRequired: null }],
    ['running mounted with unknown current', { status: 'running', projection_status: 'mounted', mounted_revision: 1 }, null, { runtimeStatus: 'running', recreateStatus: 'unknown', recreateRequired: null }],
    ['unknown runtime lifecycle', { status: 'starting', projection_status: 'mounted', mounted_revision: 1 }, 1, { runtimeStatus: 'unknown', recreateStatus: 'unknown', recreateRequired: null }],
  ] as const)('classifies runtime projection lifecycle fail-closed: %s', (_label, row, currentRevision, expected) => {
    expect(classifyWorkbenchToolRuntimeObservation(row, currentRevision)).toMatchObject(expected);
  });

  it('builds a pinned credential-free uv command only under the managed candidate root', () => {
    const command = uvToolInstallCommand({ name: 'cowsay', version: '6.1', entrypoints: ['cowsay'] }, '/workspace/.runtime-box/workbench-tools/active');
    expect(command).toContain('UV_TOOL_DIR=');
    expect(command).toContain('UV_TOOL_BIN_DIR=');
    expect(command).toContain("'cowsay==6.1'");
    expect(command).toContain('/workspace/.runtime-box/workbench-tools/active');
    expect(() => uvToolInstallCommand({ name: 'cowsay', version: '6.1', entrypoints: ['cowsay'] }, '/workspace/.runtime-box/workbench-tools/revisions/000001')).toThrow('final Runtime projection target');
  });

  it('prepends the active project tool prefix while preserving caller PATH', () => {
    expect(withWorkbenchToolPath('/custom/bin:/usr/bin')).toBe('/workspace/.runtime-box/workbench-tools/active/bin:/opt/tower-tools/bin:/custom/bin:/usr/bin');
    expect(withWorkbenchToolPath(undefined)).toContain('/opt/tower-tools/bin:/usr/local/sbin:/usr/local/bin');
  });

  it('detects matching and divergent database/filesystem pointers', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'workbench-tools-'));
    tempDirs.push(root);
    const toolsRoot = path.join(root, '.runtime-box', 'workbench-tools');
    await fs.mkdir(path.join(toolsRoot, 'revisions', '000001', 'bin'), { recursive: true });
    await fs.mkdir(path.join(toolsRoot, 'manifests', 'revisions'), { recursive: true });
    await fs.writeFile(path.join(toolsRoot, 'revisions', '000001', 'bin', 'cowsay'), '#!/bin/sh\n');
    await fs.writeFile(path.join(toolsRoot, 'manifests', 'revisions', '000001.json'), stableManifestJson(manifest));
    await fs.symlink('revisions/000001', path.join(toolsRoot, 'active'));
    vi.mocked(queryOne).mockResolvedValueOnce({ current_revision: 1, health: 'healthy', manifest, manifest_hash: stableManifestHash(manifest), prefix_relpath: manifest.paths.prefix });
    await expect(inspectWorkbenchTools({ projectId: 'project-a', projectRoot: root })).resolves.toMatchObject({ dbRevision: 1, filesystemRevision: 1, health: 'healthy' });
    vi.mocked(queryOne).mockResolvedValueOnce({ current_revision: 2, health: 'healthy' });
    await expect(inspectWorkbenchTools({ projectId: 'project-a', projectRoot: root })).resolves.toMatchObject({ dbRevision: 2, filesystemRevision: 1, health: 'recovery_required' });
  });

  it('fails closed on manifest projection or entrypoint drift', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'workbench-tools-integrity-'));
    tempDirs.push(root);
    const toolsRoot = path.join(root, '.runtime-box', 'workbench-tools');
    await fs.mkdir(path.join(toolsRoot, 'revisions', '000001', 'bin'), { recursive: true });
    await fs.mkdir(path.join(toolsRoot, 'manifests', 'revisions'), { recursive: true });
    await fs.writeFile(path.join(toolsRoot, 'revisions', '000001', 'bin', 'cowsay'), '#!/bin/sh\n');
    await fs.writeFile(path.join(toolsRoot, 'manifests', 'revisions', '000001.json'), stableManifestJson({ ...manifest, createdAt: 'tampered' }));
    await fs.symlink('revisions/000001', path.join(toolsRoot, 'active'));
    const row = { current_revision: 1, health: 'healthy', manifest, manifest_hash: stableManifestHash(manifest), prefix_relpath: manifest.paths.prefix };
    vi.mocked(queryOne).mockResolvedValueOnce(row);
    await expect(inspectWorkbenchTools({ projectId: 'project-a', projectRoot: root })).resolves.toMatchObject({ health: 'recovery_required', reason: 'Workbench tool manifest hash mismatch' });

    await fs.writeFile(path.join(toolsRoot, 'manifests', 'revisions', '000001.json'), stableManifestJson(manifest));
    await fs.rm(path.join(toolsRoot, 'revisions', '000001', 'bin', 'cowsay'));
    vi.mocked(queryOne).mockResolvedValueOnce(row);
    await expect(inspectWorkbenchTools({ projectId: 'project-a', projectRoot: root })).resolves.toMatchObject({ health: 'recovery_required' });
  });

  it('rejects an active pointer outside immutable revision directories', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'workbench-tools-'));
    tempDirs.push(root);
    const toolsRoot = path.join(root, '.runtime-box', 'workbench-tools');
    await fs.mkdir(toolsRoot, { recursive: true });
    await fs.symlink('../../outside', path.join(toolsRoot, 'active'));
    vi.mocked(queryOne).mockResolvedValueOnce({ current_revision: 1, health: 'healthy' });
    await expect(inspectWorkbenchTools({ projectId: 'project-a', projectRoot: root })).resolves.toMatchObject({ health: 'recovery_required', reason: 'active pointer target is invalid' });
  });
});

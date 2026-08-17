import { describe, expect, it } from 'vitest';
import { findMissingWorkbenchCapabilities, projectWorkbenchToolInventory } from './workbench-tool-inventory.js';
import type { WorkbenchToolInspection, WorkbenchToolManifest } from './workbench-tools.js';

const inspection: WorkbenchToolInspection = {
  projectId: 'p', dbRevision: 2, filesystemRevision: 2, storageMode: 'tower-managed-v1',
  runtimeStatus: 'running', projectionStatus: 'mounted', mountedRevision: 2,
  recreateStatus: 'not_required', recreateRequired: false, health: 'healthy', reason: 'agree',
};
const manifest: WorkbenchToolManifest = {
  schemaVersion: 1, workbenchId: 'p', revision: 2, createdAt: '2026-08-04T00:00:00Z',
  createdBy: { userId: 7, sessionId: 's', jobId: 'j' }, manager: 'uv-tool',
  tools: [
    { name: 'ruff', version: '0.12.0', entrypoints: ['ruff'], installSpec: 'ruff==0.12.0' },
    { name: 'mystery-cli', version: '1.0.0', entrypoints: ['mystery'], installSpec: 'mystery-cli==1.0.0' },
  ],
  paths: { prefix: '.runtime-box/workbench-tools/revisions/000002', bin: '.runtime-box/workbench-tools/revisions/000002/bin' },
  validation: { status: 'passed', commands: [] }, previousRevision: 1, rollbackRef: null,
};

describe('Workbench AI capability inventory', () => {
  it('projects cataloged semantic capabilities and conservative entrypoint fallbacks', () => {
    const inventory = projectWorkbenchToolInventory({ inspection, activeManifest: manifest });
    expect(inventory).toMatchObject({ status: 'ready', activeRevision: 2, usableByCurrentRuntime: true });
    expect(inventory.capabilityIds).toEqual(['execute:mystery', 'python-format', 'python-lint']);
    expect(inventory.tools[0]).toMatchObject({ name: 'ruff' });
    expect(inventory.tools[0].capabilities).toEqual(expect.arrayContaining([expect.objectContaining({ confidence: 'catalog' })]));
    expect(inventory.tools[1]).toMatchObject({ name: 'mystery-cli', capabilities: [{ id: 'execute:mystery', confidence: 'entrypoint-only' }] });
    expect(findMissingWorkbenchCapabilities(inventory, ['python-lint', 'pdf-inspect'])).toEqual(['pdf-inspect']);
  });

  it('does not claim finalized capabilities are usable by an older running Runtime', () => {
    const inventory = projectWorkbenchToolInventory({
      inspection: { ...inspection, filesystemRevision: 1, mountedRevision: 1, recreateStatus: 'required', recreateRequired: true },
      activeManifest: manifest,
    });
    expect(inventory).toMatchObject({ status: 'ready', usableByCurrentRuntime: false, runtimeRecreateRequired: true });
    expect(findMissingWorkbenchCapabilities(inventory, ['python-lint'])).toEqual(['python-lint']);
  });

  it('fails closed on recovery state or manifest revision divergence', () => {
    expect(projectWorkbenchToolInventory({ inspection: { ...inspection, health: 'recovery_required' }, activeManifest: manifest }))
      .toMatchObject({ status: 'unavailable', tools: [], capabilityIds: [] });
    expect(projectWorkbenchToolInventory({ inspection, activeManifest: { ...manifest, revision: 3 } }))
      .toMatchObject({ status: 'unavailable', health: 'recovery_required', tools: [] });
  });

  it('represents an uninitialized Workbench as empty rather than broken', () => {
    const inventory = projectWorkbenchToolInventory({
      inspection: { ...inspection, dbRevision: null, filesystemRevision: null, mountedRevision: null }, activeManifest: null,
    });
    expect(inventory).toMatchObject({ status: 'empty', activeRevision: null, tools: [] });
  });
});

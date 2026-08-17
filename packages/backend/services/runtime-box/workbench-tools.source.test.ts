import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const migration = fs.readFileSync(path.join(process.cwd(), 'packages/backend/db/migrations/150_runtime_box_workbench_tool_revisions.sql'), 'utf8');
const service = fs.readFileSync(new URL('./workbench-tools.ts', import.meta.url), 'utf8');
const manager = fs.readFileSync(new URL('./runtime-box-manager.ts', import.meta.url), 'utf8');
const mutationLock = fs.readFileSync(new URL('./workbench-mutation-lock.ts', import.meta.url), 'utf8');

describe('Managed Workbench tool revision source contract', () => {
  it('keeps an append-only revision ledger and one current pointer per project', () => {
    expect(migration).toContain('runtime_box_workbench_tool_states');
    expect(migration).toContain('runtime_box_workbench_tool_revisions');
    expect(migration).toContain('PRIMARY KEY(project_id, revision)');
    expect(migration).toContain("WHERE state='active'");
    expect(migration).toContain('previous_revision');
    expect(migration).toContain('source_revision');
  });

  it('finalizes immutable managed-store revisions before DB activation and supports append-only rollback', () => {
    expect(service).toContain('finalizeManagedWorkbenchToolStoreCandidate');
    expect(service).toContain("candidateMountMode: 'ro'");
    expect(service).toContain('persistPreparedManagedRevision');
    expect(service.indexOf('await smokeFinalManagedRevision')).toBeLessThan(service.indexOf('await persistPreparedManagedRevision'));
    expect(service).toContain("storage_kind,store_ref,store_manifest_hash");
    expect(service).toContain("`rollback:${input.targetRevision}`");
    expect(service).not.toContain('activateFilesystemRevision');
  });

  it('binds mutation candidates only from the requested project canonical staging or revision path', () => {
    expect(manager).toContain('validateWorkbenchToolMutationCandidate');
    expect(manager).toContain("/^staging\\/[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/");
    expect(manager).toContain("/^revisions\\/[0-9]{6}$/");
    expect(manager).toContain('await fs.lstat(candidateHostPath)');
    expect(manager).toContain('await fs.realpath(candidateHostPath)');
    expect(manager).toContain('candidateRealPath !== candidateHostPath');
  });

  it('requires exactly one prepared revision transition before superseding or moving current', () => {
    const activation = service.slice(service.indexOf('async function activateDbRevision'), service.indexOf('async function markManagedRevisionFailed'));
    expect(activation).toContain("state='prepared'");
    expect(activation).toContain('FOR UPDATE');
    expect(activation).toContain('RETURNING revision');
    expect(activation).toContain('if (!prepared)');
    expect(activation).toContain('if (!activated)');
    expect(activation.indexOf('if (!prepared)')).toBeLessThan(activation.indexOf("state='superseded'"));
    expect(activation.indexOf('if (!activated)')).toBeLessThan(activation.indexOf('SET current_revision=$2'));
  });

  it('serializes environment mutations separately from the existing box activity lock', () => {
    expect(service).toContain('withWorkbenchMutationLock(input.projectId');
    expect(mutationLock).toContain("const WORKBENCH_MUTATION_PREFIX = 'runtime-box-workbench-tool-mutation:'");
    expect(mutationLock).toContain('withRuntimeAdvisoryLocks');
    expect(manager).toContain('withRuntimeBoxActivityLock(req.boxId');
  });

  it('keeps current pointer unchanged when a finalized payload cannot be persisted', () => {
    expect(service).toContain('let persisted = false');
    expect(service).toContain('if (persisted) await markManagedRevisionFailed');
    expect(service).toContain('createManagedWorkbenchToolStoreCandidate');
    expect(service).toContain('MAX(r.revision)');
    expect(service).not.toContain('restoreFilesystemRevision');
  });

  it('detects and persists database/filesystem pointer divergence for recovery', () => {
    expect(service).toContain('inspectWorkbenchTools');
    expect(service).toContain('database and filesystem revisions disagree');
    expect(service).toContain("health='recovery_required'");
  });

  it('allocates new revisions above failed attempts instead of reusing a primary key', () => {
    expect(service).toContain('SELECT MAX(r.revision)');
    expect(service).toContain('max_revision');
  });

  it('keeps current credential suppression and activity locking while adding active tool PATH', () => {
    expect(manager).toContain('withRuntimeBoxActivityLock(req.boxId');
    expect(manager).toContain('shouldSuppressCredentialEnv(req.cmd)');
    expect(manager).toContain('PATH=${withWorkbenchToolPath(requestedPath)}');
  });
});

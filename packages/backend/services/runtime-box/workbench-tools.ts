import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { queryOne, transaction, withClient } from '../../db/pg-repo.js';
import {
  cleanupManagedWorkbenchToolStoreCandidate,
  createManagedWorkbenchToolStoreCandidate,
  finalizeManagedWorkbenchToolStoreCandidate,
  readAndVerifyManagedWorkbenchToolRevision,
  type ManagedWorkbenchToolStoreCandidate,
} from './workbench-tool-store.js';
import { withWorkbenchMutationLock } from './workbench-mutation-lock.js';
import {
  assertValidRegistryReleaseEvidence,
  collectPyPiReleaseEvidence,
  type WorkbenchRegistryReleaseEvidence,
} from './workbench-tool-registry-evidence.js';

const TOOLS_RELATIVE_ROOT = path.join('.runtime-box', 'workbench-tools');
const REVISION_WIDTH = 6;
const MANAGED_CONTAINER_CANDIDATE = '/workspace/.runtime-box/workbench-tools/active';

export interface WorkbenchToolSpec {
  name: string;
  version: string;
  entrypoints: string[];
}

export interface WorkbenchToolActor {
  userId?: number;
  sessionId?: string;
  jobId?: string;
}

export interface WorkbenchToolManifest {
  schemaVersion: 1;
  workbenchId: string;
  revision: number;
  createdAt: string;
  createdBy: { userId: number | null; sessionId: string | null; jobId: string | null };
  manager: 'uv-tool';
  tools: Array<WorkbenchToolSpec & { installSpec: string }>;
  registryReleaseEvidence?: WorkbenchRegistryReleaseEvidence[];
  paths: { prefix: string; bin: string };
  validation: { status: 'passed'; commands: Array<{ cmd: string; exitCode: 0 }> };
  previousRevision: number | null;
  rollbackRef: string | null;
}

export interface WorkbenchToolCommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export type WorkbenchToolCommandRunner = (input: {
  command: string;
  cwd: string;
  credentialFree: true;
  candidateHostPath: string;
  candidateContainerPath: typeof MANAGED_CONTAINER_CANDIDATE;
  candidateMountMode: 'rw' | 'ro';
}) => Promise<WorkbenchToolCommandResult>;

export interface WorkbenchToolRuntimeObservation {
  runtimeStatus: 'running' | 'stopped' | 'absent' | 'unknown';
  projectionStatus: string | null;
  mountedRevision: number | null;
  recreateStatus: 'required' | 'not_required' | 'unknown';
  recreateRequired: boolean | null;
}

export interface WorkbenchToolInspection extends WorkbenchToolRuntimeObservation {
  projectId: string;
  dbRevision: number | null;
  filesystemRevision: number | null;
  storageMode: 'project-prefix' | 'tower-managed-v1' | null;
  health: 'healthy' | 'degraded' | 'recovery_required';
  reason: string;
}

export class WorkbenchToolError extends Error {}

export function revisionName(revision: number): string {
  if (!Number.isSafeInteger(revision) || revision < 1) throw new WorkbenchToolError('revision must be a positive integer');
  return String(revision).padStart(REVISION_WIDTH, '0');
}

export function assertSafeToolSpec(spec: WorkbenchToolSpec): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(spec.name)) throw new WorkbenchToolError('unsafe tool name');
  if (!/^[A-Za-z0-9][A-Za-z0-9.+!_-]{0,127}$/.test(spec.version)) throw new WorkbenchToolError('unsafe tool version');
  if (!spec.entrypoints.length || spec.entrypoints.some(item => !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(item))) {
    throw new WorkbenchToolError('unsafe or empty tool entrypoints');
  }
}

export function stableManifestJson(manifest: WorkbenchToolManifest): string {
  return `${JSON.stringify(sortJsonValue(manifest), null, 2)}\n`;
}

function sortJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJsonValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, nested]) => [key, sortJsonValue(nested)]));
  }
  return value;
}

export function stableManifestHash(manifest: WorkbenchToolManifest): string {
  return createHash('sha256').update(stableManifestJson(manifest)).digest('hex');
}

export function workbenchToolActiveBin(projectRoot: string): string {
  return path.join(projectRoot, TOOLS_RELATIVE_ROOT, 'active', 'bin');
}

export function withWorkbenchToolPath(currentPath: string | undefined): string {
  const activeBin = '/workspace/.runtime-box/workbench-tools/active/bin';
  const basePath = currentPath ?? '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin';
  return `${activeBin}:/opt/tower-tools/bin:${basePath}`;
}

export function uvToolInstallCommand(spec: WorkbenchToolSpec, containerCandidatePath: string): string {
  assertSafeToolSpec(spec);
  if (containerCandidatePath !== MANAGED_CONTAINER_CANDIDATE) {
    throw new WorkbenchToolError('candidate path is not the final Runtime projection target');
  }
  const installSpec = `${spec.name}==${spec.version}`;
  return `UV_TOOL_DIR=${shellQuote(`${containerCandidatePath}/tools`)} UV_TOOL_BIN_DIR=${shellQuote(`${containerCandidatePath}/bin`)} UV_LINK_MODE=copy uv tool install --force --from ${shellQuote(installSpec)} ${shellQuote(spec.name)}`;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function desiredToolSet(activeManifest: WorkbenchToolManifest | null, requested: WorkbenchToolSpec): WorkbenchToolSpec[] {
  const existing = (activeManifest?.tools ?? []).map(({ name, version, entrypoints }) => ({ name, version, entrypoints }));
  const byName = new Map(existing.map(tool => [tool.name, tool]));
  byName.set(requested.name, requested);
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

interface RevisionStorageRow {
  revision: number;
  state: string;
  manifest: WorkbenchToolManifest;
  manifest_hash: string;
  prefix_relpath: string;
  storage_kind: 'project-prefix' | 'tower-managed-v1';
  store_ref: string | null;
  store_manifest_hash: string | null;
}

async function readRevisionManifest(projectId: string, projectRoot: string, revision: number): Promise<WorkbenchToolManifest> {
  const row = await queryOne<RevisionStorageRow>(
    `SELECT revision,state,manifest,manifest_hash,prefix_relpath,storage_kind,store_ref,store_manifest_hash
       FROM runtime_box_workbench_tool_revisions WHERE project_id=$1 AND revision=$2`,
    [projectId, revision],
  );
  if (!row) throw new WorkbenchToolError('Workbench tool revision not found');
  if (row.storage_kind === 'tower-managed-v1') {
    if (!row.store_ref || !row.store_manifest_hash || row.store_manifest_hash !== row.manifest_hash) {
      throw new WorkbenchToolError('Workbench managed store metadata is incomplete or divergent');
    }
    return readAndVerifyManagedWorkbenchToolRevision({
      projectId,
      revision,
      storeRef: row.store_ref,
      expectedManifestHash: row.store_manifest_hash,
    }).manifest;
  }
  await assertLegacyRevisionIntegrity({ projectRoot, revision, manifest: row.manifest, manifestHash: row.manifest_hash, prefixRelpath: row.prefix_relpath });
  return row.manifest;
}

async function assertLegacyRevisionIntegrity(input: {
  projectRoot: string;
  revision: number;
  manifest: WorkbenchToolManifest;
  manifestHash: string;
  prefixRelpath: string;
}): Promise<void> {
  const expectedPrefix = path.posix.join('.runtime-box', 'workbench-tools', 'revisions', revisionName(input.revision));
  if (input.prefixRelpath !== expectedPrefix || input.manifest.paths.prefix !== expectedPrefix
    || input.manifest.paths.bin !== path.posix.join(expectedPrefix, 'bin')) {
    throw new WorkbenchToolError('revision prefix escaped managed Workbench tool root');
  }
  const revisionPath = path.resolve(input.projectRoot, input.prefixRelpath);
  const revisionBase = path.resolve(input.projectRoot, TOOLS_RELATIVE_ROOT, 'revisions');
  if (!revisionPath.startsWith(`${revisionBase}${path.sep}`)) throw new WorkbenchToolError('revision prefix escaped managed Workbench tool root');
  const projectionPath = path.join(input.projectRoot, TOOLS_RELATIVE_ROOT, 'manifests', 'revisions', `${revisionName(input.revision)}.json`);
  const projection = JSON.parse(await fs.readFile(projectionPath, 'utf8')) as WorkbenchToolManifest;
  if (stableManifestHash(input.manifest) !== input.manifestHash || stableManifestHash(projection) !== input.manifestHash) {
    throw new WorkbenchToolError('Workbench tool manifest hash mismatch');
  }
  for (const tool of projection.tools) {
    assertSafeToolSpec(tool);
    for (const entrypoint of tool.entrypoints) {
      const entrypointPath = path.resolve(revisionPath, 'bin', entrypoint);
      if (!entrypointPath.startsWith(`${path.resolve(revisionPath, 'bin')}${path.sep}`)) throw new WorkbenchToolError('entrypoint escaped revision bin');
      await fs.lstat(entrypointPath);
    }
  }
}

function buildManifest(input: {
  projectId: string;
  revision: number;
  previousRevision: number | null;
  actor: WorkbenchToolActor;
  tools: WorkbenchToolSpec[];
  rollbackSource: number | null;
}): WorkbenchToolManifest {
  const prefix = path.posix.join('.runtime-box', 'workbench-tools', 'revisions', revisionName(input.revision));
  return {
    schemaVersion: 1,
    workbenchId: input.projectId,
    revision: input.revision,
    createdAt: new Date().toISOString(),
    createdBy: { userId: input.actor.userId ?? null, sessionId: input.actor.sessionId ?? null, jobId: input.actor.jobId ?? null },
    manager: 'uv-tool',
    tools: input.tools.map(spec => ({ ...spec, installSpec: `${spec.name}==${spec.version}` })),
    registryReleaseEvidence: [],
    paths: { prefix, bin: path.posix.join(prefix, 'bin') },
    validation: { status: 'passed', commands: [] },
    previousRevision: input.previousRevision,
    rollbackRef: input.rollbackSource == null ? (input.previousRevision == null ? null : path.posix.join('revisions', revisionName(input.previousRevision))) : path.posix.join('revisions', revisionName(input.rollbackSource)),
  };
}

async function installDesiredTools(input: {
  candidate: ManagedWorkbenchToolStoreCandidate;
  manifest: WorkbenchToolManifest;
  run: WorkbenchToolCommandRunner;
  collectEvidence?: typeof collectPyPiReleaseEvidence;
}): Promise<void> {
  const collectEvidence = input.collectEvidence ?? collectPyPiReleaseEvidence;
  input.manifest.registryReleaseEvidence = [];
  for (const spec of input.manifest.tools) {
    const evidence = await collectEvidence(spec);
    assertValidRegistryReleaseEvidence(evidence, spec);
    input.manifest.registryReleaseEvidence.push(evidence);
    const installed = await input.run({
      command: uvToolInstallCommand(spec, MANAGED_CONTAINER_CANDIDATE),
      cwd: '/workspace',
      credentialFree: true,
      candidateHostPath: input.candidate.stagingPath,
      candidateContainerPath: MANAGED_CONTAINER_CANDIDATE,
      candidateMountMode: 'rw',
    });
    if (installed.exitCode !== 0) throw new WorkbenchToolError(`uv tool install failed for ${spec.name}: ${installed.stderr || installed.stdout}`);
    for (const entrypoint of spec.entrypoints) {
      const smoke = await input.run({
        command: `${shellQuote(`${MANAGED_CONTAINER_CANDIDATE}/bin/${entrypoint}`)} --version`,
        cwd: '/workspace',
        credentialFree: true,
        candidateHostPath: input.candidate.stagingPath,
        candidateContainerPath: MANAGED_CONTAINER_CANDIDATE,
        candidateMountMode: 'rw',
      });
      if (smoke.exitCode !== 0) throw new WorkbenchToolError(`tool validation failed for ${entrypoint}: ${smoke.stderr || smoke.stdout}`);
      input.manifest.validation.commands.push({ cmd: `${entrypoint} --version`, exitCode: 0 });
    }
  }
}

async function smokeFinalManagedRevision(input: {
  location: { revisionPath: string; storeRef: string; manifestHash: string };
  manifest: WorkbenchToolManifest;
  run: WorkbenchToolCommandRunner;
}): Promise<void> {
  readAndVerifyManagedWorkbenchToolRevision({
    projectId: input.manifest.workbenchId,
    revision: input.manifest.revision,
    storeRef: input.location.storeRef,
    expectedManifestHash: input.location.manifestHash,
  });
  for (const tool of input.manifest.tools) {
    for (const entrypoint of tool.entrypoints) {
      const smoke = await input.run({
        command: `${shellQuote(`${MANAGED_CONTAINER_CANDIDATE}/bin/${entrypoint}`)} --version`,
        cwd: '/workspace',
        credentialFree: true,
        candidateHostPath: input.location.revisionPath,
        candidateContainerPath: MANAGED_CONTAINER_CANDIDATE,
        candidateMountMode: 'ro',
      });
      if (smoke.exitCode !== 0) throw new WorkbenchToolError(`finalized tool validation failed for ${entrypoint}: ${smoke.stderr || smoke.stdout}`);
    }
  }
}

async function persistPreparedManagedRevision(input: {
  projectId: string;
  manifest: WorkbenchToolManifest;
  previousRevision: number | null;
  sourceRevision: number | null;
  reason: string;
  actor: WorkbenchToolActor;
  storeRef: string;
  manifestHash: string;
}): Promise<void> {
  await transaction(async client => {
    const db = withClient(client);
    await db.execute(`INSERT INTO runtime_box_workbench_tool_states(project_id,current_revision,health,storage_mode,updated_by_user_id,updated_by_session_id)
      VALUES($1,NULL,'healthy','tower-managed-v1',$2,$3) ON CONFLICT(project_id) DO NOTHING`,
    [input.projectId, input.actor.userId ?? null, input.actor.sessionId ?? null]);
    await db.execute(`INSERT INTO runtime_box_workbench_tool_revisions
      (project_id,revision,state,previous_revision,source_revision,manager,manifest,manifest_hash,prefix_relpath,validation,reason,job_id,session_id,requested_by_user_id,storage_kind,store_ref,store_manifest_hash)
      VALUES($1,$2,'prepared',$3,$4,'uv-tool',$5::jsonb,$6,$7,$8::jsonb,$9,$10,$11,$12,'tower-managed-v1',$13,$6)`,
    [input.projectId, input.manifest.revision, input.previousRevision, input.sourceRevision, JSON.stringify(input.manifest), input.manifestHash,
      input.manifest.paths.prefix, JSON.stringify(input.manifest.validation), input.reason, input.actor.jobId ?? null, input.actor.sessionId ?? null,
      input.actor.userId ?? null, input.storeRef]);
  });
}

async function activateDbRevision(input: {
  projectId: string;
  revision: number;
  previousRevision: number | null;
  actor: WorkbenchToolActor;
  rollback: boolean;
}): Promise<void> {
  await transaction(async client => {
    const db = withClient(client);
    const state = await db.queryOne<{ current_revision: number | null }>('SELECT current_revision FROM runtime_box_workbench_tool_states WHERE project_id=$1 FOR UPDATE', [input.projectId]);
    if (!state || (state.current_revision == null ? null : Number(state.current_revision)) !== input.previousRevision) throw new WorkbenchToolError('Workbench tool revision conflict');
    const prepared = await db.queryOne<{ revision: number }>(
      `SELECT revision FROM runtime_box_workbench_tool_revisions
        WHERE project_id=$1 AND revision=$2 AND state='prepared'
        FOR UPDATE`,
      [input.projectId, input.revision],
    );
    if (!prepared) {
      throw new WorkbenchToolError(`Prepared Workbench revision activation failed for revision ${input.revision}; current revision remains unchanged`);
    }
    await db.execute(`UPDATE runtime_box_workbench_tool_revisions SET state='superseded'
      WHERE project_id=$1 AND revision<>$2 AND state IN ('active','rollback')`, [input.projectId, input.revision]);
    const activated = await db.queryOne<{ revision: number }>(
      `UPDATE runtime_box_workbench_tool_revisions SET state=$3,activated_at=NOW()
        WHERE project_id=$1 AND revision=$2 AND state='prepared'
        RETURNING revision`,
      [input.projectId, input.revision, input.rollback ? 'rollback' : 'active'],
    );
    if (!activated) {
      throw new WorkbenchToolError(`Prepared Workbench revision activation failed for revision ${input.revision}; current revision remains unchanged`);
    }
    await db.execute(`UPDATE runtime_box_workbench_tool_states
      SET current_revision=$2,health='healthy',storage_mode='tower-managed-v1',projection_generation=projection_generation+1,
          updated_at=NOW(),updated_by_user_id=$3,updated_by_session_id=$4 WHERE project_id=$1`,
    [input.projectId, input.revision, input.actor.userId ?? null, input.actor.sessionId ?? null]);
  });
}

async function markManagedRevisionFailed(projectId: string, revision: number, error: unknown): Promise<void> {
  await transaction(async client => {
    const db = withClient(client);
    await db.execute(`UPDATE runtime_box_workbench_tool_revisions SET state='failed',validation=$3::jsonb
      WHERE project_id=$1 AND revision=$2 AND state='prepared'`,
    [projectId, revision, JSON.stringify({ status: 'failed', error: String((error as Error).message).slice(0, 2000) })]);
  }).catch(() => undefined);
}

export async function importProjectPrefixWorkbenchTools(input: {
  projectId: string;
  projectRoot: string;
  expectedRevision: number;
  actor: WorkbenchToolActor;
  run: WorkbenchToolCommandRunner;
}): Promise<WorkbenchToolManifest> {
  return withWorkbenchMutationLock(input.projectId, async () => {
    const current = await queryOne<{ current_revision: number | null; max_revision: number | null; storage_mode: string }>(
      `SELECT s.current_revision,s.storage_mode,
              (SELECT MAX(r.revision) FROM runtime_box_workbench_tool_revisions r WHERE r.project_id=s.project_id) AS max_revision
         FROM runtime_box_workbench_tool_states s WHERE s.project_id=$1`, [input.projectId],
    );
    if (!current || current.storage_mode !== 'project-prefix' || Number(current.current_revision) !== input.expectedRevision) {
      throw new WorkbenchToolError('Legacy project-prefix import source is stale or unavailable');
    }
    const sourceManifest = await readRevisionManifest(input.projectId, input.projectRoot, input.expectedRevision);
    const revision = Number(current.max_revision ?? input.expectedRevision) + 1;
    const commandId = input.actor.jobId || `import-${Date.now()}-${revision}`;
    const candidate = await createManagedWorkbenchToolStoreCandidate({ projectId: input.projectId, revision, commandId });
    const tools = sourceManifest.tools.map(({ name, version, entrypoints }) => ({ name, version, entrypoints }));
    const manifest = buildManifest({ projectId: input.projectId, revision, previousRevision: input.expectedRevision, actor: input.actor, tools, rollbackSource: null });
    let persisted = false;
    try {
      await installDesiredTools({ candidate, manifest, run: input.run });
      const finalized = await finalizeManagedWorkbenchToolStoreCandidate({ candidate, manifest });
      await smokeFinalManagedRevision({ location: finalized, manifest, run: input.run });
      await persistPreparedManagedRevision({
        projectId: input.projectId, manifest, previousRevision: input.expectedRevision, sourceRevision: input.expectedRevision,
        reason: 'import-project-prefix', actor: input.actor, storeRef: finalized.storeRef, manifestHash: finalized.manifestHash,
      });
      persisted = true;
      await activateDbRevision({ projectId: input.projectId, revision, previousRevision: input.expectedRevision, actor: input.actor, rollback: false });
      return manifest;
    } catch (error) {
      await cleanupManagedWorkbenchToolStoreCandidate(candidate).catch(() => undefined);
      if (persisted) await markManagedRevisionFailed(input.projectId, revision, error);
      throw error;
    }
  });
}

export async function installUvWorkbenchTool(input: {
  projectId: string;
  projectRoot: string;
  spec: WorkbenchToolSpec;
  expectedRevision?: number | null;
  actor: WorkbenchToolActor;
  run: WorkbenchToolCommandRunner;
}): Promise<WorkbenchToolManifest> {
  assertSafeToolSpec(input.spec);
  return withWorkbenchMutationLock(input.projectId, async () => {
    const current = await queryOne<{ current_revision: number | null; max_revision: number | null }>(
      `SELECT s.current_revision,
              (SELECT MAX(r.revision) FROM runtime_box_workbench_tool_revisions r WHERE r.project_id=s.project_id) AS max_revision
         FROM runtime_box_workbench_tool_states s WHERE s.project_id=$1`, [input.projectId],
    );
    const previousRevision = current?.current_revision == null ? null : Number(current.current_revision);
    if (input.expectedRevision !== undefined && previousRevision !== input.expectedRevision) throw new WorkbenchToolError('Workbench tool revision conflict');
    if (previousRevision != null) {
      const storage = await queryOne<{ storage_mode: string }>('SELECT storage_mode FROM runtime_box_workbench_tool_states WHERE project_id=$1', [input.projectId]);
      if (storage?.storage_mode === 'project-prefix') throw new WorkbenchToolError('Legacy project-prefix state requires explicit import-project-prefix action');
    }
    const activeManifest = previousRevision == null ? null : await readRevisionManifest(input.projectId, input.projectRoot, previousRevision);
    const revision = Number(current?.max_revision ?? 0) + 1;
    const commandId = input.actor.jobId || `install-${Date.now()}-${revision}`;
    const candidate = await createManagedWorkbenchToolStoreCandidate({ projectId: input.projectId, revision, commandId });
    const manifest = buildManifest({ projectId: input.projectId, revision, previousRevision, actor: input.actor, tools: desiredToolSet(activeManifest, input.spec), rollbackSource: null });
    let persisted = false;
    try {
      await installDesiredTools({ candidate, manifest, run: input.run });
      const finalized = await finalizeManagedWorkbenchToolStoreCandidate({ candidate, manifest });
      await smokeFinalManagedRevision({ location: finalized, manifest, run: input.run });
      await persistPreparedManagedRevision({
        projectId: input.projectId, manifest, previousRevision, sourceRevision: null, reason: previousRevision == null ? 'install' : 'upgrade', actor: input.actor,
        storeRef: finalized.storeRef, manifestHash: finalized.manifestHash,
      });
      persisted = true;
      await activateDbRevision({ projectId: input.projectId, revision, previousRevision, actor: input.actor, rollback: false });
      return manifest;
    } catch (error) {
      await cleanupManagedWorkbenchToolStoreCandidate(candidate).catch(() => undefined);
      if (persisted) await markManagedRevisionFailed(input.projectId, revision, error);
      throw error;
    }
  });
}

export function classifyWorkbenchToolRuntimeObservation(
  row: { status: string; mounted_revision: number | null; projection_status: string | null } | undefined,
  currentRevision: number | null,
): WorkbenchToolRuntimeObservation {
  if (!row) return { runtimeStatus: 'absent', projectionStatus: null, mountedRevision: null, recreateStatus: 'not_required', recreateRequired: false };
  const runtimeStatus = row.status === 'running'
    ? 'running'
    : ['stopped', 'idle_stopped', 'error'].includes(row.status)
      ? 'stopped'
      : 'unknown';
  const projectionStatus = row.projection_status ?? null;
  const mountedRevision = row.mounted_revision == null ? null : Number(row.mounted_revision);
  if (runtimeStatus === 'stopped') {
    return { runtimeStatus, projectionStatus, mountedRevision, recreateStatus: 'not_required', recreateRequired: false };
  }
  if (runtimeStatus !== 'running' || projectionStatus !== 'mounted' || mountedRevision == null || currentRevision == null) {
    return { runtimeStatus, projectionStatus, mountedRevision, recreateStatus: 'unknown', recreateRequired: null };
  }
  const recreateRequired = mountedRevision !== currentRevision;
  return { runtimeStatus, projectionStatus, mountedRevision, recreateStatus: recreateRequired ? 'required' : 'not_required', recreateRequired };
}

async function runtimeObservation(projectId: string, currentRevision: number | null): Promise<WorkbenchToolRuntimeObservation> {
  const row = await queryOne<{ status: string; mounted_revision: number | null; projection_status: string | null }>(
    `SELECT b.status,p.revision AS mounted_revision,p.status AS projection_status
       FROM project_runtime_boxes b
       LEFT JOIN runtime_box_workbench_tool_projections p ON p.box_id=b.id
      WHERE b.project_id=$1`, [projectId],
  );
  return classifyWorkbenchToolRuntimeObservation(row, currentRevision);
}

async function inspectLegacyFilesystemRevision(projectRoot: string): Promise<{
  revision: number | null;
  error?: string;
}> {
  const root = path.join(projectRoot, TOOLS_RELATIVE_ROOT);
  try {
    const target = await fs.readlink(path.join(root, 'active'));
    const match = target.replaceAll('\\', '/').match(/^revisions\/(\d{6})$/);
    if (!match) return { revision: null, error: 'active pointer target is invalid' };
    await fs.access(path.join(root, target));
    return { revision: Number(match[1]) };
  } catch (error: any) {
    if (error?.code === 'ENOENT') return { revision: null };
    return { revision: null, error: 'active pointer cannot be inspected' };
  }
}

export async function inspectWorkbenchTools(input: { projectId: string; projectRoot: string }): Promise<WorkbenchToolInspection> {
  const state = await queryOne<{
    current_revision: number | null;
    health: WorkbenchToolInspection['health'];
    storage_mode: 'project-prefix' | 'tower-managed-v1';
    manifest: WorkbenchToolManifest | null;
    manifest_hash: string | null;
    prefix_relpath: string | null;
    storage_kind: 'project-prefix' | 'tower-managed-v1' | null;
    store_ref: string | null;
    store_manifest_hash: string | null;
  }>(
    `SELECT s.current_revision,s.health,s.storage_mode,r.manifest,r.manifest_hash,r.prefix_relpath,r.storage_kind,r.store_ref,r.store_manifest_hash
       FROM runtime_box_workbench_tool_states s
       LEFT JOIN runtime_box_workbench_tool_revisions r ON r.project_id=s.project_id AND r.revision=s.current_revision
      WHERE s.project_id=$1`, [input.projectId],
  );
  const dbRevision = state?.current_revision == null ? null : Number(state.current_revision);
  const storageMode = state?.storage_mode ?? 'project-prefix';
  const storageKind = state?.storage_kind ?? 'project-prefix';
  let observation: WorkbenchToolRuntimeObservation;
  let filesystemRevision: number | null;
  if (storageKind === 'project-prefix') {
    const legacy = await inspectLegacyFilesystemRevision(input.projectRoot);
    observation = { runtimeStatus: 'unknown', projectionStatus: null, mountedRevision: legacy.revision, recreateStatus: 'unknown', recreateRequired: null };
    filesystemRevision = legacy.revision;
    const base = { projectId: input.projectId, dbRevision, filesystemRevision, storageMode, ...observation };
    if (legacy.error) return { ...base, health: 'recovery_required', reason: legacy.error };
    if (dbRevision !== legacy.revision) {
      if (dbRevision == null && legacy.revision == null) return { ...base, health: state?.health ?? 'healthy', reason: 'Workbench tools are not initialized' };
      return { ...base, health: 'recovery_required', reason: 'database and filesystem revisions disagree' };
    }
  } else {
    observation = await runtimeObservation(input.projectId, dbRevision);
    filesystemRevision = observation.mountedRevision;
  }
  const base = { projectId: input.projectId, dbRevision, filesystemRevision, storageMode, ...observation };
  if (storageKind === 'tower-managed-v1' && observation.runtimeStatus === 'running' && observation.recreateStatus === 'unknown') {
    if (observation.projectionStatus === 'recovery_required') {
      return { ...base, health: 'recovery_required', reason: 'running Runtime Workbench tool projection requires recovery' };
    }
    return { ...base, health: 'degraded', reason: `running Runtime Workbench tool projection lifecycle is unknown (${observation.projectionStatus ?? 'missing'})` };
  }
  if (storageKind === 'tower-managed-v1' && observation.runtimeStatus === 'unknown') {
    return { ...base, health: 'degraded', reason: 'Runtime lifecycle status is unknown' };
  }
  if (dbRevision == null) return { ...base, health: state?.health ?? 'healthy', reason: 'Workbench tools are not initialized' };
  if (!state?.manifest || !state.manifest_hash || !state.prefix_relpath) {
    return { ...base, health: 'recovery_required', reason: 'active revision metadata is incomplete' };
  }
  try {
    if (storageKind === 'tower-managed-v1') {
      if (!state.store_ref || !state.store_manifest_hash || state.store_manifest_hash !== state.manifest_hash || storageMode !== 'tower-managed-v1') {
        throw new WorkbenchToolError('Workbench managed store metadata is incomplete or divergent');
      }
      readAndVerifyManagedWorkbenchToolRevision({ projectId: input.projectId, revision: dbRevision, storeRef: state.store_ref, expectedManifestHash: state.store_manifest_hash });
    } else {
      await assertLegacyRevisionIntegrity({ projectRoot: input.projectRoot, revision: dbRevision, manifest: state.manifest, manifestHash: state.manifest_hash, prefixRelpath: state.prefix_relpath });
    }
  } catch (error) {
    return { ...base, health: 'recovery_required', reason: (error as Error).message };
  }
  return {
    ...base,
    health: state.health,
    reason: observation.recreateRequired
      ? 'current managed revision is finalized; running Runtime remains on an older mounted revision and requires explicit recreate'
      : storageKind === 'project-prefix'
        ? 'legacy project-prefix revision is intact; import to the Tower-managed store is still required before managed projection'
        : 'database and managed store agree',
  };
}

export async function listWorkbenchToolRevisions(projectId: string, limit = 20): Promise<Array<{
  revision: number;
  state: string;
  previousRevision: number | null;
  sourceRevision: number | null;
  manager: string;
  manifest: WorkbenchToolManifest;
  manifestHash: string;
  storageKind: 'project-prefix' | 'tower-managed-v1';
  storeRef: string | null;
  storeManifestHash: string | null;
  reason: string;
  createdAt: string;
  activatedAt: string | null;
}>> {
  const safeLimit = Math.max(1, Math.min(Math.floor(limit), 100));
  const rows = await queryOne<{ rows: any[] }>(
    `SELECT COALESCE(jsonb_agg(to_jsonb(r) ORDER BY r.revision DESC),'[]'::jsonb) AS rows
       FROM (SELECT revision,state,previous_revision,source_revision,manager,manifest,manifest_hash,storage_kind,store_ref,store_manifest_hash,reason,created_at,activated_at
               FROM runtime_box_workbench_tool_revisions WHERE project_id=$1 ORDER BY revision DESC LIMIT $2) r`,
    [projectId, safeLimit],
  );
  return (rows?.rows ?? []).map((row: any) => ({
    revision: Number(row.revision), state: row.state,
    previousRevision: row.previous_revision == null ? null : Number(row.previous_revision),
    sourceRevision: row.source_revision == null ? null : Number(row.source_revision),
    manager: row.manager, manifest: row.manifest, manifestHash: row.manifest_hash,
    storageKind: row.storage_kind, storeRef: row.store_ref ?? null, storeManifestHash: row.store_manifest_hash ?? null,
    reason: row.reason, createdAt: row.created_at, activatedAt: row.activated_at ?? null,
  }));
}

export async function reconcileWorkbenchTools(input: { projectId: string; projectRoot: string }): Promise<WorkbenchToolInspection> {
  const inspection = await inspectWorkbenchTools(input);
  if (inspection.health === 'recovery_required') {
    await transaction(async client => {
      const db = withClient(client);
      await db.execute(`UPDATE runtime_box_workbench_tool_states SET health='recovery_required',updated_at=NOW() WHERE project_id=$1`, [input.projectId]);
    });
  }
  return inspection;
}

export async function rollbackWorkbenchTools(input: {
  projectId: string;
  projectRoot: string;
  targetRevision: number;
  actor: WorkbenchToolActor;
  run: WorkbenchToolCommandRunner;
}): Promise<number> {
  return withWorkbenchMutationLock(input.projectId, async () => {
    const current = await queryOne<{ current_revision: number | null; max_revision: number | null }>(`SELECT s.current_revision,
      (SELECT MAX(r.revision) FROM runtime_box_workbench_tool_revisions r WHERE r.project_id=s.project_id) AS max_revision
      FROM runtime_box_workbench_tool_states s WHERE s.project_id=$1`, [input.projectId]);
    if (!current?.current_revision) throw new WorkbenchToolError('Workbench tool state has no active revision');
    const source = await queryOne<RevisionStorageRow>(
      `SELECT revision,state,manifest,manifest_hash,prefix_relpath,storage_kind,store_ref,store_manifest_hash
         FROM runtime_box_workbench_tool_revisions WHERE project_id=$1 AND revision=$2 AND state IN ('active','superseded','rollback')`,
      [input.projectId, input.targetRevision],
    );
    if (!source) throw new WorkbenchToolError('target Workbench tool revision not found');
    const sourceManifest = await readRevisionManifest(input.projectId, input.projectRoot, input.targetRevision);
    const previousRevision = Number(current.current_revision);
    const nextRevision = Number(current.max_revision ?? current.current_revision) + 1;
    const commandId = input.actor.jobId || `rollback-${Date.now()}-${nextRevision}`;
    const candidate = await createManagedWorkbenchToolStoreCandidate({ projectId: input.projectId, revision: nextRevision, commandId });
    const tools = sourceManifest.tools.map(({ name, version, entrypoints }) => ({ name, version, entrypoints }));
    const manifest = buildManifest({ projectId: input.projectId, revision: nextRevision, previousRevision, actor: input.actor, tools, rollbackSource: input.targetRevision });
    let persisted = false;
    try {
      await installDesiredTools({ candidate, manifest, run: input.run });
      const finalized = await finalizeManagedWorkbenchToolStoreCandidate({ candidate, manifest });
      await smokeFinalManagedRevision({ location: finalized, manifest, run: input.run });
      await persistPreparedManagedRevision({
        projectId: input.projectId, manifest, previousRevision, sourceRevision: input.targetRevision, reason: `rollback:${input.targetRevision}`, actor: input.actor,
        storeRef: finalized.storeRef, manifestHash: finalized.manifestHash,
      });
      persisted = true;
      await activateDbRevision({ projectId: input.projectId, revision: nextRevision, previousRevision, actor: input.actor, rollback: true });
      return nextRevision;
    } catch (error) {
      await cleanupManagedWorkbenchToolStoreCandidate(candidate).catch(() => undefined);
      if (persisted) await markManagedRevisionFailed(input.projectId, nextRevision, error);
      throw error;
    }
  });
}

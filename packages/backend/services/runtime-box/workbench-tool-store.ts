import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { config } from '../../config.js';
import { stableManifestHash, type WorkbenchToolManifest } from './workbench-tools.js';
import { assertValidRegistryReleaseEvidence } from './workbench-tool-registry-evidence.js';

const STORE_KIND = 'tower-managed-v1' as const;
const RUNTIME_PROJECTION_TARGET = '/workspace/.runtime-box/workbench-tools/active';
const STORE_REF_PATTERN = /^projects\/([A-Za-z0-9][A-Za-z0-9_-]{0,127})\/revisions\/([0-9]{6})$/;
const RUNTIME_INTERPRETER_PATH_PATTERN = /^\/usr\/(?:local\/)?bin\/python(?:3(?:\.\d+)?)?$/;
const RUNTIME_INTERPRETER_LINK_PATTERN = /^python(?:3(?:\.\d+)?)?$/;
const MAX_RUNTIME_INTERPRETER_SYMLINK_DEPTH = 16;

export class WorkbenchToolStoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorkbenchToolStoreError';
  }
}

export interface ManagedWorkbenchToolStoreLocation {
  storageKind: typeof STORE_KIND;
  storeRef: string;
  revisionPath: string;
  manifestPath: string;
}

export interface ManagedWorkbenchToolStoreCandidate extends ManagedWorkbenchToolStoreLocation {
  stagingPath: string;
  commandId: string;
}

export function workbenchToolStoreRoot(): string {
  const root = path.resolve(config.experimentalWorkbenchTools.storeRoot);
  const workspaceRoot = path.resolve(config.workspaceRoot);
  if (root === workspaceRoot || root.startsWith(`${workspaceRoot}${path.sep}`)) {
    throw new WorkbenchToolStoreError('Workbench managed store must be outside the workspace root');
  }
  return root;
}

export function managedWorkbenchToolStoreRef(projectId: string, revision: number): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(projectId)) throw new WorkbenchToolStoreError('invalid Workbench project id');
  if (!Number.isSafeInteger(revision) || revision < 1 || revision > 999999) throw new WorkbenchToolStoreError('invalid Workbench revision');
  return `projects/${projectId}/revisions/${String(revision).padStart(6, '0')}`;
}

export function resolveManagedWorkbenchToolStoreLocation(input: {
  projectId: string;
  revision: number;
  storeRef: string;
  storeRoot?: string;
}): ManagedWorkbenchToolStoreLocation {
  const match = STORE_REF_PATTERN.exec(input.storeRef);
  if (!match || match[1] !== input.projectId || Number(match[2]) !== input.revision) {
    throw new WorkbenchToolStoreError('Workbench store_ref does not match project/revision identity');
  }
  const root = path.resolve(input.storeRoot ?? workbenchToolStoreRoot());
  const revisionPath = path.resolve(root, ...input.storeRef.split('/'));
  if (!revisionPath.startsWith(`${root}${path.sep}`)) throw new WorkbenchToolStoreError('Workbench store_ref escaped managed store root');
  return {
    storageKind: STORE_KIND,
    storeRef: input.storeRef,
    revisionPath,
    manifestPath: path.join(revisionPath, 'manifest.json'),
  };
}

/** Create a command-scoped candidate beside the immutable revisions on the same filesystem. */
export async function createManagedWorkbenchToolStoreCandidate(input: {
  projectId: string;
  revision: number;
  commandId: string;
  storeRoot?: string;
}): Promise<ManagedWorkbenchToolStoreCandidate> {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(input.commandId)) {
    throw new WorkbenchToolStoreError('invalid Workbench mutation command id');
  }
  const storeRef = managedWorkbenchToolStoreRef(input.projectId, input.revision);
  const location = resolveManagedWorkbenchToolStoreLocation({ ...input, storeRef });
  const projectStore = path.resolve(input.storeRoot ?? workbenchToolStoreRoot(), 'projects', input.projectId);
  const stagingPath = path.resolve(projectStore, 'staging', input.commandId);
  const revisionsRoot = path.dirname(location.revisionPath);
  if (!stagingPath.startsWith(`${projectStore}${path.sep}`)) throw new WorkbenchToolStoreError('Workbench staging path escaped project store');
  await fsp.mkdir(path.dirname(stagingPath), { recursive: true });
  await fsp.mkdir(revisionsRoot, { recursive: true });
  const [stagingDevice, revisionsDevice] = await Promise.all([
    fsp.stat(path.dirname(stagingPath)).then(stat => stat.dev),
    fsp.stat(revisionsRoot).then(stat => stat.dev),
  ]);
  if (stagingDevice !== revisionsDevice) throw new WorkbenchToolStoreError('Workbench staging and revisions must share a filesystem');
  try {
    await fsp.lstat(location.revisionPath);
    throw new WorkbenchToolStoreError('Workbench managed revision already exists');
  } catch (error: any) {
    if (error instanceof WorkbenchToolStoreError) throw error;
    if (error?.code !== 'ENOENT') throw error;
  }
  await fsp.rm(stagingPath, { recursive: true, force: true });
  await fsp.mkdir(stagingPath, { recursive: true });
  return { ...location, stagingPath, commandId: input.commandId };
}

/** Validate and atomically finalize one candidate. Existing immutable revisions are never overwritten. */
export async function finalizeManagedWorkbenchToolStoreCandidate(input: {
  candidate: ManagedWorkbenchToolStoreCandidate;
  manifest: WorkbenchToolManifest;
}): Promise<ManagedWorkbenchToolStoreLocation & { manifestHash: string }> {
  if (!input.manifest.tools.length) throw new WorkbenchToolStoreError('Workbench store manifest has no tools');
  const manifestHash = stableManifestHash(input.manifest);
  const stagingManifestPath = path.join(input.candidate.stagingPath, 'manifest.json');
  try {
    await fsp.writeFile(stagingManifestPath, `${JSON.stringify(sortJson(input.manifest), null, 2)}\n`, { flag: 'wx' });
  } catch (error: any) {
    if (error?.code !== 'EEXIST') throw error;
    const existing = JSON.parse(await fsp.readFile(stagingManifestPath, 'utf8')) as WorkbenchToolManifest;
    if (stableManifestHash(existing) !== manifestHash) throw new WorkbenchToolStoreError('Workbench staging manifest differs from finalized manifest');
  }
  verifyManagedRevisionPath({
    revisionPath: input.candidate.stagingPath,
    projectId: input.manifest.workbenchId,
    revision: input.manifest.revision,
    expectedManifestHash: manifestHash,
  });
  try {
    await fsp.rename(input.candidate.stagingPath, input.candidate.revisionPath);
  } catch (error: any) {
    if (error?.code === 'EEXIST' || error?.code === 'ENOTEMPTY') throw new WorkbenchToolStoreError('Workbench managed revision already exists');
    throw error;
  }
  const finalResult: ManagedWorkbenchToolStoreLocation & { manifestHash: string } = { ...input.candidate, manifestHash };
  readAndVerifyManagedWorkbenchToolRevision({
    projectId: input.manifest.workbenchId,
    revision: input.manifest.revision,
    storeRef: finalResult.storeRef,
    expectedManifestHash: manifestHash,
    storeRoot: path.resolve(input.candidate.revisionPath, '..', '..', '..', '..'),
  });
  return finalResult;
}

/** Remove only the command-scoped staging candidate; finalized revisions are intentionally retained. */
export async function cleanupManagedWorkbenchToolStoreCandidate(candidate: ManagedWorkbenchToolStoreCandidate): Promise<void> {
  await fsp.rm(candidate.stagingPath, { recursive: true, force: true });
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .sort(([a], [b]) => a.localeCompare(b)).map(([key, nested]) => [key, sortJson(nested)]));
  return value;
}

export function readAndVerifyManagedWorkbenchToolRevision(input: {
  projectId: string;
  revision: number;
  storeRef: string;
  expectedManifestHash: string;
  storeRoot?: string;
}): ManagedWorkbenchToolStoreLocation & { manifest: WorkbenchToolManifest } {
  const location = resolveManagedWorkbenchToolStoreLocation(input);
  verifyManagedRevisionPath({
    revisionPath: location.revisionPath,
    projectId: input.projectId,
    revision: input.revision,
    expectedManifestHash: input.expectedManifestHash,
    storeRoot: input.storeRoot ?? workbenchToolStoreRoot(),
  });
  const manifest = JSON.parse(fs.readFileSync(location.manifestPath, 'utf8')) as WorkbenchToolManifest;
  return { ...location, manifest };
}

function verifyManagedRevisionPath(input: {
  revisionPath: string;
  projectId: string;
  revision: number;
  expectedManifestHash: string;
  storeRoot?: string;
}): void {
  let revisionReal: string;
  let stat: fs.Stats;
  try {
    revisionReal = fs.realpathSync(input.revisionPath);
    stat = fs.lstatSync(input.revisionPath);
  } catch {
    throw new WorkbenchToolStoreError('Workbench managed revision unavailable');
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new WorkbenchToolStoreError('Workbench managed revision must be a real directory');
  if (revisionReal !== input.revisionPath) throw new WorkbenchToolStoreError('Workbench managed revision resolved through a symlink');
  if (input.storeRoot) {
    const rootReal = fs.realpathSync(path.resolve(input.storeRoot));
    if (!revisionReal.startsWith(`${rootReal}${path.sep}`)) throw new WorkbenchToolStoreError('Workbench managed revision resolved outside the store root');
  }

  let manifest: WorkbenchToolManifest;
  try {
    manifest = JSON.parse(fs.readFileSync(path.join(input.revisionPath, 'manifest.json'), 'utf8')) as WorkbenchToolManifest;
  } catch {
    throw new WorkbenchToolStoreError('Workbench store manifest unavailable');
  }
  if (manifest.workbenchId !== input.projectId || manifest.revision !== input.revision) {
    throw new WorkbenchToolStoreError('Workbench store manifest identity mismatch');
  }
  const hash = stableManifestHash(manifest);
  if (!/^[0-9a-f]{64}$/.test(input.expectedManifestHash) || hash !== input.expectedManifestHash) {
    throw new WorkbenchToolStoreError('Workbench store manifest hash mismatch');
  }
  assertRevisionPayloadContained(input.revisionPath);
  if (manifest.registryReleaseEvidence) {
    if (manifest.registryReleaseEvidence.length !== manifest.tools.length) {
      throw new WorkbenchToolStoreError('Workbench registry evidence count does not match tool manifest');
    }
    const evidenceByPackage = new Map(manifest.registryReleaseEvidence.map(item => [item.package.toLowerCase(), item]));
    for (const tool of manifest.tools) {
      const evidence = evidenceByPackage.get(tool.name.toLowerCase());
      if (!evidence) throw new WorkbenchToolStoreError(`Workbench registry evidence missing: ${tool.name}`);
      try { assertValidRegistryReleaseEvidence(evidence, tool); }
      catch (error) { throw new WorkbenchToolStoreError((error as Error).message); }
    }
  }
  for (const tool of manifest.tools) {
    for (const entrypoint of tool.entrypoints) {
      const entryPath = path.resolve(input.revisionPath, 'bin', entrypoint);
      const binRoot = path.resolve(input.revisionPath, 'bin');
      if (!entryPath.startsWith(`${binRoot}${path.sep}`)) throw new WorkbenchToolStoreError('Workbench entrypoint escaped revision bin');
      let entryReal: string;
      try {
        entryReal = resolveManagedPayloadPath(entryPath, input.revisionPath);
      } catch {
        throw new WorkbenchToolStoreError(`Workbench entrypoint missing: ${entrypoint}`);
      }
      if (!entryReal.startsWith(`${input.revisionPath}${path.sep}`)) {
        throw new WorkbenchToolStoreError(`Workbench entrypoint escaped managed revision: ${entrypoint}`);
      }
    }
  }
}

function runtimeInterpreterSymlinkFailure(candidate: string, revisionPath: string, reason: string): WorkbenchToolStoreError {
  const relative = path.relative(revisionPath, candidate).replaceAll('\\', '/');
  return new WorkbenchToolStoreError(`Workbench runtime interpreter symlink invalid: ${relative}: ${reason}`);
}

/** Resolve only the narrow uv Python-link shape without following arbitrary host paths. */
function isAllowedRuntimeInterpreterSymlink(candidate: string, revisionPath: string): boolean {
  const relative = path.relative(revisionPath, candidate).replaceAll('\\', '/');
  if (!/^tools\/[^/]+\/bin\/python(?:3(?:\.\d+)?)?$/.test(relative)) return false;
  const binDirectory = path.dirname(candidate);
  const visited = new Set<string>();
  let current = candidate;

  for (let depth = 0; depth < MAX_RUNTIME_INTERPRETER_SYMLINK_DEPTH; depth += 1) {
    const normalized = path.resolve(current);
    if (visited.has(normalized)) throw runtimeInterpreterSymlinkFailure(candidate, revisionPath, 'cycle detected');
    visited.add(normalized);

    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(normalized);
    } catch {
      throw runtimeInterpreterSymlinkFailure(candidate, revisionPath, 'link in chain is missing');
    }
    if (!stat.isSymbolicLink()) {
      throw runtimeInterpreterSymlinkFailure(candidate, revisionPath, 'link in chain resolved to a regular filesystem entry');
    }

    let target: string;
    try {
      target = fs.readlinkSync(normalized);
    } catch {
      throw runtimeInterpreterSymlinkFailure(candidate, revisionPath, 'link target could not be read');
    }
    if (path.isAbsolute(target)) {
      if (RUNTIME_INTERPRETER_PATH_PATTERN.test(target)) return true;
      throw runtimeInterpreterSymlinkFailure(candidate, revisionPath, 'final target is outside the runtime interpreter allowlist');
    }
    if (!RUNTIME_INTERPRETER_LINK_PATTERN.test(target)) {
      throw runtimeInterpreterSymlinkFailure(candidate, revisionPath, 'relative link target is not an allowed Python sibling');
    }
    const next = path.resolve(path.dirname(normalized), target);
    if (path.dirname(next) !== binDirectory) {
      throw runtimeInterpreterSymlinkFailure(candidate, revisionPath, 'relative link escaped the tool bin directory');
    }
    current = next;
  }

  throw runtimeInterpreterSymlinkFailure(candidate, revisionPath, 'link chain exceeded maximum depth');
}

function resolveManagedPayloadPath(candidate: string, revisionPath: string): string {
  const stat = fs.lstatSync(candidate);
  if (!stat.isSymbolicLink()) return fs.realpathSync(candidate);
  const target = fs.readlinkSync(candidate);
  let rebased: string | null = null;
  if (path.isAbsolute(target) && (target === RUNTIME_PROJECTION_TARGET || target.startsWith(`${RUNTIME_PROJECTION_TARGET}/`))) {
    rebased = path.resolve(revisionPath, ...path.posix.relative(RUNTIME_PROJECTION_TARGET, target).split('/'));
  } else if (!path.isAbsolute(target)) {
    const relativeParent = path.relative(revisionPath, path.dirname(candidate)).replaceAll('\\', '/');
    const runtimeCandidate = path.posix.normalize(path.posix.join(RUNTIME_PROJECTION_TARGET, relativeParent, target));
    if (runtimeCandidate === RUNTIME_PROJECTION_TARGET || runtimeCandidate.startsWith(`${RUNTIME_PROJECTION_TARGET}/`)) {
      rebased = path.resolve(revisionPath, ...path.posix.relative(RUNTIME_PROJECTION_TARGET, runtimeCandidate).split('/'));
    }
  }
  return fs.realpathSync(rebased ?? candidate);
}

/** Every symlink in the executable payload must resolve inside its immutable revision. */
function assertRevisionPayloadContained(revisionPath: string): void {
  const pending = [revisionPath];
  while (pending.length > 0) {
    const current = pending.pop()!;
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const candidate = path.join(current, entry.name);
      const stat = fs.lstatSync(candidate);
      if (stat.isSymbolicLink()) {
        if (isAllowedRuntimeInterpreterSymlink(candidate, revisionPath)) continue;
        let resolved: string;
        try {
          resolved = resolveManagedPayloadPath(candidate, revisionPath);
        } catch {
          let target = '<unreadable>';
          try { target = fs.readlinkSync(candidate); } catch { /* fail-closed diagnostic only */ }
          throw new WorkbenchToolStoreError(`Workbench payload contains a broken symlink: ${path.relative(revisionPath, candidate)} -> ${target}`);
        }
        if (!resolved.startsWith(`${revisionPath}${path.sep}`)) {
          throw new WorkbenchToolStoreError('Workbench payload symlink escaped managed revision');
        }
        continue;
      }
      if (stat.isDirectory()) pending.push(candidate);
    }
  }
}

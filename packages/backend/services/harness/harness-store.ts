/**
 * Owns: Project Harness bindings and immutable Session runtime snapshots.
 * Public API: resolveBoundHarnessBinding, resolvePublishedHarnessReference, getPinnedSessionHarnessSnapshot, getOrPinSessionHarnessSnapshot.
 * See README.md.
 */

import { createHash } from 'node:crypto';
import { execute, queryOne } from '../../db/pg-repo.js';
import { resolveHarnessForSession } from './harness-resolver.js';
import { promptBundleHash } from './prompt-component-registry.js';
import type { HarnessResolutionInput, ResolvedHarness } from './harness-types.js';

interface SessionHarnessSnapshotRow {
  harness_id: string;
  harness_version: number;
  runtime_profile_id: string;
  runtime_profile_version: number;
  engine: 'pi' | 'claude';
  snapshot: unknown;
  snapshot_hash: string;
  prompt_bundle_hash?: string | null;
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function snapshotHash(snapshot: ResolvedHarness): string {
  return createHash('sha256').update(stable(snapshot)).digest('hex');
}

function isResolvedHarness(value: unknown): value is ResolvedHarness {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  return typeof row.id === 'string' && Number.isInteger(row.version) &&
    typeof row.runtimeProfileId === 'string' && Number.isInteger(row.runtimeProfileVersion) &&
    (row.engine === 'pi' || row.engine === 'claude') && Array.isArray(row.capabilityIds) &&
    !!row.prompt && typeof row.prompt === 'object';
}

function withPromptBundleIdentity(snapshot: ResolvedHarness): ResolvedHarness {
  const bundleHash = snapshot.prompt.bundleHash || promptBundleHash(snapshot.prompt);
  return { ...snapshot, prompt: { ...snapshot.prompt, bundleHash } };
}

export interface ProjectHarnessBinding {
  harnessId: string;
  harnessVersion: number;
  runtimeProfileId: string;
  runtimeProfileVersion: number;
}

export interface PublishedHarnessReference extends ProjectHarnessBinding {
  engine: 'pi' | 'claude';
  model?: string;
}

/** Resolve one immutable candidate tuple for privileged behavioral evaluation only. */
export async function resolveHarnessCandidateReference(reference: PublishedHarnessReference): Promise<ResolvedHarness> {
  const row=await queryOne<{engine:'pi'|'claude'}>(`SELECT v.engine FROM harness_versions v JOIN harness_runtime_profile_versions p ON p.harness_id=v.harness_id AND p.harness_version=v.version WHERE v.harness_id=$1 AND v.version=$2 AND v.status='published' AND v.promotion_status='candidate' AND p.profile_id=$3 AND p.profile_version=$4 AND p.status='active'`,[reference.harnessId,reference.harnessVersion,reference.runtimeProfileId,reference.runtimeProfileVersion]);if(!row)throw new Error(`Harness candidate reference not found: ${reference.harnessId}@${reference.harnessVersion}/${reference.runtimeProfileId}@${reference.runtimeProfileVersion}`);if(row.engine!==reference.engine)throw new Error(`Harness candidate ${reference.harnessId}@${reference.harnessVersion} uses engine ${row.engine}, not ${reference.engine}`);return resolveHarnessForSession({sessionId:`candidate-eval:${reference.harnessId}:${reference.harnessVersion}:${reference.runtimeProfileId}:${reference.runtimeProfileVersion}`,requestedEngine:reference.engine,requestedModel:reference.model,requestedHarnessId:reference.harnessId,requestedHarnessVersion:reference.harnessVersion,requestedRuntimeProfileId:reference.runtimeProfileId,requestedRuntimeProfileVersion:reference.runtimeProfileVersion});
}

/** Resolve and validate one published Registry tuple before another aggregate snapshots it. */
export async function resolvePublishedHarnessReference(reference: PublishedHarnessReference): Promise<ResolvedHarness> {
  const row = await queryOne<{
    harness_id: string;
    harness_version: number;
    runtime_profile_id: string;
    runtime_profile_version: number;
    engine: 'pi' | 'claude';
  }>(
    `SELECT h.id AS harness_id, v.version AS harness_version, p.profile_id AS runtime_profile_id,
            p.profile_version AS runtime_profile_version, v.engine
       FROM harnesses h
       JOIN harness_versions v ON v.harness_id = h.id
       JOIN harness_runtime_profile_versions p
         ON p.harness_id = v.harness_id AND p.harness_version = v.version
      WHERE h.id = $1 AND v.version = $2 AND p.profile_id = $3 AND p.profile_version = $4
        AND h.status = 'active' AND v.status = 'published' AND v.promotion_status = 'promoted' AND p.status = 'active'`,
    [reference.harnessId, reference.harnessVersion, reference.runtimeProfileId, reference.runtimeProfileVersion],
  );
  if (!row) {
    throw new Error(`Published Harness reference not found: ${reference.harnessId}@${reference.harnessVersion}/${reference.runtimeProfileId}@${reference.runtimeProfileVersion}`);
  }
  if (row.engine !== reference.engine) {
    throw new Error(`Published Harness ${row.harness_id}@${row.harness_version} uses engine ${row.engine}, not ${reference.engine}`);
  }
  return resolveHarnessForSession({
    sessionId: `registry-validation:${row.harness_id}:${row.harness_version}:${row.runtime_profile_id}:${row.runtime_profile_version}`,
    requestedEngine: reference.engine,
    requestedModel: reference.model,
    requestedHarnessId: row.harness_id,
    requestedHarnessVersion: Number(row.harness_version),
    requestedRuntimeProfileId: row.runtime_profile_id,
    requestedRuntimeProfileVersion: Number(row.runtime_profile_version),
  });
}

/** Resolve the complete current Project binding. Missing binding intentionally means tower-default compatibility. */
export async function resolveBoundHarnessBinding(projectId?: string): Promise<ProjectHarnessBinding | undefined> {
  if (!projectId) return undefined;
  const row = await queryOne<{
    harness_id: string;
    harness_version: number;
    runtime_profile_id: string;
    runtime_profile_version: number;
  }>(
    `SELECT b.harness_id, b.harness_version, b.runtime_profile_id, b.runtime_profile_version
       FROM project_agent_harness_bindings b
      WHERE b.project_id = $1`,
    [projectId],
  );
  if (!row) return undefined;
  return {
    harnessId: row.harness_id,
    harnessVersion: Number(row.harness_version),
    runtimeProfileId: row.runtime_profile_id,
    runtimeProfileVersion: Number(row.runtime_profile_version),
  };
}

/** Compatibility helper for callers that only need the Harness identity. */
export async function resolveBoundHarnessId(projectId?: string): Promise<string | undefined> {
  return (await resolveBoundHarnessBinding(projectId))?.harnessId;
}

function validateSnapshotRowIntegrity(sessionId: string, row: SessionHarnessSnapshotRow): ResolvedHarness {
  if (!isResolvedHarness(row.snapshot)) {
    throw new Error(`Pinned Harness snapshot is invalid for Session ${sessionId}`);
  }

  // Hash the exact persisted JSON. Legacy snapshots predate bundleHash and gain
  // that compatibility projection only after integrity verification; hashing the
  // enriched runtime object would incorrectly reject otherwise untouched rows.
  const actualHash = snapshotHash(row.snapshot);
  if (row.snapshot_hash !== actualHash) {
    throw new Error(`Pinned Harness snapshot hash mismatch for Session ${sessionId}`);
  }

  const tupleMatches = row.harness_id === row.snapshot.id &&
    Number(row.harness_version) === row.snapshot.version &&
    row.runtime_profile_id === row.snapshot.runtimeProfileId &&
    Number(row.runtime_profile_version) === row.snapshot.runtimeProfileVersion &&
    row.engine === row.snapshot.engine;
  if (!tupleMatches) {
    throw new Error(`Pinned Harness snapshot tuple mismatch for Session ${sessionId}`);
  }
  return row.snapshot;
}

async function validatePinnedSessionHarnessSnapshot(
  input: Pick<HarnessResolutionInput, 'sessionId' | 'requestedEngine' | 'requestedModel'>,
  row: SessionHarnessSnapshotRow | undefined,
): Promise<ResolvedHarness | undefined> {
  if (!row) return undefined;
  const snapshot = withPromptBundleIdentity(validateSnapshotRowIntegrity(input.sessionId, row));
  if (row.prompt_bundle_hash && row.prompt_bundle_hash !== snapshot.prompt.bundleHash) {
    throw new Error(`Pinned Harness prompt bundle hash mismatch for Session ${input.sessionId}`);
  }
  if (!row.prompt_bundle_hash) {
    await execute(
      'UPDATE session_runtime_snapshots SET prompt_bundle_hash=$2 WHERE session_id=$1 AND prompt_bundle_hash IS NULL',
      [input.sessionId, snapshot.prompt.bundleHash],
    );
  }
  if (input.requestedEngine !== snapshot.engine) {
    throw new Error(`Pinned Harness ${snapshot.id}@${snapshot.version} does not support engine ${input.requestedEngine}`);
  }
  if (input.requestedModel && snapshot.allowedModels && !snapshot.allowedModels.includes(input.requestedModel)) {
    throw new Error(`Pinned Harness ${snapshot.id}@${snapshot.version} does not allow model ${input.requestedModel}`);
  }
  return Object.freeze(snapshot);
}

/**
 * Load an existing Session's immutable Harness contract for native-session resume.
 *
 * Resume must never consult the mutable Project binding or silently create a new
 * snapshot. A missing snapshot means Tower cannot prove the native Session is
 * being reopened under its original runtime contract, so the caller must fail.
 */
export async function getPinnedSessionHarnessSnapshot(
  input: Pick<HarnessResolutionInput, 'sessionId' | 'requestedEngine' | 'requestedModel'>,
): Promise<ResolvedHarness> {
  const row = await queryOne<SessionHarnessSnapshotRow>(
    `SELECT harness_id,harness_version,runtime_profile_id,runtime_profile_version,
            engine,snapshot,snapshot_hash,prompt_bundle_hash
       FROM session_runtime_snapshots WHERE session_id = $1`,
    [input.sessionId],
  );
  const snapshot = await validatePinnedSessionHarnessSnapshot(input, row);
  if (!snapshot) throw new Error(`Pinned Harness snapshot is required to resume Session ${input.sessionId}`);
  return snapshot;
}

/**
 * Read or atomically pin one new Session's immutable resolved Harness.
 *
 * Native-session resume callers must use getPinnedSessionHarnessSnapshot so a
 * missing snapshot can never be replaced from the current mutable Project binding.
 */
export async function getOrPinSessionHarnessSnapshot(
  input: HarnessResolutionInput,
): Promise<ResolvedHarness> {
  const existing = await queryOne<SessionHarnessSnapshotRow>(
    `SELECT harness_id,harness_version,runtime_profile_id,runtime_profile_version,
            engine,snapshot,snapshot_hash,prompt_bundle_hash
       FROM session_runtime_snapshots WHERE session_id = $1`,
    [input.sessionId],
  );
  const pinned = await validatePinnedSessionHarnessSnapshot(input, existing);
  if (pinned) return pinned;

  const bound = input.requestedHarnessId ? undefined : await resolveBoundHarnessBinding(input.projectId);
  const requestedHarnessId = input.requestedHarnessId || bound?.harnessId;
  const resolvedWithoutBundle = await resolveHarnessForSession({
    ...input,
    requestedHarnessId,
    requestedHarnessVersion: input.requestedHarnessVersion ?? bound?.harnessVersion,
    requestedRuntimeProfileId: input.requestedRuntimeProfileId ?? bound?.runtimeProfileId,
    requestedRuntimeProfileVersion: input.requestedRuntimeProfileVersion ?? bound?.runtimeProfileVersion,
  });
  const resolved = withPromptBundleIdentity(resolvedWithoutBundle);
  await execute(
    `INSERT INTO session_runtime_snapshots
       (session_id,project_id,harness_id,harness_version,runtime_profile_id,runtime_profile_version,engine,snapshot,snapshot_hash,source,prompt_bundle_hash)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,$11)
     ON CONFLICT(session_id) DO NOTHING`,
    [
      input.sessionId,
      input.projectId || null,
      resolved.id,
      resolved.version,
      resolved.runtimeProfileId,
      resolved.runtimeProfileVersion,
      resolved.engine,
      JSON.stringify(resolved),
      snapshotHash(resolved),
      requestedHarnessId ? 'project-binding' : resolved.source,
      resolved.prompt.bundleHash,
    ],
  );

  const winner = await queryOne<SessionHarnessSnapshotRow>(
    `SELECT harness_id,harness_version,runtime_profile_id,runtime_profile_version,
            engine,snapshot,snapshot_hash,prompt_bundle_hash
       FROM session_runtime_snapshots WHERE session_id = $1`,
    [input.sessionId],
  );
  const winnerSnapshot = await validatePinnedSessionHarnessSnapshot(input, winner);
  if (!winnerSnapshot) throw new Error(`Harness snapshot pin failed for Session ${input.sessionId}`);
  return winnerSnapshot;
}

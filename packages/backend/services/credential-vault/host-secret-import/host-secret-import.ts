// Owns: allowlisted host .env key → Credential Vault migration. Public API: previewHostSecretImport/applyHostSecretImport. See README.md.
import { createHash, randomUUID } from 'node:crypto';
import { readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { auditCredentialEvent, upsertApiKeyCredential } from '../credential-vault-service.js';

export interface HostSecretImportRequest {
  sourcePath: string;
  sourceKey: string;
  projectId: string;
  credentialId: string;
  provider: string;
  displayName: string;
  secretName: string;
  envName?: string;
}

interface ImportIntent extends HostSecretImportRequest {
  id: string;
  proposalHash: string;
  sourceRealPath: string;
  sourceMtimeMs: number;
  expiresAt: number;
}

const intents = new Map<string, ImportIntent>();
const TTL_MS = 10 * 60 * 1000;
const ENV_NAME = /^[A-Z][A-Z0-9_]{0,63}$/;
const CREDENTIAL_ID = /^[a-z0-9][a-z0-9._-]{1,127}$/;

function stableHash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function allowlist(): Array<{ path: string; keys: string[] }> {
  const raw = process.env.TOWER_HOST_SECRET_IMPORT_ALLOWLIST_JSON;
  if (!raw) return [];
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed)) throw new Error('host secret import allowlist must be an array');
  return parsed.filter((row): row is { path: string; keys: string[] } =>
    Boolean(row && typeof row.path === 'string' && path.isAbsolute(row.path) && Array.isArray(row.keys) && row.keys.every((key: unknown) => typeof key === 'string' && ENV_NAME.test(key))),
  );
}

async function assertAllowedSource(sourcePath: string, sourceKey: string): Promise<{ realPath: string; mtimeMs: number }> {
  if (!path.isAbsolute(sourcePath) || !ENV_NAME.test(sourceKey)) throw new Error('invalid host secret source');
  const realPath = await realpath(sourcePath);
  const allowed = allowlist().some((entry) => path.resolve(entry.path) === realPath && entry.keys.includes(sourceKey));
  if (!allowed) throw new Error('host secret source is not allowlisted');
  const sourceStat = await stat(realPath);
  if (!sourceStat.isFile()) throw new Error('host secret source is not a file');
  return { realPath, mtimeMs: sourceStat.mtimeMs };
}

function parseEnvValue(content: string, key: string): string {
  let found: string | undefined;
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const normalized = line.startsWith('export ') ? line.slice(7).trimStart() : line;
    const index = normalized.indexOf('=');
    if (index < 1 || normalized.slice(0, index).trim() !== key) continue;
    let value = normalized.slice(index + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    found = value;
  }
  if (!found) throw new Error('allowlisted source key is missing or empty');
  return found;
}

function validateRequest(request: HostSecretImportRequest): void {
  if (!request.projectId || !CREDENTIAL_ID.test(request.credentialId)) throw new Error('invalid import target');
  for (const name of [request.sourceKey, request.secretName, request.envName ?? request.secretName]) {
    if (!ENV_NAME.test(name)) throw new Error('invalid environment variable name');
  }
  if (!request.provider.trim() || !request.displayName.trim()) throw new Error('provider and displayName required');
}

/** Validate metadata only and create a short-lived intent. The secret value is not read during preview. */
export async function previewHostSecretImport(request: HostSecretImportRequest, actorUserId?: number): Promise<{
  intentId: string; proposalHash: string; expiresAt: string; source: { path: string; key: string }; target: { projectId: string; credentialId: string; secretName: string; envName: string };
}> {
  validateRequest(request);
  const source = await assertAllowedSource(request.sourcePath, request.sourceKey);
  const intentId = randomUUID();
  const expiresAt = Date.now() + TTL_MS;
  const proposalHash = stableHash({ ...request, sourceRealPath: source.realPath, sourceMtimeMs: source.mtimeMs });
  intents.set(intentId, { ...request, id: intentId, proposalHash, sourceRealPath: source.realPath, sourceMtimeMs: source.mtimeMs, expiresAt });
  await auditCredentialEvent({
    credentialId: request.credentialId,
    projectId: request.projectId,
    eventType: 'host_secret_import_previewed',
    actorUserId: actorUserId ?? null,
    provider: request.provider,
    targetType: 'credential_vault',
    targetRef: {
      source_path: source.realPath,
      source_key: request.sourceKey,
      target_env_name: request.envName ?? request.secretName,
      proposal_hash: proposalHash,
      expires_at: new Date(expiresAt).toISOString(),
    },
  });
  return {
    intentId, proposalHash, expiresAt: new Date(expiresAt).toISOString(),
    source: { path: source.realPath, key: request.sourceKey },
    target: { projectId: request.projectId, credentialId: request.credentialId, secretName: request.secretName, envName: request.envName ?? request.secretName },
  };
}

/** Consume the exact approved intent and import the value without returning it. */
export async function applyHostSecretImport(input: { intentId: string; proposalHash: string; actorUserId: number }): Promise<{ ok: true; credentialId: string; projectId: string; sourceKey: string; sourceUnchanged: true }> {
  const intent = intents.get(input.intentId);
  if (!intent) throw new Error('valid unused host secret import intent required');
  if (intent.expiresAt <= Date.now()) { intents.delete(input.intentId); throw new Error('host secret import intent expired'); }
  if (intent.proposalHash !== input.proposalHash) throw new Error('host secret import proposal hash mismatch');
  intents.delete(input.intentId);

  const source = await assertAllowedSource(intent.sourcePath, intent.sourceKey);
  if (source.realPath !== intent.sourceRealPath || source.mtimeMs !== intent.sourceMtimeMs) throw new Error('host secret source changed after preview');
  const secretValue = parseEnvValue(await readFile(source.realPath, 'utf8'), intent.sourceKey);
  await upsertApiKeyCredential({
    id: intent.credentialId, provider: intent.provider, displayName: intent.displayName,
    secretName: intent.secretName, secretValue, defaultEnvName: intent.envName ?? intent.secretName,
    scope: 'project', projectId: intent.projectId, actorUserId: input.actorUserId,
    metadata: { imported_from_host: true, source_key: intent.sourceKey },
  });
  await auditCredentialEvent({
    credentialId: intent.credentialId,
    projectId: intent.projectId,
    eventType: 'host_secret_import_applied',
    actorUserId: input.actorUserId,
    provider: intent.provider,
    targetType: 'credential_vault',
    targetRef: {
      source_path: source.realPath,
      source_key: intent.sourceKey,
      target_env_name: intent.envName ?? intent.secretName,
      proposal_hash: intent.proposalHash,
      source_unchanged: true,
    },
  });
  return { ok: true, credentialId: intent.credentialId, projectId: intent.projectId, sourceKey: intent.sourceKey, sourceUnchanged: true };
}

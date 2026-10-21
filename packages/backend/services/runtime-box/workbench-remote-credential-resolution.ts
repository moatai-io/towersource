/**
 * Owns: Command-scoped Credential Vault resolution for Remote Workbench Jobs.
 * Public API: resolveRemoteWorkbenchCredentialEnv.
 *
 * Reuses the same Agent authority (requester identity is retained for audit) and risky-command suppression as Local Runtime.
 * GWS and Higgsfield CLI bundles use run-scoped internal envelope keys that the Worker
 * materializes into ephemeral files and removes after the command.
 */

import {
  diagnoseUnresolvedCredentialRequirements,
  type CredentialRequirementReason,
  resolveProjectCredentialSecretValue,
  resolveRuntimeBoxApiKeyEnv,
  resolveRuntimeBoxCredentialFileMaterialization,
  type RuntimeBoxCredentialFileSecret,
} from '../credential-vault/credential-vault-service.js';
import { shouldSuppressCredentialEnv } from '../execution/command-classifier.js';
import { resolveGatewayApiClient } from '../gateway-profile/gateway-profile-client.js';
import { commandIsGwsAuthLogin, commandRequestsFinanceGwsProfile, commandRequestsPersonalGwsProfile, commandRequestsGwsConnectionId, selectProjectGwsConnection } from './runtime-box-manager.js';
import type { WorkbenchExecutionRequest } from '../execution/execution-broker.js';
import { credentialEnvRequested, requestedCredentialEnvNames } from './workbench-credential-scope.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import { hostSkillSnapshotPath, verifyHostSkillSnapshot } from '../skill/host-skill-snapshot.js';

export { requestedCredentialEnvNames } from './workbench-credential-scope.js';

function filterCredentialEnv(env: Record<string, string>, requested: Set<string>, callerEnv: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(env).filter(([key]) => Object.prototype.hasOwnProperty.call(callerEnv, key)
    || credentialEnvRequested(key, requested)));
}

interface ManagedSkillCredentialManifest {
  schemaVersion?: number;
  managedBy?: string;
  skills?: Array<{
    name?: string;
    runtimePath?: string;
    bundleDigest?: string;
    requiredSecrets?: string[];
    gatewayApis?: Array<{ apiId?: string; apiKeyEnv?: string; baseUrlEnv?: string }>;
  }>;
}

const MANAGED_SKILL_PATH = /(?:^|[\s'"=])\/workspace\/\.tower\/skills\/([A-Za-z0-9][A-Za-z0-9._-]{0,63})(?:\/|[\s'";|&)]|$)/g;

/** Resolve declared Credential env names only for managed skill runtime paths present in the command. */
async function managedSkillManifestEntries(projectRoot: string | undefined, command: string, cwd?: string, declaredRequirements: string[] = []): Promise<NonNullable<ManagedSkillCredentialManifest['skills']>> {
  const names = new Set<string>();
  for (const match of command.matchAll(MANAGED_SKILL_PATH)) names.add(match[1]);
  if (!projectRoot) return [];
  try {
    const manifest = JSON.parse(await fs.readFile(path.join(projectRoot, '.tower', 'skills', 'manifest.json'), 'utf8')) as ManagedSkillCredentialManifest;
    if (manifest.schemaVersion !== 3 || manifest.managedBy !== 'tower-project-skill-runtime-layer' || !Array.isArray(manifest.skills)) return [];
    return manifest.skills.filter(skill => {
      if (!skill.name || skill.runtimePath !== `/workspace/.tower/skills/${skill.name}`) return false;
      if ((skill.gatewayApis ?? []).some(api =>
        (api.apiKeyEnv && declaredRequirements.includes(api.apiKeyEnv))
        || (api.baseUrlEnv && declaredRequirements.includes(api.baseUrlEnv)))) return true;
      if (names.has(skill.name)) return true;
      // Resolve relative mounted paths against the command's actual working directory.
      // Do not accept an unrelated subdirectory's .tower/skills lookalike.
      const commandCwd = path.resolve(cwd ?? projectRoot);
      const mountedDirectory = path.join(projectRoot, '.tower', 'skills', skill.name);
      const runtimeDirectory = skill.runtimePath;
      for (const directory of [mountedDirectory, runtimeDirectory]) {
        const relative = path.relative(commandCwd, directory);
        if (!relative || path.isAbsolute(relative)) continue;
        for (const candidate of [relative, `./${relative}`]) {
          const escaped = candidate.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          if (new RegExp(`(?:^|[\\s'"=])${escaped}(?:/|[\\s'";|&)]|$)`).test(command)) return true;
        }
      }
      if (!skill.bundleDigest) return false;
      try {
        const directory = hostSkillSnapshotPath(projectRoot, skill.name, skill.bundleDigest);
        const relative = path.relative(path.resolve(cwd ?? projectRoot), directory);
        const candidates = [directory, relative, `./${relative}`];
        const used = candidates.some(candidate => {
          const escaped = candidate.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          return new RegExp(`(?:^|[\\s'"=])${escaped}/`).test(command);
        });
        return used && verifyHostSkillSnapshot(directory, skill.bundleDigest);
      } catch { return false; }
    });
  } catch {
    return [];
  }
}

export async function declaredManagedSkillCredentialEnvNames(projectRoot: string | undefined, command: string, cwd?: string): Promise<Set<string>> {
  const declared = new Set<string>();
  for (const skill of await managedSkillManifestEntries(projectRoot, command, cwd)) {
    for (const envName of skill.requiredSecrets ?? []) if (/^[A-Z][A-Z0-9_]{0,63}$/.test(envName)) declared.add(envName);
  }
  return declared;
}

function remoteFileEnvelopeKey(index: number): string {
  return `TOWER_REMOTE_FILE_CREDENTIAL_${index}`;
}

function encodeRemoteFileCredential(file: RuntimeBoxCredentialFileSecret): string {
  return Buffer.from(JSON.stringify({
    envName: file.envName,
    fileName: file.fileName,
    mode: file.mode,
    credentialType: file.credentialType,
    value: file.value,
  }), 'utf8').toString('base64');
}

export interface RemoteWorkbenchCredentialResolution {
  request: WorkbenchExecutionRequest;
  environmentKeys: string[];
  injected: Array<{ credentialId: string; envName: string }>;
  materializedFiles: Array<{ credentialId: string; envName: string }>;
  skipped: Array<{ credentialId: string; envName?: string; reason: string }>;
  declaredRequirements?: string[];
  unsatisfiedRequirements?: string[];
  unresolvedReasons?: Array<{ envName: string; reason: CredentialRequirementReason }>;
  selectedBundles?: Array<{ credentialId: string; provider: string }>;
  suppressed: boolean;
  suppressReason?: string;
}

/** Resolve current Vault grants immediately before a Remote Job is enqueued. */
export async function resolveRemoteWorkbenchCredentialEnv(input: {
  projectId: string;
  userId: number;
  projectRoot?: string;
  request: WorkbenchExecutionRequest;
}): Promise<RemoteWorkbenchCredentialResolution> {
  const explicitGwsConnection = input.request.gwsConnectionId;
  if (explicitGwsConnection !== undefined && (typeof explicitGwsConnection !== 'string' || !/^[A-Za-z0-9_-]{1,120}$/.test(explicitGwsConnection))) {
    throw new Error('WORKBENCH_GWS_CONNECTION_INVALID');
  }
  const declaredRequirements = input.request.credentialRequirements ?? [];
  if (!Array.isArray(declaredRequirements) || declaredRequirements.length > 32
    || declaredRequirements.some(name => typeof name !== 'string' || !/^[A-Z][A-Z0-9_]{0,62}[A-Z0-9]$/.test(name))) {
    throw new Error('WORKBENCH_CREDENTIAL_REQUIREMENTS_INVALID: use at most 32 exact environment names, not prefixes or values');
  }
  const callerEnv = { ...(input.request.env ?? {}) };
  if (commandRequestsPersonalGwsProfile(input.request.command) || commandIsGwsAuthLogin(input.request.command)
    || callerEnv.GWS_PROFILE === 'personal' || callerEnv.TOWER_GWS_PROFILE === 'personal') {
    throw new Error('AGENT_GWS_CONNECTION_REQUIRED: Requester-personal Google credentials and host OAuth login are not Agent connections. Connect Google to this Agent explicitly before running this command.');
  }
  if (commandRequestsFinanceGwsProfile(input.request.command)
    || callerEnv.GWS_PROFILE === 'finance' || callerEnv.TOWER_GWS_PROFILE === 'finance') {
    throw new Error('AGENT_GWS_EXPLICIT_CONNECTION_REQUIRED: Legacy finance profile aliases are not supported on this execution path. Remove GWS_PROFILE and select the intended Agent connection with GWS_CONNECTION_ID or gwsConnectionId.');
  }
  // Controller-owned GWS envelope keys must never be inherited from the requester.
  delete callerEnv.TOWER_REMOTE_GWS_CONFIG_B64;
  delete callerEnv.TOWER_REMOTE_GWS_USER_ID;
  const suppression = shouldSuppressCredentialEnv(input.request.command);
  if (suppression.suppress) {
    return {
      request: { ...input.request, env: input.request.env ? callerEnv : undefined },
      environmentKeys: Object.keys(callerEnv).sort(),
      declaredRequirements: [...new Set(declaredRequirements)],
      unsatisfiedRequirements: [],
      injected: [],
      materializedFiles: [],
      skipped: [],
      suppressed: true,
      suppressReason: suppression.reason,
    };
  }
  const selectedBundles: Array<{ credentialId: string; provider: string }> = [];
  const managedSkills = await managedSkillManifestEntries(input.projectRoot, input.request.command, input.request.cwd, declaredRequirements);
  const requested = requestedCredentialEnvNames(input.request.command);
  for (const envName of declaredRequirements) requested.add(envName);
  for (const envName of await declaredManagedSkillCredentialEnvNames(input.projectRoot, input.request.command, input.request.cwd)) requested.add(envName);
  const apiKeys = await resolveRuntimeBoxApiKeyEnv({
    projectId: input.projectId,
    userId: input.userId,
    existingEnv: callerEnv,
    requestedEnvNames: requested,
  });
  const selectedApiEnv = filterCredentialEnv(apiKeys.env, requested, callerEnv);
  const standaloneFiles = await resolveRuntimeBoxCredentialFileMaterialization({
    projectId: input.projectId,
    userId: input.userId,
    existingEnv: selectedApiEnv,
    requestedEnvNames: requested,
  });
  const env = { ...callerEnv, ...selectedApiEnv };
  const pathManagedSkills = await managedSkillManifestEntries(input.projectRoot, input.request.command, input.request.cwd);
  const pathManagedNames = new Set(pathManagedSkills.map(skill => skill.name));
  for (const skill of managedSkills) {
    for (const gatewayApi of skill.gatewayApis ?? []) {
      if (!pathManagedNames.has(skill.name)
        && !declaredRequirements.includes(gatewayApi.apiKeyEnv ?? '')
        && !declaredRequirements.includes(gatewayApi.baseUrlEnv ?? '')) continue;
      const { apiId, apiKeyEnv, baseUrlEnv } = gatewayApi;
      if (!apiId || !apiKeyEnv || !baseUrlEnv
        || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(apiId)
        || !/^[A-Z][A-Z0-9_]{0,63}$/.test(apiKeyEnv)
        || !/^[A-Z][A-Z0-9_]{0,63}$/.test(baseUrlEnv)) continue;
      const gateway = await resolveGatewayApiClient({ actorUserId: input.userId, projectId: input.projectId, apiId });
      env[apiKeyEnv] = gateway.apiKey;
      env[baseUrlEnv] = gateway.baseUrl;
      selectedBundles.push({ credentialId: gateway.credentialId, provider: `gateway:${apiId}` });
    }
  }
  const files = standaloneFiles.materialize;
  files.forEach((file, index) => { env[remoteFileEnvelopeKey(index)] = encodeRemoteFileCredential(file); });
  if (/(^|[;&|()\s])higgsfield\s+/.test(input.request.command)) {
    const higgsfield = await resolveProjectCredentialSecretValue({
      projectId: input.projectId,
      userId: input.userId,
      credentialId: 'higgsfield-cli-oauth',
      kind: 'api_key',
      provider: 'higgsfield',
      targetType: 'remote_worker_higgsfield_cli_config',
    });
    if (!higgsfield) throw new Error('HIGGSFIELD_CREDENTIAL_NOT_AVAILABLE: Higgsfield CLI OAuth is not connected for Worker use');
    selectedBundles.push({ credentialId: 'higgsfield-cli-oauth', provider: 'higgsfield' });
    env.TOWER_REMOTE_HIGGSFIELD_CREDENTIALS_JSON = higgsfield.value;
  }
  if (explicitGwsConnection || /(^|[;&|()\s])gws\s+/.test(input.request.command)) {
    const selected = await selectProjectGwsConnection({
      projectId: input.projectId,
      requestedCredentialId: explicitGwsConnection ?? commandRequestsGwsConnectionId(input.request.command),
    });
    const gws = await resolveProjectCredentialSecretValue({
      projectId: input.projectId,
      userId: input.userId,
      credentialId: selected.id,
      kind: 'gws',
      provider: 'google',
      targetType: 'remote_worker_gws_config',
    });
    if (!gws) throw new Error(`PROJECT_GWS_CREDENTIAL_NOT_AVAILABLE: ${selected.id} cannot be resolved for Worker use`);
    selectedBundles.push({ credentialId: selected.id, provider: 'google' });
    env.TOWER_REMOTE_GWS_CONFIG_B64 = gws.value;
    // The selected Agent bundle owns the account; userId remains audit-only above.
  }
  const unsatisfiedRequirements = [...new Set(declaredRequirements)].filter(name =>
    !Object.prototype.hasOwnProperty.call(selectedApiEnv, name) && !files.some(file => file.envName === name));
  const unresolvedReasons = await diagnoseUnresolvedCredentialRequirements(input.projectId, unsatisfiedRequirements);
  return {
    declaredRequirements: [...new Set(declaredRequirements)],
    unsatisfiedRequirements,
    unresolvedReasons,
    selectedBundles,
    request: { ...input.request, env },
    environmentKeys: Object.keys(env).sort(),
    injected: apiKeys.injected.map(item => ({ credentialId: item.credentialId, envName: item.envName })),
    materializedFiles: files.map(item => ({ credentialId: item.credentialId, envName: item.envName })),
    skipped: [...apiKeys.skipped, ...standaloneFiles.skipped],
    suppressed: false,
  };
}

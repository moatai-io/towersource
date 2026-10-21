import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { updateStableSkills } from './stable-release-updater.js';
import { readTeamskillsSkillset } from './teamskills-source.js';
import { seedProjectDefaultSkills } from '../pm/project-default-skills.js';
import { resolveOperatorSkillAssets } from './operator-skill-assets.js';
import { buildRuntimeSkillBindMountPlan } from './runtime-skill-bind-mount.js';
import { resolveRemoteWorkbenchCredentialEnv } from '../runtime-box/workbench-remote-credential-resolution.js';
import { resolveGatewayApiClient } from '../gateway-profile/gateway-profile-client.js';
import { resolveRuntimeBoxApiKeyEnv, resolveRuntimeBoxCredentialFileMaterialization } from '../credential-vault/credential-vault-service.js';
vi.mock('../gateway-profile/gateway-profile-client.js', () => ({ resolveGatewayApiClient: vi.fn() }));
vi.mock('../credential-vault/credential-vault-service.js', () => ({ resolveRuntimeBoxApiKeyEnv: vi.fn(), resolveRuntimeBoxCredentialFileMaterialization: vi.fn(), resolveProjectCredentialSecretValue: vi.fn(), diagnoseUnresolvedCredentialRequirements: vi.fn().mockResolvedValue([]) }));
let root: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'stable-gateway-'));
  vi.mocked(resolveRuntimeBoxApiKeyEnv).mockResolvedValue({ env: {}, injected: [], skipped: [], skippedExisting: [] } as any);
  vi.mocked(resolveRuntimeBoxCredentialFileMaterialization).mockResolvedValue({ materialize: [], skipped: [] } as any);
  vi.mocked(resolveGatewayApiClient).mockResolvedValue({ apiId: 'openai-image', profileId: 'fixture', baseUrl: 'https://example.test/openai', apiKey: 'fixture-key', credentialId: 'fixture-gateway', readiness: 'ready' });
});
afterEach(() => {
  vi.unstubAllEnvs(); vi.clearAllMocks();
  if (fs.existsSync(root)) {
    for (const rel of fs.readdirSync(root, { recursive: true }).map(String)) {
      const file = path.join(root, rel);
      if (fs.lstatSync(file).isDirectory()) fs.chmodSync(file, 0o755);
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
});
it('signed overlay preserves local Project and seeds gateway metadata through host snapshot and mock command credentials', async () => {
  const sourceRoot = path.join(root, 'teamskills');
  const releasesRoot = path.join(root, 'releases');
  const project = path.join(root, 'project');
  const payload = path.join(root, 'payload');
  fs.mkdirSync(path.join(sourceRoot, '.tower'), { recursive: true }); fs.mkdirSync(releasesRoot);
  fs.mkdirSync(path.join(project, '.tower/skills'), { recursive: true });
  fs.writeFileSync(path.join(project, '.tower/skills/manifest.json'), JSON.stringify({ schemaVersion: 3, managedBy: 'tower-project-skill-runtime-layer', skills: [] }));
  fs.writeFileSync(path.join(sourceRoot, '.tower/stable-skills-policy.json'), JSON.stringify({ schemaVersion: 1, enrollments: [{ name: 'image-gen', localDigest: null }] }));
  fs.writeFileSync(path.join(sourceRoot, 'local-skill-owner.txt'), 'preserve');
  fs.mkdirSync(path.join(payload, 'skills/image-gen/scripts'), { recursive: true });
  fs.writeFileSync(path.join(payload, 'skillset.json'), JSON.stringify({ version: 1, defaultSkills: ['image-gen'] }));
  fs.writeFileSync(path.join(payload, 'skills/image-gen/SKILL.md'), '# image-gen');
  fs.writeFileSync(path.join(payload, 'skills/image-gen/skill.yaml'), `name: image-gen\nversion: 1.0.0\nrequiredSecrets: []\ngatewayApis: '[{"apiId":"openai-image","apiKeyEnv":"OPENAI_IMAGE_API_KEY","baseUrlEnv":"OPENAI_IMAGE_BASE_URL"}]'\n`);
  fs.writeFileSync(path.join(payload, 'skills/image-gen/scripts/generate.py'), 'print("fixture")');
  vi.stubEnv('TEAMSKILLS_PROJECT_ROOT', sourceRoot); vi.stubEnv('TEAMSKILLS_STABLE_RELEASES_ROOT', releasesRoot);
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const archive = execFileSync('tar', ['-czf', '-', '--format=ustar', '-C', payload, 'skillset.json', 'skills']);
  const descriptor = Buffer.from(JSON.stringify({ schemaVersion: 1, repository: 'juliuschun/teamskills', tag: 'v1.0.1', commit: 'b'.repeat(40), archiveSha256: crypto.createHash('sha256').update(archive).digest('hex'), minimumAppCapability: 1, requiredFeatures: ['bind-ro', 'gatewayApis', 'retainedEntries'] }));
  const input = { descriptor, signature: crypto.sign(null, descriptor, privateKey), archive, publicKey: publicKey.export({ format: 'pem', type: 'spki' }) };
  expect(updateStableSkills({ sourceRoot, releasesRoot, projectRoots: [project], input, mode: 'apply' }).status).toBe('applied');
  expect(fs.readFileSync(path.join(sourceRoot, 'local-skill-owner.txt'), 'utf8')).toBe('preserve');
  const fresh = path.join(root, 'fresh'); fs.mkdirSync(fresh);
  seedProjectDefaultSkills(fresh, readTeamskillsSkillset([]));
  const manifest = JSON.parse(fs.readFileSync(path.join(fresh, '.tower/skills/manifest.json'), 'utf8'));
  expect(manifest.skills[0].gatewayApis).toEqual([{ apiId: 'openai-image', apiKeyEnv: 'OPENAI_IMAGE_API_KEY', baseUrlEnv: 'OPENAI_IMAGE_BASE_URL' }]);
  const plan = buildRuntimeSkillBindMountPlan(fresh);
  expect(plan.enabled).toBe(true);
  expect(plan.mounts[0].sourcePath.startsWith(releasesRoot)).toBe(true);
  const asset = resolveOperatorSkillAssets(fresh, 'image-gen', '# image-gen');
  expect(asset.status).toBe('source-verified');
  if (asset.status !== 'source-verified') throw new Error('snapshot unavailable');
  const command = `python "${asset.executionDirectory}/scripts/generate.py"`;
  const result = await resolveRemoteWorkbenchCredentialEnv({ projectId: 'fixture-project', userId: 7, projectRoot: fresh, request: { command } });
  expect(result.request.env).toMatchObject({ OPENAI_IMAGE_API_KEY: 'fixture-key', OPENAI_IMAGE_BASE_URL: 'https://example.test/openai' });
  expect(resolveGatewayApiClient).toHaveBeenCalledWith({ actorUserId: 7, projectId: 'fixture-project', apiId: 'openai-image' });
});

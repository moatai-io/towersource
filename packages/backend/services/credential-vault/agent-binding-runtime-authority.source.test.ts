import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const service = fs.readFileSync(path.join(import.meta.dirname, 'credential-vault-service.ts'), 'utf8');
const runtime = fs.readFileSync(path.resolve(import.meta.dirname, '../runtime-box/runtime-box-manager.ts'), 'utf8');

describe('Agent binding Runtime authority contract', () => {
  it('centralizes env, file, profile, and direct secret resolution on the Agent binding predicate', () => {
    expect(service.match(/allowedProjectCredentialWhere\(/g)?.length).toBeGreaterThanOrEqual(6);
    expect(service).toContain('resolveRuntimeBoxApiKeyEnv');
    expect(service).toContain('resolveProjectCredentialSecretValue');
    expect(service).toContain('resolveRuntimeBoxCredentialFileMaterialization');
    expect(service).toContain('resolveRuntimeBoxCredentialProfileEnv');
  });

  it('does not make current user ownership or an unused SQL parameter a Runtime condition', () => {
    const predicate = service.slice(service.indexOf('export function allowedProjectCredentialWhere'), service.indexOf('export async function auditCredentialEvent'));
    expect(predicate).toContain("policyAlias}.mode IN ('allow', 'override', 'inherit')");
    expect(predicate).not.toContain('owner_user_id =');
    expect(predicate).not.toContain('userIdSql');
  });

  it('keeps resolver query parameter counts aligned after removing owner placeholders', () => {
    expect(service).toContain("allowedProjectCredentialWhere('c', 'p', 'd', 'prj')");
    expect(service).not.toContain("allowedProjectCredentialWhere('c', 'p', 'd', 'prj', '$2')");
    expect(service).not.toContain('[opts.projectId, opts.userId],');
    expect(service).not.toContain('[opts.projectId, opts.envName, opts.userId],');
    expect(service).not.toContain('[credentialId, opts.projectId, opts.userId],');
  });

  it('keeps personal legacy credentials explicit-only and denies outside the positive allow set', () => {
    const predicate = service.slice(service.indexOf('export function allowedProjectCredentialWhere'), service.indexOf('export async function auditCredentialEvent'));
    expect(predicate).toContain("scope <> 'personal'");
    expect(predicate).not.toContain("scope IN ('workspace', 'internal-default', 'personal')");
    expect(predicate).not.toContain("mode = 'deny'");
  });

  it('passes legacy personal owners to every project-bound secret resolver without making them Runtime authority', () => {
    const resolverBlock = service.slice(service.indexOf('async function resolveProjectBoundSecret'), service.indexOf('function stringMetadataValue'));
    expect(resolverBlock).toContain("opts.scope === 'personal' && opts.mode !== 'inherit'");
    expect(resolverBlock).toContain('getSecretForProjectBinding(opts.secretName, opts.ownerUserId)');
    expect(resolverBlock).toContain('getSecret(opts.secretName, opts.userId)');

    const resolverNames = [
      'resolveRuntimeBoxCredentialFileMaterialization',
      'resolveProjectApiKeySecretValue',
      'resolveProjectCredentialSecretValue',
      'resolveRuntimeBoxApiKeyEnv',
    ];
    for (const name of resolverNames) {
      const start = service.indexOf(`export async function ${name}`);
      expect(start, `${name} exists`).toBeGreaterThanOrEqual(0);
      const end = service.indexOf('\nexport ', start + 1);
      const block = service.slice(start, end === -1 ? service.length : end);
      expect(block, `${name} selects owner_user_id`).toContain('c.owner_user_id');
      expect(block, `${name} passes owner_user_id only to the secret locator`).toContain('ownerUserId: row.owner_user_id');
      expect(block, `${name} keeps the Agent binding predicate`).toContain("allowedProjectCredentialWhere('c', 'p', 'd', 'prj')");
    }
  });

  it('resolves credentials for every command after Agent membership authorization', () => {
    const exec = runtime.slice(runtime.indexOf('async function execInBoxWithActivityLock'));
    expect(exec).toContain('await resolveRuntimeBoxApiKeyEnv({');
    expect(exec).toContain('projectId: runningBox.project_id');
    expect(exec).toContain('userId: req.userId');
  });
});

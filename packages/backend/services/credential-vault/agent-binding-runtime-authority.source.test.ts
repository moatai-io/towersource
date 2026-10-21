import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const service = fs.readFileSync(path.join(import.meta.dirname, 'credential-vault-service.ts'), 'utf8');

describe('simplified Credential Runtime authority contract', () => {
  it('uses one scope predicate across env, file, and direct secret resolvers', () => {
    expect(service).toContain("${alias}.scope = 'workspace'");
    expect(service).toContain("${alias}.scope = 'project'");
    expect(service).toContain("project_id");
    expect(service.match(/allowedProjectCredentialWhere\(/g)?.length).toBeGreaterThanOrEqual(5);
  });

  it('does not use retired policy tables or defaults for Runtime authority', () => {
    const predicate = service.slice(service.indexOf('export function allowedProjectCredentialWhere'), service.indexOf('export async function auditCredentialEvent'));
    expect(predicate).not.toMatch(/internal-default|project_credential_policies|workspace_connection_defaults|profile|mode/);
  });

  it('removes the retired Credential Profile compatibility surface', () => {
    expect(service).not.toContain('resolveRuntimeBoxCredentialProfileEnv');
    expect(service).not.toContain('RuntimeBoxCredentialProfileEnvResolution');
  });
});

import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const service = fs.readFileSync(path.join(process.cwd(), 'packages/backend/services/credential-vault/credential-vault-service.ts'), 'utf8');
const api = fs.readFileSync(path.join(process.cwd(), 'packages/backend/routes/credential-vault-api.ts'), 'utf8');
const gate = fs.readFileSync(path.join(process.cwd(), 'packages/backend/services/authority/execution-gate.ts'), 'utf8');

describe('trusted internal Agent Credential access', () => {
  it('reveals only Credentials available to the current Agent and audits the reveal', () => {
    expect(service).toContain('export async function revealCredentialValue');
    expect(service).toContain("eventType: 'credential_revealed'");
    expect(service).toContain("allowedProjectCredentialWhere('c', '$2')");
    expect(api).toContain('/credentials/:credentialId/reveal');
    expect(api).toContain("'Cache-Control', 'no-store, private'");
  });

  it('copies an accessible source Agent Credential into an independent target record', () => {
    expect(service).toContain('export async function copyProjectCredential');
    expect(service).toContain("eventType: 'credential_imported'");
    expect(service).toContain('imported_from_project_id');
    expect(api).toContain('/credentials/import-candidates');
    expect(api).toContain('/credentials/import');
    expect(api).toContain('assertProjectConnectionManager(req, sourceProjectId)');
    expect(api).toContain('assertProjectConnectionManager(req, targetProjectId)');
  });

  it('denies secret reveal for restricted/deployed Runtime profiles', () => {
    expect(gate).toContain("trustLevel === 'restricted'");
    expect(gate).toContain('Restricted or deployed Agents cannot reveal secret values');
    expect(gate).toContain("policy.secretValueVisibility ?? 'project_members'");
  });
});

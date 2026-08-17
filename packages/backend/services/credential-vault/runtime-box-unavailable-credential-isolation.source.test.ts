import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const service = readFileSync(new URL('./credential-vault-service.ts', import.meta.url), 'utf8');

function functionBody(name: string, nextMarker: string): string {
  const start = service.indexOf(`export async function ${name}`);
  const end = service.indexOf(nextMarker, start);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  return service.slice(start, end);
}

describe('Runtime Box unavailable Credential isolation contract', () => {
  it('skips an unavailable file Credential while preserving denied audit evidence', () => {
    const body = functionBody(
      'resolveRuntimeBoxCredentialFileMaterialization',
      '/**\n * Resolve one project-granted API-key credential',
    );

    expect(body).toContain("targetType: 'runtime_box_file'");
    expect(body).toContain("status: 'denied'");
    expect(body).toContain('skipped.push({');
    expect(body).toContain('credentialId: row.credential_id');
    expect(body).toContain('envName: classified.envName');
    expect(body).toContain('skipped without blocking unrelated Runtime Box credentials');
    expect(body).not.toContain("throw new Error(`credential '${row.credential_id}' is allowed for project but unavailable");
  });

  it('skips an unavailable API-key Credential and continues resolving later credentials', () => {
    const body = functionBody(
      'resolveRuntimeBoxApiKeyEnv',
      '/**\n * Resolve project-allowed credential profiles',
    );

    expect(body).toContain("targetType: 'runtime_box_env'");
    expect(body).toContain("status: 'denied'");
    expect(body).toContain('skipped.push({');
    expect(body).toContain('envName,');
    expect(body).toContain('const merged = mergeRuntimeBoxApiKeyEnv');
    expect(body).toContain('skipped: [...merged.skipped, ...skipped]');
    expect(body).not.toContain("throw new Error(`credential '${row.credential_id}' is allowed for project but unavailable");
  });

  it('keeps explicitly selected single-Credential resolution fail-closed', () => {
    const apiKeyBody = functionBody(
      'resolveProjectApiKeySecretValue',
      '/**\n * Resolve one project-granted credential secret value',
    );
    const directBody = functionBody(
      'resolveProjectCredentialSecretValue',
      '/** List credential metadata',
    );

    expect(apiKeyBody).toContain("throw new Error(`credential '${row.credential_id}' is allowed for project but unavailable to user ${opts.userId}`)");
    expect(directBody).toContain("throw new Error(`credential '${row.credential_id}' is allowed for project but unavailable to user ${opts.userId}`)");
  });
});

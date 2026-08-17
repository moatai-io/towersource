import { randomBytes } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const runFile = promisify(execFile);
const run = process.env.CREDENTIAL_VAULT_E2E === '1' ? describe : describe.skip;
async function docker(...args: string[]) {
  return runFile('docker', args, { maxBuffer: 2_000_000 });
}

run('Agent Credential disposable PostgreSQL vertical slice', () => {
  const suffix = randomBytes(5).toString('hex');
  const pgName = `tower-credential-pg-${suffix}`;
  const projectId = `credential-project-${suffix}`;
  const credentialId = `neon-e2e-${suffix}`;
  const secretName = `NEON_E2E_${suffix.toUpperCase()}`;
  const envName = `NEON_E2E_API_KEY_${suffix.toUpperCase()}`;
  const creatorUserId = 181;
  const runtimeUserId = 182;
  const firstSecret = `first-${suffix}-secret`;
  const rotatedSecret = `rotated-${suffix}-secret`;
  let projectRoot = '';
  let previousEnv: Record<string, string | undefined> = {};
  let modules: any;

  beforeAll(async () => {
    for (const key of ['DATABASE_URL', 'SECRET_STORE_MASTER_KEY', 'WORKSPACE_ROOT']) {
      previousEnv[key] = process.env[key];
    }
    projectRoot = await mkdtemp(path.join(os.tmpdir(), 'tower-credential-e2e-'));
    await docker(
      'run', '-d', '--rm', '--name', pgName,
      '-e', 'POSTGRES_PASSWORD=test', '-e', 'POSTGRES_DB=tower_test',
      '-p', '127.0.0.1::5432', 'postgres:16-alpine',
    );
    const mapped = await docker('port', pgName, '5432/tcp');
    const port = Number(mapped.stdout.trim().match(/:(\d+)$/)?.[1]);
    if (!Number.isInteger(port) || port <= 0) throw new Error(`Invalid mapped PostgreSQL port: ${mapped.stdout}`);
    const databaseUrl = `postgresql://postgres:test@127.0.0.1:${port}/tower_test`;
    for (let attempt = 0; attempt < 40; attempt += 1) {
      try {
        await runFile('psql', [databaseUrl, '-v', 'ON_ERROR_STOP=1', '-c', 'SELECT 1']);
        break;
      } catch {
        if (attempt === 39) throw new Error('Disposable PostgreSQL did not become ready');
        await new Promise(resolve => setTimeout(resolve, 250));
      }
    }

    process.env.DATABASE_URL = databaseUrl;
    process.env.SECRET_STORE_MASTER_KEY = randomBytes(32).toString('hex');
    process.env.WORKSPACE_ROOT = path.dirname(projectRoot);

    const migrationRoot = path.resolve(process.cwd(), 'packages/backend/db/migrations');
    for (const file of [
      '007_users.sql',
      '009_projects.sql',
      '017_spaces.sql',
      '043_sandbox_runs.sql',
      '044_internal_tools_secrets.sql',
      '081_workspace_credential_vault.sql',
      '092_workspace_connection_defaults.sql',
      '101_personal_credential_vault_scope.sql',
    ]) {
      await runFile('psql', [databaseUrl, '-v', 'ON_ERROR_STOP=1', '-f', path.join(migrationRoot, file)]);
    }

    modules = {
      db: await import('../../db/pg-repo.js'),
      pg: await import('../../db/pg.js'),
      vault: await import('./credential-vault-service.js'),
      reliability: await import('./connection-reliability.js'),
    };
    await modules.db.execute(
      `INSERT INTO users(id,username,password_hash,role) VALUES
         ($1,$2,'x','admin'), ($3,$4,'x','member')`,
      [creatorUserId, `credential-admin-${suffix}`, runtimeUserId, `credential-member-${suffix}`],
    );
    await modules.db.execute(
      `INSERT INTO projects(id,name,root_path,user_id) VALUES($1,$2,$3,$4)`,
      [projectId, `Credential E2E ${suffix}`, projectRoot, creatorUserId],
    );
    await modules.db.execute(
      `INSERT INTO project_members(project_id,user_id,role) VALUES($1,$2,'member')`,
      [projectId, runtimeUserId],
    );
  }, 120_000);

  afterAll(async () => {
    await modules?.pg?.closePgPool?.().catch(() => undefined);
    await docker('rm', '-f', pgName).catch(() => undefined);
    if (projectRoot) await rm(projectRoot, { recursive: true, force: true });
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }, 120_000);

  it('stores, binds, materializes, diagnoses, rotates, and denies without leaking values', async () => {
    await modules.vault.upsertApiKeyCredential({
      id: credentialId,
      provider: 'neon',
      displayName: 'Neon E2E',
      secretName,
      secretValue: firstSecret,
      defaultEnvName: envName,
      scope: 'project',
      metadata: {
        connection_type: 'agent',
        agent_project_id: projectId,
        capability: 'database',
      },
      actorUserId: creatorUserId,
    });
    await modules.vault.setProjectCredentialPolicy({
      projectId,
      credentialId,
      mode: 'allow',
      targetEnvName: envName,
      actorUserId: creatorUserId,
    });

    const firstRuntime = await modules.vault.resolveRuntimeBoxApiKeyEnv({
      projectId,
      userId: runtimeUserId,
    });
    expect(firstRuntime.injected).toContainEqual({ credentialId, envName });
    expect(firstRuntime.env[envName]).toBe(firstSecret);

    const status = await modules.reliability.diagnoseProjectConnectionStatus({
      projectId,
      userId: runtimeUserId,
    });
    expect(status).toMatchObject({ inventoryComplete: true, coverage: 'known-and-agent-bound' });
    expect(status.connections.find((item: any) => item.connectionId === credentialId)).toMatchObject({
      status: 'unverified',
      stoppedAt: 'provider_health',
      reasonCode: 'ProviderAuthUnverified',
      nextAction: 'test',
      stages: [
        { stage: 'inventory', status: 'pass' },
        { stage: 'project_access', status: 'pass' },
        { stage: 'materialization', status: 'pass' },
        { stage: 'provider_health', status: 'unknown' },
      ],
    });
    expect(JSON.stringify(status)).not.toContain(firstSecret);
    expect(JSON.stringify(status)).not.toContain(envName);

    const callerValue = `caller-owned-${suffix}`;
    const callerWins = await modules.vault.resolveRuntimeBoxApiKeyEnv({
      projectId,
      userId: runtimeUserId,
      existingEnv: { [envName]: callerValue },
    });
    expect(callerWins.env[envName]).toBe(callerValue);
    expect(callerWins.injected).not.toContainEqual({ credentialId, envName });

    await modules.vault.rotateExistingCredential({
      credentialId,
      secretValue: rotatedSecret,
      actorUserId: creatorUserId,
    });
    const afterRotate = await modules.vault.resolveRuntimeBoxApiKeyEnv({ projectId, userId: runtimeUserId });
    expect(afterRotate.env[envName]).toBe(rotatedSecret);
    expect(afterRotate.env[envName]).not.toBe(firstSecret);

    await modules.vault.setProjectCredentialPolicy({
      projectId,
      credentialId,
      mode: 'deny',
      targetEnvName: envName,
      actorUserId: creatorUserId,
    });
    const denied = await modules.vault.resolveRuntimeBoxApiKeyEnv({ projectId, userId: runtimeUserId });
    expect(denied.injected.find((item: any) => item.credentialId === credentialId)).toBeUndefined();
    expect(denied.env[envName]).toBeUndefined();

    const auditRows = await modules.db.query(
      `SELECT event_type,status,error_code,message,target_ref
         FROM credential_audit_events
        WHERE credential_id = $1
        ORDER BY id`,
      [credentialId],
    );
    expect(auditRows.some((row: any) => row.event_type === 'materialize' && row.status === 'ok')).toBe(true);
    expect(auditRows.some((row: any) => row.event_type === 'credential_rotated')).toBe(true);
    expect(auditRows.some((row: any) => row.event_type === 'project_policy_deny' && row.status === 'denied')).toBe(true);
    const serializedAudit = JSON.stringify(auditRows);
    expect(serializedAudit).not.toContain(firstSecret);
    expect(serializedAudit).not.toContain(rotatedSecret);
    expect(serializedAudit).not.toContain(callerValue);
  }, 120_000);
});
